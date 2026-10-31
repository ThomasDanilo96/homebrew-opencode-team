// tests/best-claude-handoff.test.mjs — deterministic, mock-only
// Invariants for the optional, manual Claude Code handoff.
//
// The handoff is deliberately NOT an OpenCode route: Anthropic prohibits
// routing a Claude subscription through a third-party harness, so Claude must
// never appear as an OpenCode model, agent or provider. These tests assert
// that boundary statically, without any model call.
import './guardrail/assert-isolated.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(root, 'best-routing-config.json'), 'utf8'));
const availability = JSON.parse(fs.readFileSync(path.join(root, 'best-routing-availability.json'), 'utf8'));
const instructions = fs.readFileSync(path.join(root, 'best-handoff-instructions.md'), 'utf8');

const CLAUDE_MODEL = /claude|anthropic|haiku|opus|sonnet|fable|mythos/i;

test('no OpenCode route can reach Claude through any provider', () => {
  for (const [name, agent] of Object.entries(config.agents)) {
    assert.ok(!CLAUDE_MODEL.test(agent.model || ''), `agent ${name} routes to Claude`);
  }
  for (const [name, command] of Object.entries(config.commands)) {
    assert.ok(!CLAUDE_MODEL.test(command.model || ''), `command ${name} routes to Claude`);
  }
  for (const model of availability.models) {
    assert.ok(!CLAUDE_MODEL.test(model), `availability exposes Claude model ${model}`);
  }
  const providers = Object.keys(config.providers || {});
  for (const provider of providers) {
    assert.ok(!CLAUDE_MODEL.test(provider), `provider ${provider} is a Claude provider`);
  }
  assert.deepEqual(
    config.policies.filter(p => p.action === 'provider.use').map(p => p.resource).sort(),
    ['*', 'openai', 'opencode-go'],
    'provider policy must stay closed to any other provider',
  );
});

test('visual routing keeps GLM primary and MiniMax M3 fallback on Go', () => {
  assert.equal(config.agents['visual-designer'].model, 'opencode-go/glm-5.3-flash');
  assert.equal(config.commands.visual.model, 'opencode-go/glm-5.3-flash');
  assert.equal(config.commands.visualFallback.model, 'opencode-go/minimax-m3');
  assert.equal(config.commands.visual.agent, 'visual-designer');
  assert.equal(config.commands.visualFallback.agent, 'visual-designer');
  for (const name of ['visual', 'visualFallback']) {
    assert.equal(config.commands[name].subagent, false);
  }
});

test('the manual handoff is documented as manual and never automatic', () => {
  assert.match(instructions, /manual/i, 'handoff must be documented as manual');
  assert.match(instructions, /never automatic|never an automatic/i,
    'handoff must state it is never an automatic route');
  // The prohibition is on routing a subscription through a third-party harness.
  assert.match(instructions, /prohibit/i, 'handoff must cite the third-party prohibition');
  // Subscription safety: the API-key environment variables outrank the
  // subscription credential and would silently switch to metered billing.
  for (const variable of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
    assert.ok(instructions.includes(variable), `handoff must forbid ${variable}`);
  }
  assert.match(instructions, /--bare/, 'handoff must forbid --bare (needs an API key)');
  assert.match(instructions, /setup-token|CLAUDE_CODE_OAUTH_TOKEN/,
    'handoff must forbid long-lived OAuth token export');
  assert.match(instructions, /frontend-design/, 'handoff must reuse the frontend-design skill');
  assert.match(instructions, /official/i, 'handoff must use the official Claude binary');
});

test('the handoff stays outside OpenCode: no token, plugin or proxy surface', () => {
  // Instructions may name the CLI, but must not add an OpenCode-side
  // credential, plugin or provider for Claude.
  assert.ok(!CLAUDE_MODEL.test(JSON.stringify(config.providers || {})),
    'no Claude provider block may be configured');
  assert.ok(!CLAUDE_MODEL.test(JSON.stringify(config.mcp?.servers || {})),
    'no Claude MCP server may be configured');
  assert.ok(!CLAUDE_MODEL.test(JSON.stringify(config.plugins || [])),
    'no Claude plugin may be configured');
  assert.ok(!CLAUDE_MODEL.test(JSON.stringify(config.auth || {})),
    'no Claude credential may be configured');
});
