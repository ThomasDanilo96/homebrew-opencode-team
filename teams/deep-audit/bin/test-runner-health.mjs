import { readFile, realpath } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fingerprint } from "../test-runner-integrity.mjs";

const [packageRoot, pluginPath, imagesPath, markerPath, dockerPath] = process.argv.slice(2);
if (![packageRoot, pluginPath, imagesPath, markerPath, dockerPath].every(Boolean)) process.exit(2);
try {
  const canonicalDocker = await realpath(dockerPath);
  if (!["/usr/local/bin/", "/usr/local/Cellar/", "/opt/homebrew/bin/", "/opt/homebrew/Cellar/", "/Applications/Docker.app/Contents/Resources/bin/"].some((prefix) => canonicalDocker.startsWith(prefix))) throw new Error("Docker CLI is outside trusted install paths");
  const [marker, manifest] = await Promise.all([
    readFile(markerPath, "utf8").then((value) => JSON.parse(value)),
    readFile(imagesPath, "utf8").then((value) => JSON.parse(value)),
  ]);
  if (marker.schema_version !== 1 || marker.fingerprint !== await fingerprint({ packageRoot, renderedPlugin: pluginPath, imagesManifest: imagesPath })) throw new Error("runner validation is stale");
  const info = spawnSync(canonicalDocker, ["info", "--format", "{{.OSType}}|{{.Architecture}}|{{.OperatingSystem}}|{{json .SecurityOptions}}"], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" } });
  if (info.status !== 0) throw new Error("local Linux Docker Engine is unavailable");
  const [osType, architecture, operatingSystem, securityOptions] = info.stdout.trim().split("|");
  if (osType !== "linux" || !["aarch64", "arm64", "x86_64", "amd64"].includes(architecture)) throw new Error("unsupported Docker host platform");
  if (process.platform === "darwin" ? operatingSystem !== "Docker Desktop" : !/(rootless|userns)/i.test(securityOptions ?? "")) throw new Error("Docker VM/rootless isolation boundary is missing");
  const context = spawnSync(canonicalDocker, ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" } });
  if (context.status !== 0 || !/^unix:\/\//.test(context.stdout.trim())) throw new Error("remote Docker contexts are refused");
  for (const name of ["node", "python", "php"]) {
    const image = manifest[name];
    if (!image?.reference || !image?.image_id || marker.images?.[name] !== image.image_id) throw new Error(`validated ${name} image id is stale`);
    const inspected = spawnSync(canonicalDocker, ["image", "inspect", "--format", "{{.Id}}", image.image_id], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" } });
    if (inspected.status !== 0 || inspected.stdout.trim() !== image.image_id) throw new Error(`validated ${name} image changed`);
  }
  const stale = spawnSync(canonicalDocker, ["ps", "-aq", "--filter", "label=org.opencode-team.deep-audit-test=true"], { encoding: "utf8", timeout: 10_000, env: { PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin" } });
  if (stale.status !== 0 || stale.stdout.trim()) throw new Error("a previous isolated test container was not cleaned up");
  process.stdout.write(`OK (fixture E2E verified; fingerprint ${marker.fingerprint.slice(0, 12)})\n`);
} catch (error) {
  process.stderr.write(`BLOCKED (${error.message})\n`);
  process.exit(1);
}
