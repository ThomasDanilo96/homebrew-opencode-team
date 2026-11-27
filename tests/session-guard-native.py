"""Native full-TUI acceptance against an explicitly supplied patched binary."""

import base64
import http.server
import json
import os
import pathlib
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request

BINARY = str(pathlib.Path(sys.argv[1]).resolve(strict=True))
BASE = pathlib.Path(
    os.environ.get("SESSION_GUARD_TEST_TMP", tempfile.gettempdir())
).resolve()
PLUGIN = pathlib.Path(__file__).resolve().parents[1] / "shared/session-guard"
LINUX_CONTAINER = (
    sys.platform == "linux"
    and pathlib.Path("/.dockerenv").exists()
    and {
        path.name
        for path in pathlib.Path("/sys/class/net").iterdir()
        if path.is_dir() and int((path / "flags").read_text().strip(), 16) & 1
    }
    == {"lo"}
)
if sys.platform != "darwin" and not LINUX_CONTAINER:
    raise SystemExit(
        "Native acceptance requires macOS Seatbelt or Docker with --network none"
    )


def wait(fn, desc, seconds=12):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        if result := fn():
            return result
        time.sleep(0.08)
    raise AssertionError(desc)


for label in ("BEST", "FREE"):
    with tempfile.TemporaryDirectory(
        dir=BASE, prefix="guard-" + label.lower() + "-"
    ) as directory:
        root = pathlib.Path(directory)
        hits = []

        class Provider(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                hits.append(json.dumps(data))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                delta, finish = (
                    {"role": "assistant", "content": "Local confirmation of fixture."},
                    "stop",
                )
                last_user = next(
                    (m for m in reversed(data["messages"]) if m["role"] == "user"), {}
                )
                if (
                    "FIXTURE_BACKGROUND" in json.dumps(last_user.get("content"))
                    and data["messages"][-1]["role"] == "user"
                    and "shell"
                    in [t["function"]["name"] for t in data.get("tools", [])]
                ):
                    delta = {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "fixture_background",
                                "type": "function",
                                "function": {
                                    "name": "shell",
                                    "arguments": json.dumps(
                                        {
                                            "command": "sleep 12; printf FIXTURE_JOB_COMPLETE",
                                            "background": True,
                                        }
                                    ),
                                },
                            }
                        ]
                    }
                    finish = "tool_calls"
                for delta, finish in [(delta, None), ({}, finish)]:
                    chunk = {
                        "id": "local",
                        "object": "chat.completion.chunk",
                        "created": 1,
                        "model": data["model"],
                        "choices": [
                            {"index": 0, "delta": delta, "finish_reason": finish}
                        ],
                    }
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")

        mock = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Provider)
        thread = threading.Thread(target=mock.serve_forever, daemon=True)
        thread.start()
        cfg = root / "config-dir"
        inline_plugin = os.environ.get("SESSION_GUARD_TEST_INLINE_PLUGIN") == "1"
        if not inline_plugin:
            shutil.copytree(PLUGIN, cfg / "plugins" / "opencode-team.session-guard")
        observer = cfg / "plugins" / "session-guard-fixture-observer"
        observer.mkdir(parents=True)
        (observer / "package.json").write_text(
            '{"name":"session-guard-fixture-observer","type":"module","exports":{"./tui":"./tui.js"}}'
        )
        delivery_log = root / "delivery.log"
        (observer / "tui.js").write_text(f"""
import {{ Plugin }} from '@opencode/plugin/tui';
import {{ appendFileSync }} from 'node:fs';
export default Plugin.define({{
  id: 'session-guard-fixture-observer',
  setup({{ ui }}) {{
    return ui.prompt.beforeSubmit(draft => {{
      if (draft.text.includes('B_LEGACY_MARKER'))
        appendFileSync({json.dumps(str(delivery_log))}, JSON.stringify([draft.sessionID, draft.delivery]) + '\\n');
      return true;
    }});
  }},
}});
""")
        config = {
            "model": "guard-local/probe",
            "providers": {
                "guard-local": {
                    "package": "@opencode/ai/providers/openai-compatible",
                    "env": [],
                    "settings": {
                        "baseURL": f"http://127.0.0.1:{mock.server_port}/v1",
                        "apiKey": "",
                    },
                    "models": {
                        "probe": {
                            "modelID": "probe",
                            "package": "@opencode/ai/providers/openai-compatible",
                            "capabilities": {
                                "tools": True,
                                "input": ["text"],
                                "output": ["text"],
                            },
                            "limit": {"context": 128000, "output": 4096},
                            "cost": {"input": 0, "output": 0},
                        }
                    },
                }
            },
            "policies": [
                {"action": "provider.use", "resource": "*", "effect": "deny"},
                {
                    "action": "provider.use",
                    "resource": "guard-local",
                    "effect": "allow",
                },
            ],
            "warming": False,
            "permissions": {"shell": "allow"},
        }
        (cfg / "opencode.json").write_text(json.dumps(config))
        for d in ("home", "data", "state", "config", "cache", "tmp", "project"):
            (root / d).mkdir()
        (cfg / "cli.json").write_text('{"keybinds":{"prompt.queue":"ctrl+g"}}')
        password = secrets.token_urlsafe(32)
        env = {
            "PATH": "/opt/homebrew/bin:/usr/bin:/bin",
            "HOME": str(root / "home"),
            "TMPDIR": str(root / "tmp"),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "OPENCODE_DISABLE_MODELS_FETCH": "1",
            "OPENCODE_CONFIG_PROJECT_DISABLE": "1",
            "OPENCODE_DISABLE_CLAUDE_CODE": "1",
            "OPENCODE_PASSWORD": password,
            "OPENCODE_CONFIG_DIR": str(cfg),
            **{
                f"XDG_{k.upper()}_HOME": str(root / k)
                for k in ("data", "state", "config", "cache")
            },
        }
        if inline_plugin:
            env["OPENCODE_CONFIG_CONTENT"] = json.dumps({"plugins": [str(PLUGIN)]})
        sb = root / "isolation.sb"
        sb.write_text(f"""(version 1)
(allow default)
(deny file-read* (subpath {json.dumps(str(pathlib.Path.home()))}))
(deny file-write*)
(allow file-write* (subpath {json.dumps(str(root))}) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
""")
        start = (
            [BINARY]
            if LINUX_CONTAINER
            else ["/usr/bin/sandbox-exec", "-f", str(sb), BINARY]
        )
        log = root / "serve.log"
        tmux = ["tmux", "-L", "guard-" + secrets.token_hex(5), "-f", "/dev/null"]
        with log.open("w") as out:
            server = subprocess.Popen(
                [*start, "serve", "--hostname", "127.0.0.1", "--port", "0"],
                env=env,
                cwd=root / "project",
                stdout=out,
                stderr=out,
            )
        try:
            match = wait(
                lambda: re.search(r"http://127\.0\.0\.1:\d+", log.read_text()),
                "isolated server ready",
            )
            url = match[0]

            def api(route, data=None):
                auth = base64.b64encode(("opencode:" + password).encode()).decode()
                req = urllib.request.Request(
                    url + route,
                    data=json.dumps(data).encode() if data is not None else None,
                    headers={
                        "Authorization": "Basic " + auth,
                        "Content-Type": "application/json",
                    },
                )
                try:
                    with urllib.request.urlopen(req, timeout=10) as response:
                        content = response.read()
                        return response.status, json.loads(content).get(
                            "data"
                        ) if content else None
                except urllib.error.HTTPError as e:
                    return e.code, None

            mig = "# GIAFFATTO — MIGRAZIONE MITECH\n## OBIETTIVO\nVerifica migrazione."
            recovery = "# GIAFFATTO — BACKUP OFF-SITE CENTRALIZZATO E DISASTER RECOVERY\n## OBIETTIVO\nVerifica ripristino."
            wrong = "# OPENCODE TEAM — AI HANDOFF\nRepository: ~/Sites/Github/brew-opencode-team\n## OBIETTIVO\nA_WRONG_MARKER"
            legacy = "# GIAFFATTO — ELIMINAZIONE SISTEMA LEGACY DI DEPLOY\n## OBIETTIVO\nB_LEGACY_MARKER"

            def session(title):
                status, data = api(
                    "/api/session",
                    {"location": {"directory": str(root / "project")}, "title": title},
                )
                assert status == 200
                return data["id"]

            sa, sb_id = session("Mitech Fixture"), session("Recovery Fixture")

            def route(sid, suffix=""):
                return "/api/session/" + sid + suffix

            def messages(sid):
                return api(route(sid, "/message"))[1]

            def inbox(sid):
                return api(route(sid, "/inbox"))[1]

            def sent(marker):
                return sum(marker in req for req in hits)

            def seen(sid, text):
                return next((m for m in messages(sid) if m.get("text") == text), None)

            def seed(sid, text, marker):
                status, _ = api(route(sid, "/prompt"), {"text": text})
                assert status == 200, status
                wait(lambda: sent(marker), "positive loopback provider control")
                wait(
                    lambda: seen(sid, text) and messages(sid)[0]["type"] == "idle",
                    "fixture turn idle",
                )

            seed(sa, mig, "MIGRAZIONE MITECH")
            reverted = wrong.replace("A_WRONG_MARKER", "KEEP HISTORY NODE")
            seed(sa, reverted, "KEEP HISTORY NODE")
            seed(sb_id, recovery, "DISASTER RECOVERY")
            second = seen(sa, reverted)["id"]
            status, _ = api(
                route(sa, "/revert/stage"), {"messageID": second, "files": False}
            )
            assert status == 200, status

            def t(*args):
                return subprocess.check_output(
                    [*tmux, *args], text=True, stderr=subprocess.STDOUT
                )

            def pane(window):
                return t("capture-pane", "-p", "-t", f"guard:{window}")

            def keys(window, *args):
                return t("send-keys", "-t", f"guard:{window}", *args)

            def launch(window, sid, title):
                command = shlex.join(
                    [
                        "/usr/bin/env",
                        "-i",
                        *[f"{k}={v}" for k, v in env.items()],
                        *start,
                        "--server",
                        url,
                        "-s",
                        sid,
                        str(root / "project"),
                    ]
                )
                args = (
                    ("new-session", "-d", "-x", "160", "-y", "44", "-s", "guard")
                    if window == "a"
                    else ("new-window", "-d", "-t", "guard")
                )
                t(
                    *args,
                    "-n",
                    window,
                    "-c",
                    str(root / "project"),
                    command + "; sleep 30",
                )
                try:
                    wait(lambda: title in pane(window), "TUI ready " + window)
                except AssertionError:
                    print(pane(window))
                    raise

            launch("a", sa, "Mitech Fixture")
            launch("b", sb_id, "Recovery Fixture")

            def enter(window, text, queue=False):
                t("set-buffer", "--", text)
                t("paste-buffer", "-pr", "-t", f"guard:{window}")
                if "\n" in text:
                    wait(lambda: "[Pasted ~" in pane(window), "native paste ready")
                keys(window, "C-g" if queue else "Enter")

            def dialog(window, word):
                try:
                    wait(lambda: word in pane(window), "dialog " + window)
                except AssertionError:
                    print(pane(window))
                    raise

            def cancel(window):
                keys(window, "Escape")
                wait(lambda: "Session Guard" not in pane(window), "dialog dismissed")

            before_a, before_b = messages(sa), messages(sb_id)
            count = len(hits)
            enter("a", wrong)
            dialog("a", "prompt bloccato")
            enter("b", legacy, True)
            dialog("b", "prompt sospeso")
            assert (
                messages(sa) == before_a
                and messages(sb_id) == before_b
                and not inbox(sa)
                and not inbox(sb_id)
            )
            assert (
                len(hits) == count
                and api(route(sa))[1].get("revert")
                and seen(sa, reverted)
            )
            cancel("a")
            assert (
                "A_WRONG_MARKER" in pane("a")
                or "Pasted" in pane("a")
                or "AI HANDOFF" in pane("a")
            )
            keys("a", "Enter")
            dialog("a", "prompt bloccato")
            cancel("a")
            assert "prompt sospeso" in pane("b") and len(hits) == count
            keys("b", "-l", "INVIA")
            keys("b", "Enter")
            wait(lambda: sent("B_LEGACY_MARKER"), "confirmed queue reaches loopback")
            try:
                wait(
                    lambda: seen(sb_id, legacy + " "),
                    "exact native expanded text (collapsed paste adds one space)",
                )
            except AssertionError:
                print(
                    [
                        repr(m.get("text"))
                        for m in messages(sb_id)
                        if m["type"] == "user"
                    ]
                )
                raise
            assert (
                sent("A_WRONG_MARKER") == 0
                and messages(sa) == before_a
                and not inbox(sa)
            )
            wait(
                lambda: messages(sb_id)[0]["type"] == "idle", "confirmed send completed"
            )
            assert sent("B_LEGACY_MARKER") == 1
            assert [
                json.loads(line) for line in delivery_log.read_text().splitlines()
            ] == [[sb_id, "queue"]]
            followup = legacy.replace("B_LEGACY_MARKER", "D_CONFIRMED_MANDATE")
            enter("b", followup)
            wait(
                lambda: seen(sb_id, followup + " ") and sent("D_CONFIRMED_MANDATE"),
                "admitted mandate now accepted normally",
            )
            print(
                label,
                "A B D G: cross-project cancel + same-project queued confirm in separate TUI instances; pending revert/history and other draft unchanged",
                flush=True,
            )
            # Clear an isolated staged revert, then prove normal GO/log input is not intercepted.
            auth = base64.b64encode(("opencode:" + password).encode()).decode()
            req = urllib.request.Request(
                url + route(sa, "/revert"),
                headers={"Authorization": "Basic " + auth},
                method="DELETE",
            )
            urllib.request.urlopen(req, timeout=5).close()
            # Restore the Mitech scope for the remaining independent checks.
            seed(sa, mig, "MIGRAZIONE MITECH")
            # Reopen the fixture without the canceled composer draft for the GO check.
            t("kill-window", "-t", "guard:a")
            launch("a2", sa, "Mitech Fixture")
            go = "GO. Autorizzo soltanto la verifica Mitech."
            enter("a2", go)
            wait(lambda: sent(go), "C GO sent")
            wait(lambda: seen(sa, go) and messages(sa)[0]["type"] == "idle", "GO done")
            context = "Contesto:\nRepository: ~/Sites/Github/brew-opencode-team\nTraceback: TypeError fixture log"
            enter("a2", context)
            wait(lambda: sent("TypeError fixture log"), "F context sent")
            wait(
                lambda: seen(sa, context + " ") and messages(sa)[0]["type"] == "idle",
                "context done",
            )
            print(
                label,
                "C F: GO and pasted diagnostic passed without approval",
                flush=True,
            )
            status, _ = api(route(sa, "/prompt"), {"text": "FIXTURE_BACKGROUND"})
            assert status == 200

            def shell_message():
                return next(
                    (
                        part
                        for message in messages(sa)
                        for part in message.get("content", [])
                        if part.get("id") == "fixture_background"
                    ),
                    None,
                )

            def running_shell():
                part = shell_message()
                if part and part["state"].get("metadata", {}).get("shellID"):
                    return part["state"]["metadata"]["shellID"]

            shell_id = wait(running_shell, "native background shell started")
            enter("a2", wrong)
            dialog("a2", "prompt bloccato")
            cancel("a2")
            assert sent("A_WRONG_MARKER") == 0 and not seen(sa, wrong)
            done = wait(
                lambda: next(
                    (
                        m
                        for m in messages(sa)
                        if m.get("metadata", {}).get("shellID") == shell_id
                        and m.get("metadata", {}).get("source") == "shell"
                    ),
                    None,
                ),
                "background completion",
                seconds=24,
            )
            assert done["metadata"].get("exit") == 0
            print(
                label,
                "E: same-session native background tool completed (exit 0) while incompatible draft stayed unadmitted",
                flush=True,
            )
        finally:
            subprocess.run(
                [*tmux, "kill-server"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            server.terminate()
            server.wait(timeout=10)
            mock.shutdown()
            mock.server_close()
