"""Exercise native V2 subagent sessions with local scripted model responses only."""

import base64
import hashlib
import http.server
import json
import os
import pathlib
import queue
import re
import secrets
import signal
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request


def main():
    config_path = pathlib.Path(sys.argv[1]).resolve()
    evidence = pathlib.Path(sys.argv[2]).resolve()
    evidence.mkdir(parents=True, exist_ok=True)
    fixture = pathlib.Path(tempfile.mkdtemp(prefix="native-mock-", dir=pathlib.Path(tempfile.gettempdir()).resolve() / "opencode"))
    original = config_path.read_bytes()
    config = json.loads(original)
    instructions = pathlib.Path(config["instructions"][-1]).read_bytes()
    (fixture / "AGENTS.md").write_bytes(instructions)
    requests = []
    failures = []
    lock = threading.Lock()

    class Mock(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            with lock:
                requests.append({"path": self.path, "model": body.get("model")})
                count = len(requests)
            try:
                assert self.path == "/v1/chat/completions", self.path
                assert count <= 5, "mock request budget exceeded"
                model = body["model"]
                messages = body["messages"]
                tools = {t["function"]["name"]: t["function"] for t in body.get("tools", [])}
                if model == "mimo-v2.6-flash":
                    assert "subagent" not in tools, "Explore can recursively delegate"
                    delta = {"content": "EXPLORE_NATIVE_OK"}
                elif model == "qwen3.7-plus":
                    assert "subagent" not in tools, "General can recursively delegate"
                    delta = {"content": "GENERAL_NATIVE_OK"}
                else:
                    assert model == "gpt-6.1-sol", model
                    assert "subagent" in tools, "native tool absent from Build request"
                    assert "BEST Hybrid: proportional native delegation" in json.dumps(messages)
                    outputs = [m for m in messages if m["role"] == "tool"]
                    if outputs:
                        returned = json.dumps(outputs)
                        assert "EXPLORE_NATIVE_OK" in returned
                        assert "GENERAL_NATIVE_OK" in returned
                        delta = {"content": "PARENT_RECEIVED_BOTH_NATIVE_RESULTS"}
                    elif "STRUCTURED_NATIVE_PROBE" in json.dumps(messages):
                        schema = tools["subagent"]["parameters"]
                        (evidence / "native-subagent-schema.json").write_text(json.dumps(schema, indent=2))
                        delta = {"tool_calls": [
                            {"index": i, "id": f"native_lane_{agent}", "type": "function",
                             "function": {"name": "subagent", "arguments": json.dumps({
                                 "agent": agent, "description": f"Bounded {agent} probe",
                                 "prompt": f"Return exactly {marker}. Do not use tools.",
                                 "background": False})}}
                            for i, (agent, marker) in enumerate([
                                ("explore", "EXPLORE_NATIVE_OK"), ("general", "GENERAL_NATIVE_OK")])]}
                    else:
                        assert "SIMPLE_NATIVE_PROBE" in json.dumps(messages)
                        delta = {"content": "4"}
                # The mock only supplies LLM responses; OpenCode creates/runs children.
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                for change, finish in [(delta, None), ({}, "tool_calls" if "tool_calls" in delta else "stop")]:
                    chunk = {"id": f"mock-{count}", "object": "chat.completion.chunk", "created": 1,
                             "model": model, "choices": [{"index": 0, "delta": change, "finish_reason": finish}]}
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            except Exception as error:
                failures.append(str(error))
                self.send_error(500, "mock contract failure")

    mock = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{mock.server_port}/v1"
    config.update(instructions=[str(fixture / "AGENTS.md")], skills=[], mcp={"servers": {}},
                  plugins=[], snapshots=False, warming=False)
    # Only fixture transport is replaced. Role model IDs and permissions are unchanged.
    config["providers"] = {
        provider: {"package": "@opencode/ai/providers/openai-compatible", "env": [],
                   "settings": {"baseURL": endpoint, "apiKey": ""},
                   "models": {model: {"modelID": model, "package": "@opencode/ai/providers/openai-compatible",
                              "capabilities": {"tools": True, "input": ["text"], "output": ["text"]},
                              "limit": {"context": 128000, "output": 4096},
                              "cost": {"input": 0, "output": 0}}
                              for model in models}}
        for provider, models in {"openai": ["gpt-6.1-sol", "gpt-6-luna"],
                                 "opencode-go": ["mimo-v2.6-flash", "qwen3.7-plus"]}.items()}
    file = fixture / "opencode.json"
    file.write_text(json.dumps(config))
    for name in ["home", "config", "data", "state", "cache", "tmp", "config-dir"]:
        (fixture / name).mkdir()
    # This ephemeral server password is unrelated to any stored account credential.
    password = secrets.token_urlsafe(32)
    env = {"PATH": "/opt/homebrew/opt/node@22/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
           "HOME": str(fixture / "home"), "PWD": str(fixture), "LANG": "en_US.UTF-8",
           "TMPDIR": str(fixture / "tmp"), "OPENCODE_PASSWORD": password,
           "OPENCODE_CONFIG": str(file), "OPENCODE_CONFIG_DIR": str(fixture / "config-dir"),
           "OPENCODE_DB": ":memory:", "OPENCODE_DISABLE_MODELS_FETCH": "1",
           "OPENCODE_CONFIG_PROJECT_DISABLE": "1", "OPENCODE_DISABLE_CLAUDE_CODE": "1",
           **{f"XDG_{kind.upper()}_HOME": str(fixture / kind) for kind in ["config", "data", "state", "cache"]}}
    sandbox = fixture / "isolation.sb"
    sandbox.write_text(f'''(version 1)
(allow default)
(deny file-read* (subpath {json.dumps(str(pathlib.Path.home()))}))
(deny file-write*)
(allow file-write* (subpath {json.dumps(str(fixture))}) (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
''')
    command = ["/usr/bin/sandbox-exec", "-f", str(sandbox), "opencode"]
    stderr = (evidence / "mock-native-server.stderr").open("w")
    server = subprocess.Popen([*command, "serve", "--hostname", "127.0.0.1", "--port", "0"],
                              cwd=fixture, env=env, stdin=subprocess.DEVNULL,
                              stdout=subprocess.PIPE, stderr=stderr, text=True, start_new_session=True)
    ready = queue.Queue()
    events = queue.Queue()

    def output():
        for line in server.stdout:
            match = re.search(r"http://127\.0\.0\.1:\d+", line)
            if match:
                ready.put(match.group())

    threading.Thread(target=output, daemon=True).start()

    def stop():
        if server.poll() is None:
            os.killpg(server.pid, signal.SIGTERM)

    timer = threading.Timer(90, stop)
    timer.start()
    result = {"status": "FAIL", "fixture": str(fixture), "real_provider_requests": 0}
    try:
        url = ready.get(timeout=25)
        authorization = "Basic " + base64.b64encode(("opencode:" + password).encode()).decode()

        def api(method, path, body=None):
            request = urllib.request.Request(url + path, method=method,
                data=None if body is None else json.dumps(body).encode(),
                headers={"Content-Type": "application/json", "Authorization": authorization})
            with urllib.request.urlopen(request, timeout=20) as response:
                return json.load(response)

        # Reproduce the old failure without disabling server authentication.
        try:
            urllib.request.urlopen(url + "/openapi.json", timeout=5)
            raise AssertionError("unauthenticated request unexpectedly succeeded")
        except urllib.error.HTTPError as error:
            assert error.code == 401
        assert requests == []
        # Native client validates the same ephemeral server authentication context.
        authenticated = subprocess.run([*command, "api", "--server", url, "GET", "/api/info"],
            env=env, cwd=fixture, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        assert authenticated.returncode == 0, authenticated.stderr
        assert json.loads(authenticated.stdout)["version"] == "2.2.5"
        spec = api("GET", "/openapi.json")
        assert "/api/session/{sessionID}/prompt" in spec["paths"]
        result["auth"] = {"unauthenticated": 401, "native_authenticated": 200}
        query = "?location%5Bdirectory%5D=" + urllib.parse.quote(str(fixture), safe="")
        agents = api("GET", "/api/agent" + query)
        (evidence / "mock-native-agents.json").write_text(json.dumps(agents, indent=2))
        by_id = {a["id"]: a for a in agents["data"]}
        assert by_id["build"]["model"] == {"id": "gpt-6.1-sol", "providerID": "openai", "variant": "low"}
        connections = api("GET", "/api/integration" + query)
        # Only public connection metadata, not the credential endpoint or stored values.
        relevant = [i for i in connections["data"] if i["id"] in ["openai", "opencode-go"]]
        assert all(not i["connections"] for i in relevant)
        (evidence / "mock-integrations.json").write_text(json.dumps(relevant, indent=2))

        def listen():
            request = urllib.request.Request(url + "/api/event", headers={"Authorization": authorization})
            try:
                with urllib.request.urlopen(request, timeout=80) as stream:
                    events.put({"type": "probe.connected"})
                    for line in stream:
                        if line.startswith(b"data:"):
                            events.put(json.loads(line[5:]))
            except Exception as error:
                events.put({"type": "probe.error", "error": str(error)})

        threading.Thread(target=listen, daemon=True).start()
        assert events.get(timeout=5)["type"] == "probe.connected"
        for name in ["simple", "structured"]:
            parent = api("POST", "/api/session", {"title": "Native mock " + name,
                         "location": {"directory": str(fixture)}})["data"]
            sid = parent["id"]
            api("POST", f"/api/session/{sid}/prompt", {"text": name.upper() + "_NATIVE_PROBE"})
            while True:
                event = events.get(timeout=30)
                with (evidence / "mock-native-events.jsonl").open("a") as stream:
                    stream.write(json.dumps(event) + "\n")
                assert event["type"] not in ["session.retry.scheduled", "probe.error"], event
                assert not failures, failures
                if event.get("data", {}).get("sessionID") == sid and event["type"].startswith("session.execution."):
                    if event["type"] == "session.execution.started":
                        continue
                    assert event["type"] == "session.execution.succeeded", event
                    break
            sessions = api("GET", "/api/session?limit=20")["data"]
            children = [s for s in sessions if s.get("parentID") == sid]
            assert len(children) == (0 if name == "simple" else 2), children
            exports = []
            for info in [parent, *children]:
                exported = api("GET", f"/api/experimental/session/{info['id']}/export")
                (evidence / (name + "-" + info["id"] + ".json")).write_text(json.dumps(exported, indent=2))
                exports.append(exported)
            result[name] = {"parent": sid, "children": children}
            if name == "structured":
                # Actual session/assistant metadata and completed native tool results.
                parent_data = exports[0].get("data", exports[0])
                tools = [c for m in parent_data["messages"] if m["type"] == "assistant"
                         for c in m["content"] if c["type"] == "tool" and c["name"] == "subagent"]
                assert len(tools) == 2 and all(t["state"]["status"] == "completed" for t in tools), tools
                for exported in exports[1:]:
                    data = exported.get("data", exported)
                    info = data["info"]
                    assert info["parentID"] == sid and info["outcome"] == "succeeded"
                    expected = {"explore": "mimo-v2.6-flash", "general": "qwen3.7-plus"}[info["agent"]]
                    assistants = [m for m in data["messages"] if m["type"] == "assistant"]
                    assert assistants and all(m["model"]["id"] == expected and m["model"]["providerID"] == "opencode-go" for m in assistants)
                assert "PARENT_RECEIVED_BOTH_NATIVE_RESULTS" in json.dumps(parent_data["messages"])
        assert not failures, failures
        assert len(requests) == 5, requests
        result.update(status="PASS", mock_requests=requests,
                      live_config_sha256=hashlib.sha256(original).hexdigest())
    finally:
        timer.cancel()
        stop()
        try:
            server.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(server.pid, signal.SIGKILL)
            server.wait()
        mock.shutdown()
        mock.server_close()
        stderr.close()
        assert config_path.read_bytes() == original, "live configuration changed"
        (evidence / "mock-native-result.json").write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
