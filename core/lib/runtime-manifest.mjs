import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const runDirectory = process.argv[2];
const command = process.argv[3];
if (!runDirectory || !command) throw new Error("runtime manifest requires a run directory and command");

const readText = async (name) => {
  try { return (await readFile(join(runDirectory, name), "utf8")).trim(); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
};

const identity = async (role) => {
  const values = {};
  for (const line of (await readText(`${role}.identity`)).split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) values[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return Object.keys(values).length ? values : null;
};

const fileSize = async (directory) => {
  let total = 0;
  const entries = await (await import("node:fs/promises")).readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) total += await fileSize(path);
    else if (entry.isFile()) total += (await stat(path)).size;
  }
  return total;
};

const atomicWrite = async (path, value) => {
  const temporary = `${path}.tmp.${process.pid}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
};

const writeTerminalSummary = async (fields) => {
  const runtimeRoot = await readText("runtime_root");
  const runID = await readText("run_id");
  if (!runtimeRoot || resolve(runtimeRoot) !== resolve(dirname(dirname(runDirectory))) || !/^[0-9a-f]{8}$/i.test(runID)) return;
  const directory = join(runtimeRoot, "terminal-status");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await atomicWrite(join(directory, `${runID}.json`), fields);
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /^[0-9a-f]{8}\.json$/i.test(entry.name))
    .map(async (entry) => ({ name: entry.name, mtime: (await stat(join(directory, entry.name))).mtimeMs }));
  const ordered = (await Promise.all(entries)).sort((left, right) => right.mtime - left.mtime);
  await Promise.all(ordered.slice(64).map((entry) => rm(join(directory, entry.name), { force: true })));
};

const manifestPath = join(runDirectory, "manifest.json");
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const roles = ["launcher", "server", "bridge", "attach", "watchdog", "reaper"];
const lifecycleFields = async () => {
  const createdAt = await readText("created_at");
  const endedAt = await readText("ended_at");
  const stage = await readText("stage");
  const statusFile = await readText("status");
  const stageStatus = { initializing: "STARTING", server_starting: "STARTING", server_ready: "STARTING", session_published: "RUNNING", bridge_starting: "RUNNING", active: "RUNNING", waiting_child: "WAITING_CHILD", verifying: "VERIFYING", waiting_provider: "WAITING_PROVIDER", completed: "COMPLETED", stopped: "COMPLETED", failed: "FAILED", timed_out: "TIMED_OUT" }[stage] || null;
  const started = Date.parse(createdAt);
  const ended = Date.parse(endedAt);
  const elapsed = Number.isFinite(started) ? Math.max(0, Math.floor(((Number.isFinite(ended) ? ended : Date.now()) - started) / 1000)) : null;
  return {
    status: stageStatus || statusFile || null,
    stage: stage || null,
    parent_session_id: await readText("parent_session_id") || null,
    active_child_session_id: await readText("active_child_session_id") || null,
    active_child_agent: await readText("active_child_agent") || null,
    provider: await readText("provider") || null,
    model: await readText("model") || null,
    elapsed_seconds: elapsed,
    failure_reason: await readText("failure_reason") || null,
    timeout_reason: await readText("timeout_reason") || null,
    status_source: "runtime-state",
  };
};
const processFields = {};
for (const role of roles) {
  const values = await identity(role);
  if (!values) continue;
  processFields[`${role}_pid`] = Number(values.pid);
  processFields[`${role}_start_identity`] = values.start_epoch;
}

if (command === "publish") {
  manifest = {
    schema_version: 1,
    run_id: await readText("run_id"),
    team: await readText("team"),
    job_type: await readText("job_type") || "interactive",
    parent_session_id: await readText("parent_session_id"),
    ...processFields,
    parent_pid: Number(await readText("parent_pid")) || null,
    created_at: await readText("created_at") || new Date().toISOString(),
    last_heartbeat: new Date().toISOString(),
    working_directory: await readText("working_directory"),
    runtime_root: await readText("runtime_root"),
    state: await readText("state") || "CREATING",
    ...await lifecycleFields(),
    size_bytes: await fileSize(runDirectory),
  };
} else if (command === "state") {
  manifest.state = process.argv[4] || "UNCERTAIN";
  manifest.parent_session_id = await readText("parent_session_id");
  manifest.last_heartbeat = new Date().toISOString();
  manifest = { ...manifest, ...processFields, ...await lifecycleFields(), size_bytes: await fileSize(runDirectory) };
} else if (command === "heartbeat") {
  manifest.parent_session_id = await readText("parent_session_id");
  manifest.last_heartbeat = new Date().toISOString();
  manifest = { ...manifest, ...processFields, ...await lifecycleFields(), size_bytes: await fileSize(runDirectory) };
} else if (command === "status") {
  const stage = process.argv[4] || "";
  const child = process.argv[5] || "";
  const failure = process.argv.slice(6).join(" ");
  if (stage) await writeFile(join(runDirectory, "stage"), `${stage}\n`, { mode: 0o600 });
  if (child) await writeFile(join(runDirectory, "active_child_session_id"), `${child}\n`, { mode: 0o600 });
  else await rm(join(runDirectory, "active_child_session_id"), { force: true });
  if (failure) await writeFile(join(runDirectory, "failure_reason"), `${failure}\n`, { mode: 0o600 });
  else await rm(join(runDirectory, "failure_reason"), { force: true });
  if (stage === "timed_out") await rm(join(runDirectory, "failure_reason"), { force: true });
  if (stage === "failed" || stage === "stopped") await rm(join(runDirectory, "timeout_reason"), { force: true });
  if (stage === "failed" || stage === "stopped" || stage === "timed_out") await writeFile(join(runDirectory, "ended_at"), `${new Date().toISOString()}\n`, { mode: 0o600 });
  manifest = { ...manifest, ...processFields, ...await lifecycleFields(), size_bytes: await fileSize(runDirectory) };
  if (["failed", "stopped", "timed_out"].includes(stage)) {
    await writeTerminalSummary({
      run_id: manifest.run_id,
      team: manifest.team,
      parent_session_id: manifest.parent_session_id || null,
      status: manifest.status,
      stage: manifest.stage,
      elapsed_seconds: manifest.elapsed_seconds,
      failure_reason: manifest.failure_reason || null,
      timeout_reason: manifest.timeout_reason || null,
      ended_at: await readText("ended_at") || null,
    });
  }
} else {
  throw new Error(`unknown runtime manifest command: ${command}`);
}

await mkdir(runDirectory, { recursive: true });
await atomicWrite(manifestPath, manifest);
