import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

test("admissions retain reservations when owner start checks use different locales", async () => {
  const stateRoot = await mkdtemp(join(tmpdir(), "openai-admit-"));
  const fakeBin = join(stateRoot, "bin");
  await mkdir(fakeBin);
  await writeFile(join(fakeBin, "ps"), "#!/bin/sh\nif [ \"$LC_ALL\" = C ]; then printf '%s\\n' 'Mon Jan 01 00:00:00 2024'; else printf '%s\\n' 'Tue Jan 02 00:00:00 2024'; fi\n");
  await chmod(join(fakeBin, "ps"), 0o755);
  const script = join(process.cwd(), "teams/openai/bin/openai-admit.sh");
  const baseEnv = { ...process.env, OPENAI_TEAM_STATE_ROOT: stateRoot, OPENAI_GLOBAL_BUDGET: "4", OPENAI_SYNTHETIC_TEST: "1", PATH: `${fakeBin}:${process.env.PATH}` };
  const admit = (locale, token) => new Promise((resolve, reject) => {
    const child = spawn(script, ["--owner-pid", String(process.pid), "test", "1", token], { env: { ...baseEnv, LC_ALL: locale } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });

  try {
    const results = await Promise.all(["first", "second", "third", "fourth"].map((token, index) => admit(index % 2 === 0 ? "C" : "POSIX", token)));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readdir(join(stateRoot, "active"))).filter((name) => name.endsWith(".json")).sort(), ["first.json", "fourth.json", "second.json", "third.json"]);
    const admissions = await readFile(join(stateRoot, "logs/admission.log"), "utf8");
    assert.deepEqual([...admissions.matchAll(/event=admit timestamp=\d+ role=test classification=reservation global=(\d+)/g)].map((match) => Number(match[1])).sort((a, b) => a - b), [1, 2, 3, 4]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});
