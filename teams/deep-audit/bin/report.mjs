#!/usr/bin/env node
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const root = process.env.DEEP_AUDIT_REPORT_ROOT;
const [command = "help", auditID] = process.argv.slice(2);
const usage = "Usage: opencode-team deep-audit-report <list|latest|show ID>";

if (!root || !path.isAbsolute(root)) {
  console.error("Deep Audit report root is not configured.");
  process.exit(1);
}

let realRoot;
try {
  realRoot = await realpath(root);
} catch {
  console.error("No Deep Audit reports exist yet.");
  process.exit(1);
}

const safeID = (value) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value || "");
const entries = (await readdir(realRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && safeID(entry.name))
  .map((entry) => entry.name)
  .sort();

if (command === "list") {
  console.log(entries.length ? entries.join("\n") : "No Deep Audit reports exist yet.");
} else if (command === "latest") {
  if (!entries.length) {
    console.error("No Deep Audit reports exist yet.");
    process.exit(1);
  }
  console.log(path.join(realRoot, entries.at(-1)));
} else if (command === "show") {
  if (!safeID(auditID)) {
    console.error(usage);
    process.exit(2);
  }
  const directory = path.join(realRoot, auditID);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    console.error("Audit report entry is not a real directory.");
    process.exit(1);
  }
  const realDirectory = await realpath(directory);
  if (!realDirectory.startsWith(`${realRoot}${path.sep}`)) {
    console.error("Audit report path escaped its report root.");
    process.exit(1);
  }
  const manifest = JSON.parse(await readFile(path.join(realDirectory, "execution-manifest.json"), "utf8"));
  console.log(JSON.stringify(manifest, null, 2));
  console.log(await readFile(path.join(realDirectory, "00_EXECUTIVE_SUMMARY.md"), "utf8"));
  console.log(await readFile(path.join(realDirectory, "findings.json"), "utf8"));
} else {
  console.log(usage);
}
