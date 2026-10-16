import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import test from "node:test";
import { calculateTotal } from "./calculator.js";

test("intentional logic defect is detected", () => {
  assert.equal(calculateTotal(), 7);
});

test("container root filesystem is read-only and host HOME is absent", () => {
  assert.throws(() => fs.writeFileSync("/etc/deep-audit-escape-probe", "escape"));
  assert.throws(() => fs.writeFileSync("/snapshot/calculator.js", "escape"));
  assert.equal(process.env.HOME, "/home/audit");
  assert.equal(fs.existsSync("/var/run/docker.sock"), false);
  assert.equal(fs.existsSync("/Users/thomasd/.ssh"), false);
});

test("container security limits and privilege restrictions are active", () => {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  assert.equal(BigInt(`0x${status.match(/^CapEff:\s*([0-9a-f]+)$/m)?.[1]}`), 0n);
  assert.match(status, /^NoNewPrivs:\s+1$/m);
  assert.equal(Number(fs.readFileSync("/sys/fs/cgroup/pids.max", "utf8").trim()), 96);
  assert.ok(Number(fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim()) <= 2 * 1024 ** 3);
  const [quota, period] = fs.readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/).map(Number);
  assert.ok(quota / period <= 2);
  const workspace = fs.statfsSync("/workspace");
  assert.ok(workspace.blocks * workspace.bsize <= 2 * 1024 ** 3 + workspace.bsize);
});

test("container network is disabled", async () => {
  await new Promise((resolve, reject) => {
    const client = net.connect({ host: "1.1.1.1", port: 443 });
    client.setTimeout(1000);
    client.once("connect", () => { client.destroy(); reject(new Error("container unexpectedly reached public network")); });
    client.once("error", resolve);
    client.once("timeout", () => { client.destroy(); resolve(); });
  });
});

test("container process limit stops excess child processes", async () => {
  const children = [];
  let exhausted = false;
  try {
    for (let index = 0; index < 160; index += 1) {
      const child = spawn("/bin/sleep", ["10"], { stdio: "ignore" });
      child.on("error", (error) => { if (error.code === "EAGAIN") exhausted = true; });
      children.push(child);
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(exhausted, true, "Docker pids-limit must reject excess process creation");
  } finally {
    for (const child of children) child.kill("SIGKILL");
  }
});
