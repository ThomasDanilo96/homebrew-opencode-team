#!/usr/bin/env python3
import os
import json
import hashlib
import re
import shutil
import sqlite3
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

RETENTION_DAYS = int(os.getenv("OPENCODE_RETENTION_DAYS", "7"))
LOG_RETENTION_DAYS = int(os.getenv("OPENCODE_LOG_RETENTION_DAYS", "7"))
SNAPSHOT_RETENTION_DAYS = int(os.getenv("OPENCODE_SNAPSHOT_RETENTION_DAYS", "7"))
STORAGE_RETENTION_DAYS = int(os.getenv("OPENCODE_STORAGE_RETENTION_DAYS", "7"))
SNAPSHOT_THIN_BYTES = int(os.getenv("OPENCODE_SNAPSHOT_THIN_BYTES", str(20 * 1000 * 1000 * 1000)))
DRY_RUN = "--dry-run" in sys.argv
RETENTION_ONLY = "--retention-only" in sys.argv
LIVE_RETENTION = "--live-retention" in sys.argv
SKIP_UPDATE = "--skip-update" in sys.argv
SKIP_DISK_CLEANUP = "--skip-disk-cleanup" in sys.argv
ALLOWED_TEAMS = {'openai', 'best'}


def option_value(name: str) -> str | None:
    for index, argument in enumerate(sys.argv[:-1]):
        if argument == name:
            return sys.argv[index + 1]
    return None


TEAM_FILTER = option_value('--team')
MAX_FAMILIES = option_value('--max-families')
MAX_SESSION_DELETES = option_value('--max-session-deletes')


def validate_cli() -> tuple[bool, str]:
    if '--team' in sys.argv and (TEAM_FILTER is None or TEAM_FILTER not in ALLOWED_TEAMS):
        return False, 'unknown or missing team'
    if not LIVE_RETENTION:
        return True, ''
    if not RETENTION_ONLY:
        return False, '--live-retention requires --retention-only'
    if TEAM_FILTER not in ALLOWED_TEAMS:
        return False, 'live retention requires an allowed --team'
    try:
        family_limit = int(MAX_FAMILIES or '')
        session_limit = int(MAX_SESSION_DELETES or '')
    except ValueError:
        return False, 'live retention requires numeric --max-families and --max-session-deletes'
    if not 1 <= family_limit <= 10:
        return False, '--max-families must be between 1 and 10'
    if not 1 <= session_limit <= 30:
        return False, '--max-session-deletes must be between 1 and 30'
    return True, ''
HOME = Path.home()
BASE = Path(os.getenv('OPENCODE_MAINTENANCE_BASE', HOME / '.local' / 'share' / 'opencode'))
_sandbox_root = os.getenv('OPENCODE_MAINTENANCE_SANDBOXES')
STAGING_SANDBOXES = Path(_sandbox_root) if _sandbox_root else Path('/__opencode_team_no_sandbox_root__')
LOG_FILE = Path(os.getenv('OPENCODE_MAINTENANCE_LOG_FILE', HOME / '.local' / 'share' / 'opencode-cleanup.log'))
UPDATE_SCRIPT = Path(os.getenv('OPENCODE_MAINTENANCE_UPDATE_SCRIPT', HOME / 'Scripts' / 'opencode-update.sh'))


def log(msg: str) -> None:
    if LOG_FILE.exists() and LOG_FILE.stat().st_size > 10 * 1024 * 1024:
        rotated = LOG_FILE.with_name(LOG_FILE.name + '.1')
        rotated.unlink(missing_ok=True)
        LOG_FILE.replace(rotated)
    line = f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line)
    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    with LOG_FILE.open('a', encoding='utf-8') as fh:
        fh.write(line + '\n')


def run(cmd: list[str], check: bool = True, capture: bool = True) -> str:
    result = subprocess.run(cmd, check=check, text=True, capture_output=capture)
    return (result.stdout or '').strip()


def retention_record(team: str, session_id: str, age_days: float, parent_id: str | None,
                     decision: str, reason_code: str, family_index: int | None = None) -> None:
    """Emit only privacy-safe retention fields."""
    family = f' family_index={family_index}' if family_index is not None else ''
    line = (
        f'team={team}{family} session_id={session_id} age_days={age_days:.2f} '
        f'parent_id={parent_id or "-"} decision={decision} reason_code={reason_code}'
    )
    print(line)
    if not RETENTION_ONLY:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open('a', encoding='utf-8') as fh:
            fh.write(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {line}\n')


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding='utf-8').strip()
    except (FileNotFoundError, OSError):
        return ''


def read_identity(path: Path) -> dict[str, str]:
    values = {}
    for line in read_text(path).splitlines():
        if '=' in line:
            key, value = line.split('=', 1)
            values[key] = value
    return values


def api_request(base_url: str, path: str, method: str = 'GET', body=None):
    data = None if body is None else json.dumps(body).encode('utf-8')
    request = Request(
        f'{base_url}{path}',
        data=data,
        method=method,
        headers={'Accept': 'application/json', 'Content-Type': 'application/json'},
    )
    with urlopen(request, timeout=5) as response:
        payload = response.read()
        if not payload:
            return None
        return json.loads(payload.decode('utf-8'))


def api_health(base_url: str) -> bool:
    try:
        api_request(base_url, '/global/health')
        request = Request(f'{base_url}/', method='GET')
        with urlopen(request, timeout=5) as response:
            response.read(1)
        return True
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
        return False


def process_matches_identity(pid: int, port: int, identity: dict[str, str]) -> bool:
    if identity.get('role') != 'server' or identity.get('pid') != str(pid):
        return False
    if identity.get('pgid'):
        try:
            pgid = run(['ps', '-p', str(pid), '-o', 'pgid=']).strip()
        except (subprocess.CalledProcessError, OSError):
            return False
        if pgid != identity['pgid']:
            return False
    env = os.environ.copy()
    env['LC_ALL'] = 'C'
    command_result = subprocess.run(
        ['ps', '-p', str(pid), '-o', 'command='],
        text=True,
        capture_output=True,
        check=False,
        env=env,
    )
    command = command_result.stdout.strip()
    expected = re.compile(
        rf'^(?:[^ ]*/)?opencode serve --port {port} --hostname 127\.0\.0\.1(?:\s|$)'
    )
    if command_result.returncode != 0 or not expected.search(command):
        return False
    if identity.get('start_epoch'):
        start_result = subprocess.run(
            ['ps', '-p', str(pid), '-o', 'lstart='],
            text=True,
            capture_output=True,
            check=False,
            env=env,
        )
        try:
            process_start = datetime.strptime(
                start_result.stdout.strip(), '%a %b %d %H:%M:%S %Y'
            ).timestamp()
            if abs(process_start - float(identity['start_epoch'])) > 5:
                return False
        except (ValueError, TypeError, OSError):
            return False
    return True


def process_has_path(pid: int, path: Path) -> bool:
    result = subprocess.run(
        ['/usr/sbin/lsof', '-nP', '-p', str(pid)],
        text=True,
        capture_output=True,
        check=False,
    )
    return str(path) in result.stdout


def active_servers(safety_root: Path, db: Path) -> tuple[list[dict], bool]:
    """Return verified servers and whether any live runtime was ambiguous."""
    runs_root = safety_root / 'state' / 'runs'
    servers = []
    uncertain = False
    state_pids = set()
    if not runs_root.is_dir():
        return servers, uncertain
    for run_dir in sorted(runs_root.iterdir()):
        if not run_dir.is_dir():
            continue
        try:
            pid = int(read_text(run_dir / 'server.pid'))
            port = int(read_text(run_dir / 'port'))
        except ValueError:
            continue
        state_pids.add(pid)
        identity = read_identity(run_dir / 'server.identity')
        if subprocess.run(['kill', '-0', str(pid)], check=False, stderr=subprocess.DEVNULL).returncode != 0:
            continue
        if not process_matches_identity(pid, port, identity) or not process_has_path(pid, db):
            uncertain = True
            continue
        base_url = f'http://127.0.0.1:{port}'
        if not api_health(base_url):
            uncertain = True
            continue
        parent_id = read_text(run_dir / 'parent_session_id')
        resume_id = read_text(run_dir / 'resume_claim')
        try:
            parent = api_request(base_url, f'/session/{parent_id}') if parent_id else None
            if not parent or parent.get('id') != parent_id:
                uncertain = True
                continue
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError):
            uncertain = True
            continue
        servers.append({
            'base_url': base_url,
            'run_dir': run_dir,
            'parent_id': parent_id,
            'resume_id': resume_id,
        })
    ps_result = subprocess.run(
        ['ps', '-axo', 'pid=,command='], text=True, capture_output=True, check=False
    )
    for line in ps_result.stdout.splitlines():
        match = re.match(r'\s*(\d+)\s+((?:[^ ]*/)?opencode serve --port \d+ --hostname 127\.0\.0\.1(?:\s|$).*)', line)
        if not match:
            continue
        pid = int(match.group(1))
        if pid not in state_pids and process_has_path(pid, db):
            uncertain = True
    return servers, uncertain


def session_lock_ids(safety_root: Path) -> set[str]:
    locks_root = safety_root / 'state' / 'session-locks'
    if not locks_root.is_dir():
        return set()
    return {item.name for item in locks_root.iterdir() if item.is_dir()}


def descendants(session_id: str, children: dict[str, list[str]]) -> set[str]:
    result = set()
    pending = list(children.get(session_id, []))
    while pending:
        child = pending.pop()
        if child in result:
            continue
        result.add(child)
        pending.extend(children.get(child, []))
    return result


def ancestors(session_id: str, parents: dict[str, str | None]) -> set[str]:
    result = set()
    current = parents.get(session_id)
    while current and current not in result:
        result.add(current)
        current = parents.get(current)
    return result


def session_catalog_signature(sessions: list[dict]) -> tuple[int, str, int | None, int | None]:
    ids = sorted(item.get('id') for item in sessions if isinstance(item, dict) and item.get('id'))
    updated = [
        item.get('time', {}).get('updated')
        for item in sessions
        if isinstance(item, dict) and isinstance(item.get('time', {}).get('updated'), (int, float))
    ]
    digest = hashlib.sha256('\n'.join(ids).encode('utf-8')).hexdigest()
    return len(ids), digest, min(updated) if updated else None, max(updated) if updated else None


def session_directories(db: Path) -> list[str]:
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        rows = conn.execute(
            """
            SELECT DISTINCT directory
            FROM session
            WHERE directory IS NOT NULL AND directory != ''
            ORDER BY directory
            """
        ).fetchall()
        directories = [row[0] for row in rows if isinstance(row[0], str) and row[0]]
        if not directories:
            raise ValueError('empty session directory catalog')
        return directories
    finally:
        conn.close()


def api_session_snapshot(server: dict, servers: list[dict], db: Path) -> tuple[list[dict], set[str]]:
    directories = session_directories(db)
    catalogs = []
    status_ids = set()
    canonical_records = {}
    for current in servers:
        merged = {}
        for directory in directories:
            query = urlencode({'limit': 100000, 'directory': directory})
            sessions = api_request(current['base_url'], f'/session?{query}')
            status_query = urlencode({'directory': directory})
            statuses = api_request(current['base_url'], f'/session/status?{status_query}')
            if not isinstance(sessions, list) or not isinstance(statuses, dict):
                raise ValueError('invalid session API response')
            for item in sessions:
                if not isinstance(item, dict) or not item.get('id'):
                    raise ValueError('malformed session API response')
                session_id = item['id']
                if session_id in merged and merged[session_id] != item:
                    raise ValueError('conflicting session metadata')
                merged[session_id] = item
            status_ids.update(statuses)
        catalog = list(merged.values())
        for item in catalog:
            session_id = item['id']
            if session_id in canonical_records and canonical_records[session_id] != item:
                raise ValueError('conflicting session metadata')
            canonical_records[session_id] = item
        catalogs.append((catalog, session_catalog_signature(catalog)))
    if not catalogs or len({signature for _, signature in catalogs}) != 1:
        raise ValueError('inconsistent session catalog')
    return catalogs[0][0], status_ids


def api_retention(base: Path, safety_root: Path, label: str, server: dict, servers: list[dict], live: bool = False) -> dict[str, int]:
    team = safety_root.name
    try:
        sessions, status_ids = api_session_snapshot(server, servers, base / 'opencode.db')
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as exc:
        if RETENTION_ONLY:
            retention_record(team, '-', 0.0, None, 'SKIP', 'API_ERROR')
        else:
            log(f'{label}: API_ERROR session listing skipped: {type(exc).__name__}')
        return {'errors': 1}

    now_ms = int(time.time() * 1000)
    cutoff_ms = now_ms - (RETENTION_DAYS * 86400 * 1000)
    by_id = {item.get('id'): item for item in sessions if isinstance(item, dict) and item.get('id')}
    parents = {sid: item.get('parentID') for sid, item in by_id.items()}
    children: dict[str, list[str]] = {}
    for sid, parent_id in parents.items():
        if parent_id:
            children.setdefault(parent_id, []).append(sid)

    lock_ids = session_lock_ids(safety_root)
    resume_ids = set()
    active_ids = set(status_ids)
    runs_root = safety_root / 'state' / 'runs'
    for run_dir in sorted(runs_root.iterdir()) if runs_root.is_dir() else []:
        if not run_dir.is_dir():
            continue
        for filename in ('parent_session_id', 'resume_claim'):
            value = read_text(run_dir / filename)
            if value:
                resume_ids.add(value)
                active_ids.add(value)

    active_family = set(active_ids)
    for sid in list(active_ids):
        active_family.update(descendants(sid, children))
        active_family.update(ancestors(sid, parents))
    locked_family = set(lock_ids)
    for sid in list(lock_ids):
        locked_family.update(descendants(sid, children))
        locked_family.update(ancestors(sid, parents))

    decisions: dict[str, tuple[str, str]] = {}
    ages: dict[str, float] = {}
    for sid, item in by_id.items():
        updated = item.get('time', {}).get('updated') if isinstance(item.get('time'), dict) else None
        if not isinstance(updated, (int, float)):
            decisions[sid] = ('SKIP', 'API_ERROR')
            ages[sid] = 0.0
            continue
        age_days = max(0.0, (now_ms - updated) / 86400000)
        ages[sid] = age_days
        if sid in status_ids:
            decisions[sid] = ('SKIP', 'ACTIVE_SESSION')
        elif sid in resume_ids:
            decisions[sid] = ('SKIP', 'RESUME_PROTECTED')
        elif sid in lock_ids:
            decisions[sid] = ('SKIP', 'SESSION_LOCKED')
        elif sid in active_family or sid in locked_family:
            decisions[sid] = ('SKIP', 'ACTIVE_CHILD')
        elif updated >= cutoff_ms:
            decisions[sid] = ('SKIP', 'TOO_RECENT')
        elif item.get('parentID') and item.get('parentID') not in by_id:
            decisions[sid] = ('SKIP', 'API_ERROR')
        else:
            decisions[sid] = ('DELETE', 'DELETE_CANDIDATE')

    # Never delete a parent while an unknown, recent, locked, or active child remains.
    changed = True
    while changed:
        changed = False
        for sid, (decision, reason) in list(decisions.items()):
            if decision != 'DELETE':
                continue
            child_reasons = [decisions[child][1] for child in children.get(sid, []) if child in decisions]
            blocked = [value for value in child_reasons if value != 'DELETE_CANDIDATE']
            if blocked:
                decisions[sid] = ('SKIP', blocked[0])
                changed = True

    def family_root(sid: str) -> str:
        root = sid
        seen = set()
        while parents.get(root) in by_id and parents[root] not in seen:
            seen.add(root)
            root = parents[root]
        return root

    family_members: dict[str, set[str]] = {}
    for sid in by_id:
        family_members.setdefault(family_root(sid), set()).add(sid)
    for members in family_members.values():
        blocked = [decisions[sid][1] for sid in members if decisions[sid][0] != 'DELETE']
        if blocked:
            reason = next(
                (item for item in blocked if item in ('ACTIVE_SESSION', 'ACTIVE_CHILD', 'RESUME_PROTECTED', 'SESSION_LOCKED')),
                blocked[0],
            )
            for sid in members:
                if decisions[sid][0] == 'DELETE':
                    decisions[sid] = ('SKIP', reason)

    effective_dry_run = DRY_RUN or not live
    if effective_dry_run:
        for sid, item in by_id.items():
            decision, reason = decisions[sid]
            retention_record(team, sid, ages[sid], item.get('parentID'), decision, reason)
        return {
            'candidate': sum(decision == 'DELETE' for decision, _ in decisions.values()),
            'active': sum(reason in ('ACTIVE_SESSION', 'ACTIVE_CHILD') for _, reason in decisions.values()),
            'resume': sum(reason == 'RESUME_PROTECTED' for _, reason in decisions.values()),
            'locked': sum(reason == 'SESSION_LOCKED' for _, reason in decisions.values()),
            'recent': sum(reason == 'TOO_RECENT' for _, reason in decisions.values()),
            'errors': sum(reason == 'API_ERROR' for _, reason in decisions.values()),
        }

    eligible_families = [
        (root, members)
        for root, members in family_members.items()
        if all(decisions[sid][0] == 'DELETE' for sid in members)
    ]
    eligible_families.sort(key=lambda item: max(ages[sid] for sid in item[1]), reverse=True)
    selected_ids = set()
    family_indexes = {}
    selected_session_count = 0
    for family_index, (_root, members) in enumerate(eligible_families, 1):
        if family_index > int(MAX_FAMILIES):
            break
        if selected_session_count + len(members) > int(MAX_SESSION_DELETES):
            break
        selected_session_count += len(members)
        selected_ids.update(members)
        for sid in members:
            family_indexes[sid] = family_index

    depth_cache: dict[str, int] = {}

    def depth(sid: str) -> int:
        if sid in depth_cache:
            return depth_cache[sid]
        parent_id = parents.get(sid)
        depth_cache[sid] = 0 if not parent_id else depth(parent_id) + 1
        return depth_cache[sid]

    deleted = set()
    failed_families = set()
    canary_failed = False
    ordered = sorted(
        (sid for sid in selected_ids if decisions[sid][0] == 'DELETE'),
        key=depth,
        reverse=True,
    )
    for sid in ordered:
        root = sid
        while parents.get(root) in decisions and parents.get(root) in {*ordered, *deleted}:
            root = parents[root]
        if root in failed_families or canary_failed:
            continue
        try:
            fresh = api_request(server['base_url'], f'/session/{sid}')
            if not fresh or fresh.get('time', {}).get('updated') != by_id[sid].get('time', {}).get('updated'):
                retention_record(team, sid, ages[sid], parents.get(sid), 'SKIP', 'STATE_CHANGED', family_indexes[sid])
                failed_families.add(root)
                continue
            _, fresh_status_ids = api_session_snapshot(server, servers, base / 'opencode.db')
            current_resume_ids = {
                value
                for run in servers
                for filename in ('parent_session_id', 'resume_claim')
                for value in [read_text(run['run_dir'] / filename)]
                if value
            }
            current_locks = session_lock_ids(safety_root)
            current_protected = fresh_status_ids | current_resume_ids | current_locks
            if (
                sid in current_protected
                or descendants(sid, children).intersection(current_protected)
                or ancestors(sid, parents).intersection(current_protected)
            ):
                retention_record(team, sid, ages[sid], parents.get(sid), 'SKIP', 'STATE_CHANGED', family_indexes[sid])
                failed_families.add(root)
                continue
            api_request(server['base_url'], f'/session/{sid}', method='DELETE')
            deleted.add(sid)
            retention_record(team, sid, ages[sid], parents.get(sid), 'DELETE', 'DELETE_CANDIDATE', family_indexes[sid])
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError, sqlite3.Error) as exc:
            retention_record(team, sid, ages[sid], parents.get(sid), 'SKIP', 'API_ERROR', family_indexes[sid])
            failed_families.add(root)
            canary_failed = True
            if not RETENTION_ONLY:
                log(f'{label}: API_ERROR canary stopped: {type(exc).__name__}')
    return {'deleted': len(deleted), 'errors': len(failed_families)}


def path_in_use(root: Path, db: Path, wal: Path) -> bool:
    """Return true if any process has a file in this OpenCode root open."""
    result = subprocess.run(
        ['/usr/sbin/lsof', '+D', str(root)],
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode == 0 and len(result.stdout.splitlines()) > 1:
        return True
    for target in (db, wal):
        if target.exists():
            result = subprocess.run(
                ['/usr/sbin/lsof', str(target)],
                text=True,
                capture_output=True,
                check=False,
            )
            if result.returncode == 0 and len(result.stdout.splitlines()) > 1:
                return True
    return False


def candidate_sessions(db: Path) -> list[str]:
    return [session_id for session_id, _ in candidate_session_records(db)]


def candidate_session_records(db: Path) -> list[tuple[str, int]]:
    cutoff_ms = int((time.time() - (RETENTION_DAYS * 86400)) * 1000)
    conn = sqlite3.connect(f'file:{db}?mode=ro', uri=True)
    try:
        query = """
        SELECT id, time_updated
        FROM session
        WHERE time_updated < ?
        ORDER BY time_updated ASC
        """
        rows = conn.execute(query, (cutoff_ms,)).fetchall()
        return [(row[0], row[1]) for row in rows]
    finally:
        conn.close()


def delete_sessions(db: Path, ids: list[str]) -> None:
    if not ids:
        log('No old sessions to delete.')
        return
    log(f'Session candidates: {len(ids)}')
    if DRY_RUN:
        for session_id in ids:
            log(f'[dry-run] would delete session {session_id}')
        return

    conn = sqlite3.connect(db)
    try:
        conn.execute('PRAGMA foreign_keys = ON')
        batch_size = 200
        deleted = 0
        for start in range(0, len(ids), batch_size):
            batch = ids[start:start + batch_size]
            placeholders = ','.join('?' for _ in batch)
            conn.execute('BEGIN')
            conn.execute(f'DELETE FROM session WHERE id IN ({placeholders})', batch)
            conn.commit()
            deleted += len(batch)
            log(f'deleted {deleted}/{len(ids)} sessions')
    finally:
        conn.close()


def prune_orphan_events(db: Path) -> None:
    """Remove event history for deleted sessions, never for live sessions."""
    query = """
    SELECT count(*)
    FROM event e
    WHERE e.aggregate_id IN (
        SELECT es.aggregate_id
        FROM event_sequence es
        WHERE NOT EXISTS (
            SELECT 1 FROM session s WHERE s.id = es.aggregate_id
        )
        AND EXISTS (
            SELECT 1 FROM event created
            WHERE created.aggregate_id = es.aggregate_id
              AND created.type = 'session.created.1'
        )
    )
    """
    conn = sqlite3.connect(db)
    try:
        orphan_events = conn.execute(query).fetchone()[0]
        if not orphan_events:
            log('No orphan session events to delete.')
            return
        if DRY_RUN:
            log(f'[dry-run] would delete {orphan_events} orphan session events')
            return
        conn.execute('PRAGMA foreign_keys = ON')
        conn.execute('BEGIN IMMEDIATE')
        conn.execute(
            """
            DELETE FROM event
            WHERE aggregate_id IN (
                SELECT es.aggregate_id
                FROM event_sequence es
                WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = es.aggregate_id)
                  AND EXISTS (
                      SELECT 1 FROM event created
                      WHERE created.aggregate_id = es.aggregate_id
                        AND created.type = 'session.created.1'
                  )
            )
            """
        )
        conn.execute(
            """
            DELETE FROM event_sequence
            WHERE NOT EXISTS (SELECT 1 FROM session s WHERE s.id = event_sequence.aggregate_id)
              AND NOT EXISTS (
                  SELECT 1 FROM event remaining
                  WHERE remaining.aggregate_id = event_sequence.aggregate_id
              )
            """
        )
        conn.commit()
        log(f'Deleted {orphan_events} orphan session events')
    finally:
        conn.close()


def prune_path(path: Path, days: int, label: str) -> None:
    if not path.exists():
        return
    cutoff = time.time() - (days * 86400)
    removed = 0
    top_level = sorted(path.iterdir(), key=lambda p: p.stat().st_mtime)
    for item in top_level:
        try:
            mtime = item.stat().st_mtime
        except FileNotFoundError:
            continue
        if mtime >= cutoff:
            continue
        if DRY_RUN:
            log(f'[dry-run] would remove {label} {item}')
            removed += 1
            continue
        try:
            if item.is_dir():
                shutil.rmtree(item)
            else:
                item.unlink(missing_ok=True)
        except OSError as exc:
            log(f'{label}: ERROR removing {item}: {exc}')
            continue
        removed += 1
    log(f'{label}: removed {removed} old entries')


def vacuum_db(db: Path) -> None:
    if DRY_RUN:
        log('[dry-run] would run VACUUM')
        return
    run(['sqlite3', str(db), 'VACUUM;'], check=True, capture=True)
    log('VACUUM completed')


def managed_bases() -> list[tuple[Path, Path, str]]:
    """Return (OpenCode data directory, safety root, label) tuples."""
    bases = [(BASE, BASE, 'default')]
    if STAGING_SANDBOXES.is_dir():
        for sandbox in sorted(STAGING_SANDBOXES.iterdir()):
            base = sandbox / 'data' / 'opencode'
            if base.is_dir():
                bases.append((base, sandbox, f'sandbox:{sandbox.name}'))
    return bases


def cleanup_base(base: Path, safety_root: Path, label: str) -> None:
    db = base / 'opencode.db'
    wal = base / 'opencode.db-wal'
    if not db.exists():
        log(f'{label}: database not found; skipping')
        return

    servers, uncertain = active_servers(safety_root, db)
    if uncertain:
        if RETENTION_ONLY:
            retention_record(safety_root.name, '-', 0.0, None, 'SKIP', 'API_ERROR')
        else:
            log(f'{label}: runtime identity uncertain; skipping')
        return
    if servers:
        if not RETENTION_ONLY:
            log(f'{label}: active OpenCode API servers={len(servers)}; using API retention')
        api_retention(base, safety_root, label, servers[0], servers, live=LIVE_RETENTION)
        return

    if RETENTION_ONLY:
        if path_in_use(safety_root, db, wal) or session_lock_ids(safety_root):
            return
        for session_id, updated in candidate_session_records(db):
            age_days = max(0.0, (time.time() * 1000 - updated) / 86400000)
            retention_record(safety_root.name, session_id, age_days, None, 'DELETE', 'DELETE_CANDIDATE')
        return

    busy = path_in_use(safety_root, db, wal)
    log(f'{label}: cleanup dry_run={DRY_RUN} db_in_use={busy}')
    if busy:
        # Never prune any child of an active root: tool output may belong to
        # an open session even when that individual file is not currently open.
        log(f'{label}: ACTIVE; skipping sessions, tool-output, storage, logs, snapshots, and VACUUM')
        return
    locks = session_lock_ids(safety_root)
    if locks:
        log(f'{label}: session locks present; skipping offline cleanup')
        return

    ids = candidate_sessions(db)
    if path_in_use(safety_root, db, wal):
        log(f'{label}: became active before session cleanup; skipping')
        return
    delete_sessions(db, ids)
    prune_orphan_events(db)
    if path_in_use(safety_root, db, wal):
        log(f'{label}: became active before artifact cleanup; skipping')
        return
    prune_path(base / 'log', LOG_RETENTION_DAYS, f'{label} log')
    prune_path(base / 'snapshot', SNAPSHOT_RETENTION_DAYS, f'{label} snapshot')
    prune_path(base / 'storage', STORAGE_RETENTION_DAYS, f'{label} storage')
    if path_in_use(safety_root, db, wal):
        log(f'{label}: became active during cleanup; skipping VACUUM')
    else:
        vacuum_db(db)


def run_update() -> None:
    if DRY_RUN:
        log(f'[dry-run] would run update script {UPDATE_SCRIPT}')
        return
    if not UPDATE_SCRIPT.exists():
        log(f'Update script not found at {UPDATE_SCRIPT}; skipping update')
        return
    result = subprocess.run([str(UPDATE_SCRIPT)], text=True, capture_output=True)
    log(f'Update script exit code: {result.returncode}')
    stdout = (result.stdout or '').strip()
    stderr = (result.stderr or '').strip()
    if stdout:
        for line in stdout.splitlines():
            log(f'[update stdout] {line}')
    if stderr:
        for line in stderr.splitlines():
            log(f'[update stderr] {line}')


DISK_CLEANUP_SCRIPT = Path(os.getenv('OPENCODE_MAINTENANCE_DISK_CLEANUP_SCRIPT', HOME / '.local' / 'bin' / 'disk-cleanup.sh'))


def run_disk_cleanup() -> None:
    if DRY_RUN:
        log(f'[dry-run] would run disk cleanup {DISK_CLEANUP_SCRIPT}')
        return
    if not DISK_CLEANUP_SCRIPT.exists():
        log(f'Disk cleanup script not found at {DISK_CLEANUP_SCRIPT}; skipping')
        return
    log('Running disk cleanup...')
    result = subprocess.run(
        ['/bin/zsh', str(DISK_CLEANUP_SCRIPT)],
        text=True, capture_output=True
    )
    log(f'Disk cleanup exit code: {result.returncode}')
    stdout = (result.stdout or '').strip()
    stderr = (result.stderr or '').strip()
    if stdout:
        for line in stdout.splitlines():
            log(f'[disk-cleanup] {line}')
    if stderr:
        for line in stderr.splitlines():
            log(f'[disk-cleanup-err] {line}')


def disk_pressure() -> tuple[int, int, int, int]:
    usage = shutil.disk_usage('/System/Volumes/Data')
    percent = int((usage.used * 100) / usage.total)
    return usage.total, usage.used, usage.free, percent


def snapshot_pressure() -> None:
    try:
        output = run(['tmutil', 'listlocalsnapshots', '/System/Volumes/Data'], check=False)
        count = sum(1 for line in output.splitlines() if line.startswith('com.apple.TimeMachine.'))
    except Exception as exc:
        log(f'LOCAL_SNAPSHOT_PRESSURE_CHECK_ERROR={exc}')
        return
    _, _, _, percent = disk_pressure()
    if percent >= 85 and count >= 5:
        log(f'LOCAL_SNAPSHOT_PRESSURE=yes data_used_percent={percent} local_snapshot_count={count}')
        if DRY_RUN:
            log(f'[dry-run] would thin local snapshots target_bytes={SNAPSHOT_THIN_BYTES}')
        else:
            result = subprocess.run(
                ['tmutil', 'thinlocalsnapshots', '/', str(SNAPSHOT_THIN_BYTES), '4'],
                text=True,
                capture_output=True,
                check=False,
            )
            log(f'LOCAL_SNAPSHOT_THIN exit_code={result.returncode}')
            for line in (result.stdout or '').splitlines():
                log(f'[snapshot] {line}')
            for line in (result.stderr or '').splitlines():
                log(f'[snapshot-err] {line}')
    else:
        log(f'LOCAL_SNAPSHOT_PRESSURE=no data_used_percent={percent} local_snapshot_count={count}')


def main() -> int:
    valid, reason = validate_cli()
    if not valid:
        print(f'REFUSE: {reason}')
        return 2
    if RETENTION_ONLY:
        for base, safety_root, label in managed_bases():
            if label == 'default':
                continue
            if TEAM_FILTER and safety_root.name != TEAM_FILTER:
                continue
            cleanup_base(base, safety_root, label)
        return 0
    total, used, free, percent = disk_pressure()
    log(f'DISK_BEFORE total={total} used={used} free={free} used_percent={percent}')
    snapshot_pressure()
    log(f'Start cleanup dry_run={DRY_RUN} retention_days={RETENTION_DAYS}')
    for base, safety_root, label in managed_bases():
        cleanup_base(base, safety_root, label)
    if SKIP_UPDATE:
        log('Update script skipped by request')
    else:
        run_update()
    if SKIP_DISK_CLEANUP:
        log('Disk cleanup script skipped by request')
    else:
        run_disk_cleanup()
    total, used, free, percent = disk_pressure()
    log(f'DISK_AFTER total={total} used={used} free={free} used_percent={percent}')
    log('Cleanup finished')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
