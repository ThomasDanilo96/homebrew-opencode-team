import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));

const capability = join(
  here,
  "../teams/openai/bin/opencode-team-local-commit",
);

const lane = join(
  here,
  "../teams/openai/bin/codex-lane.sh",
);

const git = (repository, args) => spawnSync(
  "git",
  args,
  {
    cwd: repository,
    encoding: "utf8",
  },
);

const setupRepository = async () => {
  const repository = await mkdtemp(
    join(tmpdir(), "local-commit-capability-"),
  );

  assert.equal(
    git(repository, ["init", "-q"]).status,
    0,
  );

  assert.equal(
    git(
      repository,
      ["config", "user.email", "test@example.invalid"],
    ).status,
    0,
  );

  assert.equal(
    git(
      repository,
      ["config", "user.name", "Local Commit Test"],
    ).status,
    0,
  );

  await writeFile(
    join(repository, "fixture.txt"),
    "before\n",
  );

  assert.equal(
    git(repository, ["add", "fixture.txt"]).status,
    0,
  );

  assert.equal(
    git(
      repository,
      ["commit", "-qm", "baseline"],
    ).status,
    0,
  );

  return repository;
};

test("bounded local commit capability commits all current changes and leaves the repository clean", async () => {
  const repository = await setupRepository();

  try {
    await chmod(capability, 0o700);

    const before = git(
      repository,
      ["rev-parse", "HEAD"],
    ).stdout.trim();

    await writeFile(
      join(repository, "fixture.txt"),
      "after\n",
    );

    await writeFile(
      join(repository, "new.txt"),
      "new\n",
    );

    const result = spawnSync(
      capability,
      ["Update fixture"],
      {
        cwd: repository,
        env: {
          ...process.env,
          OPENAI_REPOSITORY_PATH: repository,
        },
        encoding: "utf8",
      },
    );

    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout,
    );

    const after = git(
      repository,
      ["rev-parse", "HEAD"],
    ).stdout.trim();

    assert.notEqual(
      after,
      before,
    );

    assert.equal(
      git(
        repository,
        ["status", "--porcelain=v1"],
      ).stdout,
      "",
    );

    assert.equal(
      git(
        repository,
        ["log", "-1", "--pretty=%s"],
      ).stdout.trim(),
      "Update fixture",
    );

    const payload = JSON.parse(
      result.stdout.trim().split("\n").at(-1),
    );

    assert.equal(
      payload.code,
      "LOCAL_COMMIT_SUCCESS",
    );

    assert.equal(
      payload.committed,
      true,
    );

    assert.equal(
      payload.head_before,
      before,
    );

    assert.equal(
      payload.head_after,
      after,
    );
  } finally {
    await rm(
      repository,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("bounded local commit capability is a no-op for a clean repository", async () => {
  const repository = await setupRepository();

  try {
    const before = git(
      repository,
      ["rev-parse", "HEAD"],
    ).stdout.trim();

    const result = spawnSync(
      capability,
      ["Should not exist"],
      {
        cwd: repository,
        env: {
          ...process.env,
          OPENAI_REPOSITORY_PATH: repository,
        },
        encoding: "utf8",
      },
    );

    assert.equal(
      result.status,
      0,
      result.stderr || result.stdout,
    );

    const payload = JSON.parse(
      result.stdout.trim(),
    );

    assert.equal(
      payload.code,
      "LOCAL_COMMIT_NOTHING_TO_COMMIT",
    );

    assert.equal(
      payload.committed,
      false,
    );

    assert.equal(
      git(
        repository,
        ["rev-parse", "HEAD"],
      ).stdout.trim(),
      before,
    );
  } finally {
    await rm(
      repository,
      {
        recursive: true,
        force: true,
      },
    );
  }
});


test("bounded local commit capability respects repository commit hooks", async () => {
  const repository = await setupRepository();

  try {
    const before = git(
      repository,
      ["rev-parse", "HEAD"],
    ).stdout.trim();

    await writeFile(
      join(repository, "fixture.txt"),
      "hook should reject this\n",
    );

    const hook = join(
      repository,
      ".git",
      "hooks",
      "pre-commit",
    );

    await writeFile(
      hook,
      "#!/bin/sh\necho hook-rejected >&2\nexit 1\n",
    );

    await chmod(
      hook,
      0o700,
    );

    const result = spawnSync(
      capability,
      ["Must be rejected"],
      {
        cwd: repository,
        env: {
          ...process.env,
          OPENAI_REPOSITORY_PATH: repository,
        },
        encoding: "utf8",
      },
    );

    assert.notEqual(
      result.status,
      0,
      "commit unexpectedly bypassed the repository hook",
    );

    assert.match(
      result.stderr,
      /hook-rejected/,
    );

    assert.equal(
      git(
        repository,
        ["rev-parse", "HEAD"],
      ).stdout.trim(),
      before,
    );

    assert.notEqual(
      git(
        repository,
        ["status", "--porcelain=v1"],
      ).stdout.trim(),
      "",
    );
  } finally {
    await rm(
      repository,
      {
        recursive: true,
        force: true,
      },
    );
  }
});

test("Codex local commit policy is private and forbids direct remote Git operations", async () => {
  const source = await readFile(
    lane,
    "utf8",
  );

  assert.match(
    source,
    /OPENAI_CODEX_LOCAL_COMMIT/,
  );

  assert.match(
    source,
    /pattern = \["opencode-team-local-commit"\],[\s\S]*?decision = "allow"/,
  );

  for (const command of [
    "add",
    "commit",
    "push",
    "fetch",
    "pull",
  ]) {
    assert.equal(
      source.includes(
        `pattern = ["git", "${command}"],`,
      ),
      true,
      `missing forbidden Git rule for ${command}`,
    );
  }

  assert.equal(
    (source.match(/decision = "forbidden"/g) ?? []).length >= 5,
    true,
    "all direct Git mutation/remote rules must remain forbidden",
  );

  assert.match(
    source,
    /codex_home\/rules\/default\.rules/,
  );

  assert.match(
    source,
    /codex_home\/bin\/opencode-team-local-commit/,
  );

  const helper = await readFile(
    capability,
    "utf8",
  );

  assert.doesNotMatch(
    helper,
    /core\.hooksPath|commit\.gpgsign|--no-gpg-sign/,
  );

  assert.doesNotMatch(
    helper,
    /\bgit\s+push\b/,
  );

  assert.doesNotMatch(
    helper,
    /\bgit\s+fetch\b/,
  );

  assert.doesNotMatch(
    helper,
    /\bgit\s+pull\b/,
  );
});
