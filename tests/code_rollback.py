"""Verify code-only rollback with a retained code archive, never live profile data."""

import hashlib
import json
import os
import plistlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if ROOT != Path(os.environ.get("OPENCODE_TEAM_STAGING_ROOT", "/")).resolve():
    raise RuntimeError("Use tests/guardrail/runner.sh rollback ARCHIVE MANIFEST")

MOCK_HOOK = """\
import fs from 'node:fs';
import os from 'node:os';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
Object.defineProperty(process, 'platform', {value:'darwin'});
if (!process.env.MOCK_REAL_HOME) os.userInfo = () => ({homedir:process.env.HOME});
const original = cp.spawnSync;
cp.spawnSync = (bin, args) => {
  if (bin !== '/bin/launchctl') return original(bin, args);
  fs.appendFileSync(process.env.MOCK_LAUNCHCTL_LOG, JSON.stringify(args)+'\\n');
  const state = process.env.MOCK_LAUNCHCTL_STATE;
  if (process.env.MOCK_LAUNCHCTL_FAIL === args[0]) return {status:5, stderr:'injected launchctl failure', stdout:''};
  if (args[0] === 'print') return fs.existsSync(state) ? {status:0, stdout:'path = '+fs.readFileSync(state,'utf8')+'\\n'} : {status:113, stderr:'Could not find service', stdout:''};
  if (args[0] === 'bootstrap') fs.writeFileSync(state, args[2]);
  if (args[0] === 'bootout') fs.unlinkSync(state);
  return {status:0, stdout:''};
};
syncBuiltinESMExports();
"""


def main():
    archive, receipt_path = map(Path, sys.argv[1:])
    receipt = json.loads(receipt_path.read_text())
    if hashlib.sha256(archive.read_bytes()).hexdigest() != receipt["archive_sha256"]:
        raise ValueError("archive-checksum-mismatch")
    with tempfile.TemporaryDirectory() as temporary:
        work = Path(temporary)
        old = work / "old"
        old.mkdir()
        with tarfile.open(archive) as source:
            seen = set()
            for member in source:
                path = Path(member.name)
                relative = Path(*path.parts[1:])
                name = relative.as_posix()
                if (not member.isfile() or path.is_absolute() or ".." in path.parts
                        or name not in receipt["files"] or name in seen
                        or relative.parts[0] not in ("bin", "shared", "completions", "VERSION")):
                    raise ValueError("not-a-code-only-archive")
                data = source.extractfile(member).read()
                if hashlib.sha256(data).hexdigest() != receipt["files"][name]:
                    raise ValueError("member-checksum-mismatch")
                target = old / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
                target.chmod(member.mode & 0o777)
                seen.add(name)
        if seen != set(receipt["files"]):
            raise ValueError("incomplete-code-archive")
        new = work / "new"
        new.mkdir()
        for name in ("bin", "shared", "completions"):
            shutil.copytree(ROOT / name, new / name)
        shutil.copyfile(ROOT / "VERSION", new / "VERSION")
        data = work / "profile-data-sentinel"
        data.write_bytes(b"fixture historical data: never part of code rollback")
        for index, (code, version) in enumerate(((new, "0.3.7"), (old, "0.3.6"), (new, "0.3.7"))):
            pending = work / "next"
            pending.symlink_to(code, target_is_directory=True)
            os.replace(pending, work / "current")
            result = subprocess.run(["/bin/bash", str(work / "current/bin/opencode-team"), "version"],
                                    check=True, capture_output=True, text=True, timeout=10)
            if result.stdout.strip() != "OpenCode Team " + version:
                raise ValueError("wrong-selected-code-version")
            if data.read_bytes() != b"fixture historical data: never part of code rollback":
                raise ValueError("profile-data-changed")
            print(f"CODE_ROLLBACK_CHECK={index + 1} version={version} PASS")

        _node = "/opt/homebrew/opt/node@22/bin/node"
        _node_dir = str(Path(_node).parent)
        _home, _team = work / "home", work / "team"
        _home.mkdir(parents=True)
        _team.mkdir(parents=True)
        _log = work / "launchctl.log"
        _state = work / "launchctl.state"
        _hook = work / "launchctl-mock.mjs"
        _hook.write_text(MOCK_HOOK)
        _plist = _home / "Library/LaunchAgents/io.opencode-team.safe-caches.plist"
        _marker = _team / "state/cleanup.json"
        _label = "io.opencode-team.safe-caches"
        (_home / "Library/LaunchAgents").mkdir(parents=True, exist_ok=True)
        (_team / "state").mkdir(parents=True, exist_ok=True)
        if ((_team / "config" / ".setup-lock").exists() or (_team / "config" / ".pending").exists()):
            raise ValueError("stale setup-lock or pending before cleanup")
        _base = {
            "HOME": str(_home), "OPENCODE_TEAM_HOME": str(_team), "TMPDIR": str(work),
            "PATH": f"{_node_dir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_OPTIONS": f"--import={_hook}",
            "MOCK_LAUNCHCTL_LOG": str(_log), "MOCK_LAUNCHCTL_STATE": str(_state),
        }

        def _run(code, use_cli, args, extra=None):
            env = dict(_base, **(extra or {}))
            cmd = ["/bin/bash", str(code / "bin/opencode-team"), *args] if use_cli else [_node, str(code / "shared/profiles.mjs"), *args]
            return subprocess.run(cmd, capture_output=True, text=True, timeout=30, env=env, cwd=str(work))

        def _calls():
            return [json.loads(line) for line in _log.read_text().splitlines() if line.strip()] if _log.exists() else []

        def _reset_log():
            if _log.exists():
                _log.unlink()

        def _assert_config(maintenance):
            plist = plistlib.loads(_plist.read_bytes())
            if plist["Label"] != _label or plist["ProgramArguments"] != ["/usr/bin/python3", str(maintenance)]:
                raise ValueError(f"plist label/argv wrong: {plist}")
            if plist["StartCalendarInterval"] != {"Hour": 4, "Minute": 15} or plist["ProcessType"] != "Background":
                raise ValueError(f"plist interval/type wrong: {plist}")
            if "RunAtLoad" in plist or "KeepAlive" in plist:
                raise ValueError(f"plist has RunAtLoad/KeepAlive: {plist}")
            if json.loads(_marker.read_text()) != {"enabled": True, "plist": _plist.read_text()}:
                raise ValueError("marker receipt mismatch")
            if len(list((_home / "Library/LaunchAgents").glob("*.plist"))) != 1:
                raise ValueError("not exactly one agent")
            uid = os.getuid()
            for c in _calls():
                if c[0] not in ("print", "bootout", "bootstrap"):
                    raise ValueError(f"unexpected launchctl call: {c}")
                if c[0] in ("print", "bootout") and c[1] != f"gui/{uid}/{_label}":
                    raise ValueError(f"wrong target: {c}")
                if c[0] == "bootstrap" and c != ["bootstrap", f"gui/{uid}", str(_plist)]:
                    raise ValueError(f"wrong bootstrap: {c}")

        for _code, _ver in ((old, "0.3.6"), (new, "0.3.7")):
            r = subprocess.run(["/bin/bash", str(_code / "bin/opencode-team"), "--help"],
                               capture_output=True, text=True, cwd=str(work.parent), env=_base, timeout=10)
            if r.returncode != 0 or "opencode-team" not in r.stdout:
                raise ValueError(f"--help failed for {_code.name}: {r.stderr}")
            r = subprocess.run(["/bin/bash", str(_code / "bin/opencode-team"), "version"],
                               capture_output=True, text=True, cwd=str(work.parent), env=_base, timeout=10)
            if r.returncode != 0 or r.stdout.strip() != f"OpenCode Team {_ver}":
                raise ValueError(f"version mismatch for {_code.name}: {r.stdout!r}")
        print("CLI_HELP_VERSION_UNRELATED_CWD=PASS")

        _reset_log()
        if _run(old, True, ["cleanup", "enable"]).returncode != 0:
            raise ValueError("old cleanup enable failed")
        if not _state.exists():
            raise ValueError("old enable did not load agent")
        _assert_config(old / "shared/maintenance.py")
        _reset_log()
        if _run(new, False, ["cleanup", "enable"]).returncode != 0:
            raise ValueError("new cleanup enable failed")
        if not _state.exists():
            raise ValueError("new enable did not load agent")
        _assert_config(new / "shared/maintenance.py")
        _uid = os.getuid()
        if not any(c[0] == "bootout" and c[1] == f"gui/{_uid}/{_label}" for c in _calls()):
            raise ValueError("migration did not bootout old agent")
        if not any(c[0] == "bootstrap" and c[1] == f"gui/{_uid}" for c in _calls()):
            raise ValueError("migration did not bootstrap new agent")
        print("CLEANUP_MIGRATION=PASS old->new bootout+bootstrap, receipt=new")

        _reset_log()
        if _run(old, True, ["cleanup", "enable"]).returncode != 0:
            raise ValueError("pre-failure old enable failed")
        if not _state.exists():
            raise ValueError("pre-failure old enable did not load")
        _reset_log()
        r = _run(new, False, ["cleanup", "enable"], {"MOCK_LAUNCHCTL_FAIL": "bootstrap"})
        if r.returncode == 0:
            raise ValueError("injected bootstrap failure must error")
        if _state.exists():
            raise ValueError("failed bootstrap left agent loaded")
        if plistlib.loads(_plist.read_bytes())["ProgramArguments"][1] != str(new / "shared/maintenance.py"):
            raise ValueError("failure plist not migrated")
        if json.loads(_marker.read_text()) != {"enabled": True, "plist": _plist.read_text()}:
            raise ValueError("failure receipt not new")
        print("CLEANUP_INJECTED_FAIL=PASS nonzero, unloaded, receipt=new")

        _reset_log()
        if _run(old, True, ["cleanup", "enable"]).returncode != 0:
            raise ValueError("rollback recovery failed")
        if not _state.exists():
            raise ValueError("rollback did not reload old agent")
        _assert_config(old / "shared/maintenance.py")
        print("CLEANUP_ROLLBACK_RECOVERY=PASS old path + receipt restored")

        (work / "current").unlink()
        shutil.rmtree(new)
        if data.read_bytes() != b"fixture historical data: never part of code rollback":
            raise ValueError("profile-data-changed at teardown")
        if not old.exists() or not data.exists():
            raise ValueError("code-uninstall-touched-retained-data")
        print("CODE_UNINSTALL_FIXTURE=PASS (not Homebrew uninstall)")


if __name__ == "__main__":
    main()
