import test from "node:test";
import assert from "node:assert/strict";
import { validCodexHandoff } from "../teams/openai/config/opencode/openai-handoff.js";

const baseHandoff = (overrides = {}) => ({
  schema_version: 3,
  invocation_id: "123e4567-e89b-42d3-a456-426614174000",
  codex_run_id: "codex-run-123",
  thread_id: "thread-123",
  parent_codex_run_id: null,
  model: "gpt-6-luna",
  profile: "standard",
  requested_model: "gpt-6-luna",
  executed_model: "gpt-6-luna",
  fallback_model: null,
  fallback_reason: null,
  fallback_count: 0,
  fallback_eligible: false,
  cooldown_seconds: 0,
  resume_count: 0,
  attempt: 1,
  exit_status: 143,
  reason: "aborted",
  provider_failure: 0,
  mutation_count: 1,
  journal_incomplete: true,
  termination_sealed: false,
  journal_scan_complete: false,
  sealed_run_id: null,
  sealed_lease_id: null,
  token_usage: {
    input_tokens: 0,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 0,
    reasoning_tokens: 0,
    total_tokens: 0,
  },
  ...overrides,
});

test("handoff accepts unsealed side-effect evidence without sealed identifiers", () => {
  assert.equal(validCodexHandoff(baseHandoff()), true);
});

test("handoff requires matching sealed identifiers for sealed evidence", () => {
  assert.equal(validCodexHandoff(baseHandoff({
    mutation_count: 0,
    journal_incomplete: false,
    termination_sealed: true,
    journal_scan_complete: true,
    sealed_run_id: "codex-run-123",
  })), true);
  assert.equal(validCodexHandoff(baseHandoff({
    termination_sealed: false,
    sealed_run_id: "codex-run-123",
  })), false);
});
