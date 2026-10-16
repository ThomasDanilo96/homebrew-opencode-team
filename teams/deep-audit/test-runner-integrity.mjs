import { readdir, readFile, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

async function filesBelow(root) {
  const files = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) files.push(file);
    }
  }
  await walk(root);
  return files;
}

export async function fingerprint({ packageRoot, renderedPlugin, imagesManifest }) {
  const files = [
    ...await filesBelow(path.join(packageRoot, "teams/deep-audit/test-runners")),
    ...await filesBelow(path.join(packageRoot, "tests/fixtures/deep-audit-test-runner")),
    path.join(packageRoot, "teams/deep-audit/test-runner-plugin.mjs.template"),
    path.join(packageRoot, "teams/deep-audit/test-runner-integrity.mjs"),
    path.join(packageRoot, "teams/deep-audit/setup-test-runners.sh"),
    path.join(packageRoot, "teams/deep-audit/bin/test-runner-health.mjs"),
    path.join(packageRoot, "tests/deep-audit-test-runner.e2e.mjs"),
    renderedPlugin,
    imagesManifest,
  ].map((file) => path.resolve(file)).sort();
  const hash = createHash("sha256");
  for (const file of files) {
    const canonical = await realpath(file);
    hash.update(path.relative(packageRoot, file)).update("\0").update(await readFile(canonical)).update("\0");
  }
  return hash.digest("hex");
}
