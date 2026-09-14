import { spawn } from "node:child_process";

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 900;
const TERM_GRACE_MS = 250;
export const DEFAULT_MAX_TAIL_BYTES = 1024 * 1024;
const maxTailBytes = (value) => Math.max(1024, Math.min(Number(value) || DEFAULT_MAX_TAIL_BYTES, 64 * 1024 * 1024));

const boundedTimeout = (value) => {
  const seconds = Number(value ?? DEFAULT_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_TIMEOUT_SECONDS * 1000;
  return Math.min(seconds, MAX_TIMEOUT_SECONDS) * 1000;
};

export const runProcessAsync = (file, args, options = {}) => new Promise((resolve) => {
  const { signal, timeout, timeoutMs, timeoutSeconds, onProgress, maxTailBytes: configuredMaxTailBytes, ...spawnOptions } = options;
  const child = spawn(file, args, {
    ...spawnOptions,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const limit = maxTailBytes(configuredMaxTailBytes ?? process.env.OPENAI_PROCESS_MAX_TAIL_BYTES);
  let stdout = "", stderr = "";
  let stdoutBytes = 0, stderrBytes = 0, stdoutTruncated = false, stderrTruncated = false;
  const retainTail = (value, chunk, stream) => {
    const bytes = Buffer.from(value + chunk, "utf8");
    const truncated = bytes.length > limit;
    const tail = truncated ? bytes.subarray(bytes.length - limit) : bytes;
    if (stream === "stdout") { stdoutBytes += Buffer.byteLength(chunk); stdoutTruncated ||= truncated; return tail.toString("utf8"); }
    stderrBytes += Buffer.byteLength(chunk); stderrTruncated ||= truncated; return tail.toString("utf8");
  };
  let settled = false;
  let terminationKind = null;
  let terminationPromise = null;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    resolve({ ...result, kind: terminationKind || result.kind || "completed", stdout, stderr, output: { stdout_bytes: stdoutBytes, stderr_bytes: stderrBytes, stdout_truncated: stdoutTruncated, stderr_truncated: stderrTruncated, max_tail_bytes: limit } });
  };
  const finishAfterTermination = (result) => {
    if (terminationPromise) terminationPromise.then(() => finish(result));
    else finish(result);
  };
  const detachPipes = () => {
    for (const stream of [child.stdout, child.stderr]) {
      try { stream?.removeAllListeners("data"); stream?.destroy(); } catch {}
    }
  };
  const killGroup = (kind) => {
    if (terminationPromise || !child.pid) return;
    terminationKind = kind;
    terminationPromise = (async () => {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { process.kill(child.pid, "SIGTERM"); } catch {} }
      await new Promise((resolve) => setTimeout(resolve, TERM_GRACE_MS));
      try {
        process.kill(-child.pid, 0);
        process.kill(-child.pid, "SIGKILL");
      } catch { try { process.kill(child.pid, "SIGKILL"); } catch {} }
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (kind === "timeout" || kind === "aborted") {
        detachPipes();
        finish({ status: null, signal: "SIGKILL", kind, timeout_bounded: kind === "timeout", descendants_unknown: true, termination_uncertain: true, fallback_eligible: false });
      }
    })();
  };
  const onAbort = () => killGroup("aborted");
  const readOutput = (stream, chunk) => {
    const text = String(chunk);
    if (stream === "stdout") stdout = retainTail(stdout, text, stream);
    else stderr = retainTail(stderr, text, stream);
    onProgress?.({ stream, bytes: Buffer.byteLength(text), lines: text.split(/\r?\n/).length - 1 });
  };
  child.stdout?.on("data", (chunk) => readOutput("stdout", chunk));
  child.stderr?.on("data", (chunk) => readOutput("stderr", chunk));
  child.once("error", (error) => finishAfterTermination({ status: null, signal: null, kind: "spawn_error", error: String(error) }));
  child.once("close", (status, childSignal) => finishAfterTermination({ status, signal: childSignal }));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  const requestedTimeout = timeoutMs == null
    ? (timeout == null ? boundedTimeout(timeoutSeconds) : Number(timeout))
    : Number(timeoutMs);
  const effectiveTimeoutMs = Number.isFinite(requestedTimeout)
    ? Math.min(Math.max(requestedTimeout, 1), MAX_TIMEOUT_SECONDS * 1000)
    : DEFAULT_TIMEOUT_SECONDS * 1000;
  const timeoutTimer = setTimeout(() => killGroup("timeout"), effectiveTimeoutMs);
  child.once("close", () => {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener?.("abort", onAbort);
  });
});
