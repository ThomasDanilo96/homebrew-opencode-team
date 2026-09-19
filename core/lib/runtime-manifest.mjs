import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

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

const manifestPath = join(runDirectory, "manifest.json");
let manifest = {};
try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const roles = ["launcher", "server", "bridge", "attach", "watchdog", "reaper"];
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
    size_bytes: await fileSize(runDirectory),
  };
} else if (command === "state") {
  manifest.state = process.argv[4] || "UNCERTAIN";
  manifest.parent_session_id = await readText("parent_session_id");
  manifest.last_heartbeat = new Date().toISOString();
  manifest = { ...manifest, ...processFields, size_bytes: await fileSize(runDirectory) };
} else if (command === "heartbeat") {
  manifest.parent_session_id = await readText("parent_session_id");
  manifest.last_heartbeat = new Date().toISOString();
  manifest = { ...manifest, ...processFields, size_bytes: await fileSize(runDirectory) };
} else {
  throw new Error(`unknown runtime manifest command: ${command}`);
}

await mkdir(runDirectory, { recursive: true });
await atomicWrite(manifestPath, manifest);
