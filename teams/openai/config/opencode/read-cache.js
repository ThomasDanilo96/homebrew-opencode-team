import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile), MAX_FILES = 256, MAX_FILE_BYTES = 10 * 1024 * 1024, MAX_TOTAL_BYTES = 64 * 1024 * 1024, MAX_LINK_BYTES = 4096;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const nativeRun = async (command, args, options = {}) => { const result = await execFileAsync(command, args, { cwd: options.cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }); return { status: 0, stdout: result.stdout, stderr: result.stderr }; };
const bytes = (value) => Buffer.isBuffer(value) ? value : Buffer.from(String(value ?? ""));
const git = async (runProcess, repository, args) => { const result = await runProcess("git", args, { cwd: repository }); if (!result || result.status !== 0) throw new Error("git_failed"); return bytes(result.stdout); };
const inside = (root, name) => {
  if (!name || name.includes("\0") || isAbsolute(name)) return false;
  const remainder = relative(root, resolve(root, name));
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder);
};
const within = (root, absolute) => {
  const remainder = relative(root, absolute);
  return remainder === "" || (remainder !== ".." && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder));
};
const protectedPath = (root, absolute) => {
  if (relative(root, absolute).split(sep).includes(".git")) return true;
  const stateRoot = process.env.OPENAI_TEAM_STATE_ROOT;
  return Boolean(stateRoot && within(root, resolve(stateRoot)) && within(resolve(stateRoot), absolute));
};
const afterSpaces = (record, count) => {
  let offset = 0;
  for (let index = 0; index < count; index += 1) { offset = record.indexOf(0x20, offset); if (offset === -1) throw new Error("malformed_status"); offset += 1; }
  if (offset >= record.length) throw new Error("malformed_status");
  return offset;
};
// v2 -z has a bare, following NUL record for rename/copy origins. Do not split paths on whitespace.
const parseStatus = (status) => {
  const records = []; let offset = 0;
  while (offset < status.length) {
    const end = status.indexOf(0, offset); if (end === -1) throw new Error("malformed_status");
    const entry = status.subarray(offset, end); offset = end + 1;
    if (!entry.length) continue;
    const type = String.fromCharCode(entry[0]);
    if (type === "u") throw new Error("conflict");
    if (type === "?" || type === "!") {
      if (entry[1] !== 0x20 || entry.length === 2) throw new Error("malformed_status");
      records.push({ normalized: type, paths: [entry.subarray(2)], ignored: type === "!" });
      continue;
    }
    if (type !== "1" && type !== "2") throw new Error("unsafe_status");
    const pathOffset = afterSpaces(entry, type === "1" ? 8 : 9), path = entry.subarray(pathOffset);
    if (!path.length) throw new Error("malformed_status");
    const paths = [path];
    if (type === "2") { const originEnd = status.indexOf(0, offset); if (originEnd === -1 || originEnd === offset) throw new Error("malformed_status"); paths.push(status.subarray(offset, originEnd)); offset = originEnd + 1; }
    records.push({ normalized: entry.subarray(0, pathOffset).toString("ascii").trimEnd(), paths });
  }
  return records;
};

// The optional dependency injection keeps plugin tests deterministic; production uses git directly.
export const workspaceFingerprint = async ({ repository, agent, model, policyVersion }, { runProcess = nativeRun } = {}) => {
  try {
    if (!repository || !agent || !model || !policyVersion) return { cacheable: false, fingerprint: null, reason: "invalid_input" };
    const requested = await realpath(repository);
    if ((await git(runProcess, requested, ["rev-parse", "--is-inside-work-tree"])).toString().trim() !== "true") throw new Error("not_worktree");
    const root = await realpath((await git(runProcess, requested, ["rev-parse", "--show-toplevel"])).toString().trim());
    const head = await git(runProcess, root, ["rev-parse", "HEAD"]), status = parseStatus(await git(runProcess, root, ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none", "--renames"]));
    const files = [], seen = new Set(); let totalBytes = 0, ignoredFiles = 0, ignoredBytes = 0;
    const addPath = async (rawName, ignored = false) => {
      const name = rawName.toString("utf8"), nameHash = hash(rawName);
      if (!rawName.equals(Buffer.from(name, "utf8")) || !inside(root, name)) throw new Error("unsafe_path");
      if (seen.has(nameHash)) return;
      seen.add(nameHash);
      const absolute = resolve(root, name); let info;
      try { info = await lstat(absolute); } catch (error) { if (error?.code === "ENOENT") { files.push([nameHash, "deleted"]); return; } throw error; }
      if (protectedPath(root, absolute)) throw new Error("unsafe_path");
      if (!info.isSymbolicLink() && !within(root, await realpath(absolute))) throw new Error("repo_escape");
      if (info.isSymbolicLink()) { const target = await readlink(absolute); if (Buffer.byteLength(target) > MAX_LINK_BYTES) throw new Error("symlink_too_large"); if (!within(root, resolve(absolute, "..", target))) throw new Error("repo_escape"); try { if (!within(root, await realpath(absolute))) throw new Error("repo_escape"); } catch (error) { if (error?.code !== "ENOENT") throw error; } if (ignored && ++ignoredFiles > MAX_FILES) throw new Error("too_many_ignored_files"); files.push([nameHash, "link", hash(target)]); }
      else if (info.isFile()) { if (ignored) { if (++ignoredFiles > MAX_FILES) throw new Error("too_many_ignored_files"); ignoredBytes += info.size; if (info.size > MAX_FILE_BYTES || ignoredBytes > MAX_TOTAL_BYTES) throw new Error("too_many_ignored_bytes"); } else { if (info.size > MAX_FILE_BYTES) throw new Error("file_too_large"); totalBytes += info.size; if (totalBytes > MAX_TOTAL_BYTES) throw new Error("too_many_bytes"); } files.push([nameHash, "file", hash(await readFile(absolute))]); }
      else if (info.isDirectory() && ignored) { if (!within(root, await realpath(absolute))) throw new Error("repo_escape"); const directoryName = name.endsWith("/") ? name.slice(0, -1) : name; for (const entry of await readdir(absolute, { withFileTypes: true })) await addPath(Buffer.from(`${directoryName}/${entry.name}`), true); }
      else if (info.isDirectory()) throw new Error("submodule_unsupported");
      else throw new Error("unsafe_file");
    };
    if (status.filter((record) => !record.ignored).flatMap((record) => record.paths).length > MAX_FILES) throw new Error("too_many_files");
    for (const record of status) for (const rawName of record.paths) await addPath(rawName, record.ignored);
    files.sort((left, right) => left[0].localeCompare(right[0]));
    const normalizedStatus = status.map((record) => ({ record: record.normalized, paths: record.paths.map(hash) }));
    const implementation = hash(`${new URL(import.meta.url).pathname}|read-cache-v2`);
    return { cacheable: true, fingerprint: hash(JSON.stringify({ repository: hash(root), head: head.toString().trim(), status: normalizedStatus, files, agent, model, policyVersion, implementation })), reason: null };
  } catch (error) { return { cacheable: false, fingerprint: null, reason: String(error?.message || "git_or_read_error").replace(/[^a-z0-9_]/gi, "_").slice(0, 80) || "git_or_read_error" }; }
};
