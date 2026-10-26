import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

const packageRoot = path.resolve(import.meta.dirname, '..');
const profiles = ['best', 'free'];
const home = process.env.HOME;
if (!home) throw new Error('HOME is required');
const teamHome = process.env.OPENCODE_TEAM_HOME;
const roots = Object.fromEntries(['config', 'data', 'state', 'cache'].map((kind) => [kind,
  path.resolve(teamHome ? path.join(teamHome, kind) : path.join(home,
    { config: '.config', data: '.local/share', state: '.local/state', cache: '.cache' }[kind], 'opencode-team'))]));
const dependencyRoot = path.resolve(process.env.OPENCODE_TEAM_DEPENDENCY_ROOT || path.join(roots.data, 'dependencies'));
const eccPin = fs.readFileSync(path.join(packageRoot, 'shared/ecc.lock'), 'utf8').trim();
const legacySerena = path.join(roots.data, 'bin/serena');
const serenaBin = !process.env.OPENCODE_TEAM_DEPENDENCY_ROOT && fs.existsSync(legacySerena)
  ? legacySerena : path.join(dependencyRoot, 'bin/serena');
const eccSource = path.resolve(process.env.OPENCODE_TEAM_ECC_SOURCE || path.join(dependencyRoot, `ecc-${eccPin}`));
const freeID = 'mimo-v2.6-flash-free';
const freeModel = `team-free/${freeID}`;
const configFile = (profile) => path.join(roots.config, profile, 'opencode.jsonc');
const instructionFile = (profile) => path.join(roots.config, profile, 'v2/AGENTS.md');
const sharedRulesFile = path.resolve(process.env.OPENCODE_TEAM_RULES_FILE || path.join(home, '.config/opencode/AGENTS.md'));
const managed = profiles.flatMap((p) => [configFile(p), instructionFile(p)]);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const fail = (message) => { throw new Error(message); };

// Reject links in every existing ancestor, including dangling links. Never walk
// historical profile trees recursively: only boundaries used by native V2.
function safe(file, directory = false) {
  const absolute = path.resolve(file);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (stat.isSymbolicLink()) fail(`Refusing symlink: ${current}`);
    if (current !== absolute && !stat.isDirectory()) fail(`Not a directory: ${current}`);
    if (current === absolute && (directory ? !stat.isDirectory() : !stat.isFile())) fail(`Unexpected path type: ${current}`);
  }
}
function mkdir(directory) {
  safe(directory, true);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
function preflight() {
  for (const directory of [...Object.values(roots), dependencyRoot]) safe(directory, true);
  for (const p of profiles) {
    for (const directory of [path.join(roots.config, p, 'v2/xdg-config/opencode'),
      path.join(roots.data, p, 'data/opencode'), path.join(roots.state, p), path.join(roots.cache, p)]) safe(directory, true);
    for (const file of [configFile(p), instructionFile(p), ...['auth.json', 'opencode.db', 'opencode.db-wal', 'opencode.db-shm'].map((f) => path.join(roots.data, p, 'data/opencode', f))]) safe(file);
  }
  safe(path.join(roots.config, 'backups'), true);
  safe(path.join(roots.config, '.pending'));
}
function profileEnvironment(profile) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(OPENCODE_|XDG_|CLAUDE_CONFIG_DIR|SERENA_HOME)/.test(key)) delete env[key];
    // Connections belong to the profile, never the calling shell's paid account.
    if (/(?:KEY|TOKEN|SECRET|AUTH|CREDENTIAL)|^(AWS_|AZURE_|GOOGLE_|GCP_|GCLOUD_)/i.test(key)) delete env[key];
  }
  if (profile === 'best') {
    env.PATH = [path.join(roots.data, 'best/bin'),
      path.join(roots.data, 'best/quality/node_modules/.bin'), env.PATH].filter(Boolean).join(path.delimiter);
    env.npm_config_cache = path.join(roots.cache, 'best/npm');
    env.CTX7_TELEMETRY_DISABLED = '1';
  }
  return { ...env, XDG_CONFIG_HOME: path.join(roots.config, profile, 'v2/xdg-config'),
    XDG_DATA_HOME: path.join(roots.data, profile, 'data'), XDG_STATE_HOME: path.join(roots.state, profile),
    XDG_CACHE_HOME: path.join(roots.cache, profile), OPENCODE_CONFIG: configFile(profile),
    OPENCODE_CONFIG_DIR: path.join(roots.config, profile, 'v2'),
    SERENA_HOME: path.join(roots.state, profile, 'serena') };
}
function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, { encoding: 'utf8', timeout: 180000, ...options });
  if (result.error || result.status !== 0) fail(`${path.basename(executable)} ${args[0]} failed: ${result.error?.message || result.stderr || result.status}`);
  return result.stdout.trim();
}
function nativeBinary() {
  const override = process.env.OPENCODE_TEAM_OPENCODE_BIN;
  if (override && !path.isAbsolute(override)) fail('OPENCODE_TEAM_OPENCODE_BIN must be an absolute executable path');
  // BEST's private tools remain on the child PATH, but must never select the
  // native runtime (including a historical retention fork) for either profile.
  const privateBins = profiles.flatMap((p) => ['bin', 'quality/node_modules/.bin'].map((bin) => {
    const directory = path.join(roots.data, p, bin);
    return fs.existsSync(directory) ? fs.realpathSync(directory) : directory;
  }));
  const binary = override || (process.env.PATH || '').split(path.delimiter).map((directory) => {
    const candidate = path.resolve(directory, 'opencode');
    try {
      if (privateBins.includes(fs.realpathSync(path.dirname(candidate)))) return;
      const resolved = fs.realpathSync(candidate);
      if (privateBins.some((bin) => resolved.startsWith(`${bin}${path.sep}`)) || !fs.statSync(resolved).isFile()) return;
      fs.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) throw error;
    }
  }).find(Boolean);
  if (!binary) fail('OpenCode V2 executable not found on caller PATH outside profile-owned bins; install official OpenCode or set OPENCODE_TEAM_OPENCODE_BIN');
  const version = command(binary, ['--version'], { env: profileEnvironment('best') });
  if (!/^(?:opencode\s+)?v?2\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) fail(`OpenCode V2 required; found ${version}. Install V2 yourself; no automatic replacement.`);
  return { binary, version };
}
function checkSerena() {
  // uv tool entrypoints may legitimately be symlinks into their managed venv.
  const version = command(serenaBin, ['--version']);
  if (!/(?:^|\s|,)1\.7\.0(?:\s|$)/.test(version)) fail(`Serena 1.7.0 required: ${version}`);
}
function checkECC() {
  safe(eccSource, true);
  for (const file of ['LICENSE', 'skills/tdd-workflow/SKILL.md']) safe(path.join(eccSource, file));
  if (!fs.existsSync(path.join(eccSource, 'skills/tdd-workflow/SKILL.md')) || !fs.existsSync(path.join(eccSource, 'LICENSE'))) fail('ECC skills or LICENSE missing');
  const actual = command('git', ['-C', eccSource, 'rev-parse', 'HEAD']);
  if (!process.env.OPENCODE_TEAM_ECC_SOURCE && actual !== eccPin) fail(`ECC pin mismatch: expected ${eccPin}`);
  if (command('git', ['-C', eccSource, 'status', '--porcelain'])) fail(`Refusing modified ECC source: ${eccSource}`);
  return actual;
}
function provision() {
  mkdir(dependencyRoot);
  if (!fs.existsSync(serenaBin)) {
    for (const directory of ['serena', 'bin', 'uv-cache', 'python']) mkdir(path.join(dependencyRoot, directory));
    command('uv', ['tool', 'install', '--python', '3.13', 'serena-agent==1.7.0'], {
      env: { ...process.env, UV_TOOL_DIR: path.join(dependencyRoot, 'serena'), UV_TOOL_BIN_DIR: path.join(dependencyRoot, 'bin'), UV_CACHE_DIR: path.join(dependencyRoot, 'uv-cache'), UV_PYTHON_INSTALL_DIR: path.join(dependencyRoot, 'python') },
    });
  }
  checkSerena();
  if (!fs.existsSync(eccSource) && !process.env.OPENCODE_TEAM_ECC_SOURCE) {
    const staging = fs.mkdtempSync(path.join(dependencyRoot, '.ecc-'));
    try {
      const gitOptions = { env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never',
        SSH_ASKPASS_REQUIRE: 'never', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o NumberOfPasswordPrompts=0 -o ConnectTimeout=15' } };
      command('git', ['-c', 'credential.interactive=false', 'clone', '--filter=blob:none', '--depth', '1', '--no-checkout', '--sparse', 'https://github.com/affaan-m/ECC.git', staging], gitOptions);
      command('git', ['-c', 'credential.interactive=false', '-C', staging, 'sparse-checkout', 'set', '--no-cone', '/skills/', '/LICENSE'], gitOptions);
      command('git', ['-c', 'credential.interactive=false', '-C', staging, 'fetch', '--depth', '1', 'origin', eccPin], gitOptions);
      command('git', ['-c', 'credential.interactive=false', '-C', staging, 'checkout', '--detach', eccPin], gitOptions);
      fs.renameSync(staging, eccSource);
    } finally { if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true }); }
  }
  const actual = checkECC();
  if (process.env.OPENCODE_TEAM_ECC_SOURCE) console.error(`Explicit local ECC source: ${eccSource} (${actual}; official pin ${eccPin})`);
}
const rule = (action, effect, resource = '*') => ({ action, resource, effect });
function readonlyPermissions(profile) {
  return [rule('*', 'deny'), ...['read', 'glob', 'grep', 'webfetch', 'websearch', 'skill', 'question',
    'serena_initial_instructions', 'serena_get_current_config', 'serena_get_symbols_overview', 'serena_find_symbol',
    'serena_find_declaration', 'serena_find_implementations', 'serena_find_referencing_symbols',
    'serena_get_diagnostics_for_file', 'serena_search_for_pattern', 'serena_list_dir', 'serena_find_file'].map((a) => rule(a, 'allow')),
  rule('external_directory', profile === 'best' ? 'allow' : 'ask'),
  rule('read', profile === 'best' ? 'deny' : 'ask', '*.env'),
  rule('read', profile === 'best' ? 'deny' : 'ask', '*.env.*'),
  ...(profile === 'best' ? [rule('read', 'allow', '*.env.example')] : [])];
}
function configuration(profile) {
  const bestModel = process.env.OPENCODE_TEAM_BEST_MODEL || 'openai/gpt-6.1-sol';
  const goModel = process.env.OPENCODE_TEAM_BEST_GO_MODEL || 'opencode-go/longcat-2.0';
  if (!/^openai\/[A-Za-z0-9][\w./-]*$/.test(bestModel)) fail('BEST coordinator model must be an openai/model ID without #variant');
  if (!/^opencode-go\/[A-Za-z0-9][\w./-]*$/.test(goModel)) fail('BEST worker model must be an opencode-go/model ID without #variant');
  if (process.env.OPENCODE_TEAM_FREE_MODEL && process.env.OPENCODE_TEAM_FREE_MODEL !== freeModel) fail(`FREE supports only ${freeModel}; no unverified paid models`);
  const model = profile === 'best' ? bestModel : freeModel;
  const agents = Object.fromEntries(['build', 'plan', 'explore', 'general', 'reviewer', 'title', 'summary', 'compaction'].map((id) => [id, { model }]));
  if (profile === 'best') {
    agents.build.model = `${bestModel}#low`;
    for (const id of ['plan', 'reviewer']) agents[id].model = `${bestModel}#medium`;
    agents.explore.model = 'opencode-go/mimo-v2.6-flash';
    agents.general.model = goModel;
    agents.title.model = 'openai/gpt-6-luna#low';
    // Worker selection must not replace the validated continuity model.
    for (const id of ['summary', 'compaction']) agents[id].model = 'opencode-go/minimax-m3';
    agents.general.description = 'Implement an independent, well-scoped task using Go; return focused changes and actual test results';
    agents.specialist = { model: `${bestModel}#medium`, mode: 'subagent',
      description: 'Complex scoped implementation or critical technical analysis with Sol Medium; preserve file ownership and return concise evidence',
      permissions: [rule('question', 'deny'), rule('subagent', 'deny')] };
  }
  for (const id of ['plan', 'explore', 'reviewer']) agents[id].permissions = readonlyPermissions(profile);
  agents.reviewer = { ...agents.reviewer, description: 'Review changes for correctness, security and regressions without editing',
    mode: 'subagent', system: 'Read-only review. Report verified findings with file references and missing regressions. Never mutate files or run shell commands.' };
  for (const id of ['title', 'summary', 'compaction']) agents[id].permissions = [rule('*', 'deny')];
  const instructions = [instructionFile(profile)];
  if (profile === 'best') {
    if (fs.existsSync(sharedRulesFile)) {
      if (!fs.statSync(sharedRulesFile).isFile()) fail(`Shared rules must be a file: ${sharedRulesFile}`);
      const source = fs.realpathSync(sharedRulesFile);
      if (managed.some((file) => fs.existsSync(file) && fs.realpathSync(file) === source)) fail('Shared rules must be outside generated profile files');
      instructions.unshift(sharedRulesFile);
    } else if (process.env.OPENCODE_TEAM_RULES_FILE) fail(`Shared rules not found: ${sharedRulesFile}`);
    else console.error(`BEST: ${sharedRulesFile} not found; using profile instructions only.`);
  }
  const config = { $schema: 'https://opencode.ai/config.json', model, default_agent: 'build', agents,
    policies: [rule('provider.use', 'deny'), ...(profile === 'best' ? ['opencode-go', 'openai'] : ['team-free']).map((provider) => rule('provider.use', 'allow', provider))],
    permissions: [rule('external_directory', profile === 'best' ? 'allow' : 'ask'),
      rule('shell', profile === 'best' ? 'allow' : 'ask'),
      ...(profile === 'best' ? [rule('read', 'deny', '*.env'), rule('read', 'deny', '*.env.*'),
        rule('read', 'allow', '*.env.example')] : [])],
    skills: [path.join(eccSource, 'skills'), ...(profile === 'best' ? [path.join(packageRoot, 'shared/skills')] : [])], instructions,
    mcp: { servers: { serena: { type: 'local', command: [serenaBin, 'start-mcp-server', '--context', 'ide', '--project-from-cwd', '--enable-web-dashboard', 'false', '--open-web-dashboard', 'false'],
      codemode: false, disabled: false, environment: { SERENA_HOME: path.join(roots.state, profile, 'serena') },
      timeout: { startup: 45000, catalog: 30000, execution: 600000 } } } } };
  if (profile === 'best') config.mcp.servers.playwright = {
    type: 'local',
    command: ['npx', '--yes', '@playwright/mcp@0.0.83', '--headless', '--isolated', '--browser', 'chromium', '--image-responses', 'omit', '--snapshot-mode', 'none', '--no-webmcp'],
  };
  // V2 drops the root variant; low must also be the model's native default.
  if (profile === 'best') config.providers = { openai: {
    models: { [bestModel.slice('openai/'.length)]: { settings: { reasoningEffort: 'low' } } },
  } };
  else config.providers = { 'team-free': {
    name: 'Team FREE (anonymous MiMo)', env: [], package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'https://opencode.ai/inference/openai/v1', apiKey: '' },
    // Explicitly blank authorization prevents historical accounts from paying.
    headers: { Authorization: '' }, models: { [freeID]: { modelID: freeID,
      capabilities: { tools: true, input: ['text'], output: ['text'] },
      limit: { context: 128000, output: 8192 }, cost: { input: 0, output: 0 } } },
  } };
  return config;
}
function atomicWrite(file, bytes) {
  safe(file);
  mkdir(path.dirname(file));
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, bytes, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
function readManifest(id) {
  if (!/^[\dT.Z-]+-[a-f0-9-]+$/.test(id)) fail('Invalid backup ID');
  const directory = path.join(roots.config, 'backups', id);
  safe(directory, true);
  safe(path.join(directory, 'manifest.json'));
  const entries = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
  if (!Array.isArray(entries) || entries.length > managed.length) fail('Invalid backup manifest');
  for (const entry of entries) {
    if (!managed.includes(path.join(roots.config, entry.path)) || typeof entry.existed !== 'boolean' || !/^\d+$/.test(entry.backup)) fail('Invalid backup entry');
    safe(path.join(directory, entry.backup));
  }
  return entries.map((entry) => ({ file: path.join(roots.config, entry.path), bytes: entry.existed ? fs.readFileSync(path.join(directory, entry.backup)) : null }));
}
function recover() {
  const pending = path.join(roots.config, '.pending');
  if (!fs.existsSync(pending)) return;
  const id = fs.readFileSync(pending, 'utf8').trim();
  for (const { file, bytes } of readManifest(id)) {
    if (bytes === null) { safe(file); if (fs.existsSync(file)) fs.unlinkSync(file); }
    else atomicWrite(file, bytes);
  }
  fs.unlinkSync(pending);
  console.error(`Recovered interrupted configuration transaction ${id}; credentials and databases untouched.`);
}
function transaction(updates) {
  const changed = updates.filter(({ file, bytes }) => {
    safe(file);
    return bytes === null ? fs.existsSync(file) : !fs.existsSync(file) || !fs.readFileSync(file).equals(Buffer.from(bytes));
  });
  if (!changed.length) return;
  const id = `${new Date().toISOString().replaceAll(':', '-')}-${crypto.randomUUID()}`;
  const directory = path.join(roots.config, 'backups', id);
  mkdir(directory);
  const entries = changed.map(({ file }, index) => {
    const existed = fs.existsSync(file);
    if (existed) fs.writeFileSync(path.join(directory, String(index)), fs.readFileSync(file), { mode: 0o600, flag: 'wx' });
    return { path: path.relative(roots.config, file), existed, backup: String(index) };
  });
  atomicWrite(path.join(directory, 'manifest.json'), json(entries));
  atomicWrite(path.join(roots.config, '.pending'), id);
  try {
    for (const { file, bytes } of changed) {
      if (bytes === null) fs.unlinkSync(file);
      else atomicWrite(file, bytes);
    }
    fs.unlinkSync(path.join(roots.config, '.pending'));
  } catch (error) { recover(); throw error; }
  if (!entries.some((entry) => entry.existed)) fs.rmSync(directory, { recursive: true });
  else console.log(`Configuration backup: ${id}`);
}
function locked(action) {
  mkdir(roots.config);
  const lock = path.join(roots.config, '.setup-lock');
  safe(lock);
  let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') fail(`Setup locked: ${lock}. If no setup is running, remove this lock and rerun setup to recover.`);
    throw error;
  }
  try { fs.writeFileSync(fd, String(process.pid)); recover(); action(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
function cleanup(action, automatic = false) {
  if (!['enable', 'disable', 'uninstall', 'status', 'dry-run'].includes(action)) fail('Expected cleanup enable, disable, uninstall, status or dry-run');
  if (process.platform !== 'darwin') { console.log('Cleanup skipped: macOS only.'); return; }
  if (action === 'dry-run') {
    console.log(command('/bin/zsh', [path.join(packageRoot, 'shared/disk-cleanup.sh'), '--safe-caches-only', '--dry-run']));
    return;
  }
  // launchctl targets the login user, not $HOME. Isolated setup fixtures must
  // never register jobs in that user's real GUI domain.
  if (path.resolve(home) !== path.resolve(os.userInfo().homedir) || (automatic && teamHome)) {
    if (automatic || action === 'status') { console.log('Cleanup not installed: custom HOME/root; scheduling skipped.'); return; }
    fail('Cleanup scheduling requires the login user HOME; custom OPENCODE_TEAM_HOME needs explicit cleanup enable');
  }
  const label = 'io.opencode-team.safe-caches';
  const plist = path.join(home, 'Library/LaunchAgents', `${label}.plist`);
  const marker = path.join(roots.state, 'cleanup.json');
  const uid = process.getuid();
  for (const file of [plist, marker]) {
    safe(file);
    if (fs.existsSync(file) && fs.statSync(file).uid !== uid) fail(`Refusing cleanup file not owned by this user: ${file}`);
  }
  const state = fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, 'utf8')) : null;
  if (fs.existsSync(marker) && (!state || typeof state.enabled !== 'boolean' || (state.plist !== null && typeof state.plist !== 'string'))) fail('Invalid cleanup ownership marker');
  if (fs.existsSync(plist) && (!state?.plist || fs.readFileSync(plist, 'utf8') !== state.plist)) fail(`Refusing unowned or modified cleanup agent: ${plist}`);
  if (automatic && state?.enabled === false) { console.log('Cleanup disabled; preserving your preference.'); return; }
  if (action === 'status' && !state) {
    console.log('Cleanup not installed.');
    return;
  }
  const target = `gui/${uid}/${label}`;
  const result = spawnSync('/bin/launchctl', ['print', target], { encoding: 'utf8', timeout: 15000 });
  if (result.error || (result.status !== 0 && !(result.status === 113 && /Could not find service/.test(result.stderr)))) fail(`launchctl print failed: ${result.error?.message || result.stderr || result.status}`);
  const loaded = result.status === 0;
  if (loaded && (!state?.plist || !fs.existsSync(plist) || !result.stdout.split('\n').some((line) => line.trim() === `path = ${plist}`))) fail('Refusing cleanup label already loaded without exact owned agent');
  if (action === 'status') {
    console.log(`Cleanup ${state.enabled ? 'enabled' : 'disabled'} (preference); agent ${loaded ? 'loaded' : 'not loaded'}.`);
    return;
  }
  if (action === 'disable' || action === 'uninstall') {
    // Persist the user's choice even if bootout fails; report that failure and
    // retain the owned plist so the operation can safely be retried.
    atomicWrite(marker, json({ enabled: false, plist: state?.plist || null }));
    if (loaded) command('/bin/launchctl', ['bootout', target], { timeout: 15000 });
    if (action === 'uninstall') {
      if (fs.existsSync(plist)) fs.unlinkSync(plist);
      atomicWrite(marker, json({ enabled: false, plist: null }));
    }
    console.log(`Cleanup ${action === 'disable' ? 'disabled' : 'uninstalled'}; profile data and legacy jobs untouched.`);
    return;
  }
  const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
  const bytes = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>/bin/zsh</string><string>${xml(path.join(packageRoot, 'shared/disk-cleanup.sh'))}</string><string>--safe-caches-only</string></array>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
<key>StartCalendarInterval</key><dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>15</integer></dict>
<key>ProcessType</key><string>Background</string>
</dict></plist>
`;
  const changed = state?.plist !== bytes;
  if (loaded && changed) command('/bin/launchctl', ['bootout', target], { timeout: 15000 });
  if (changed || !fs.existsSync(plist)) {
    // The exact previous plist is the ownership receipt, not just a filename.
    const previous = fs.existsSync(plist) ? fs.readFileSync(plist) : null;
    atomicWrite(plist, bytes);
    try { atomicWrite(marker, json({ enabled: true, plist: bytes })); }
    catch (error) {
      if (previous) atomicWrite(plist, previous);
      else fs.unlinkSync(plist);
      throw error;
    }
  } else if (!state.enabled) atomicWrite(marker, json({ enabled: true, plist: bytes }));
  if (!loaded || changed) command('/bin/launchctl', ['bootstrap', `gui/${uid}`, plist], { timeout: 15000 });
  console.log('Cleanup enabled: daily safe caches at 04:15; no cleanup run during setup.');
}
function setup() {
  nativeBinary();
  preflight();
  const updates = profiles.flatMap((p) => [{ file: configFile(p), bytes: json(configuration(p)) },
    { file: instructionFile(p), bytes: Buffer.concat([
      fs.readFileSync(path.join(packageRoot, 'shared/instructions.md')),
      ...(p === 'best' ? [Buffer.from('\n'), fs.readFileSync(path.join(packageRoot, 'shared/best-hybrid.md'))] : []),
    ]) }]);
  locked(() => {
    provision();
    for (const p of profiles) for (const directory of [path.join(roots.config, p, 'v2/xdg-config/opencode'),
      path.join(roots.data, p, 'data/opencode'), path.join(roots.state, p, 'serena'), path.join(roots.cache, p)]) mkdir(directory);
    transaction(updates);
    cleanup('enable', true);
  });
  console.log('BEST and FREE configured for native OpenCode V2. No auth imported; connect Go and OpenAI independently inside BEST with /connect.');
  console.log('Existing sessions keep their selected model; use /models or start a new session to adopt the configured coordinator.');
}
function validateProfile(profile) {
  if (!profiles.includes(profile)) fail('Expected profile: best or free');
}
function checkIdle() {
  if (fs.existsSync(path.join(roots.config, '.setup-lock'))) fail('Setup or rollback in progress; retry after it finishes');
  if (fs.existsSync(path.join(roots.config, '.pending'))) fail('Interrupted setup; rerun setup before launching');
}
function doctor() {
  const { version } = nativeBinary();
  preflight();
  checkSerena();
  const commit = checkECC();
  checkIdle();
  for (const p of profiles) {
    const config = JSON.parse(fs.readFileSync(configFile(p), 'utf8'));
    if (config.default_agent !== 'build' || !config.agents?.reviewer || !fs.existsSync(instructionFile(p))) fail(`${p} needs setup`);
    console.log(`${p}: config present; auth/model availability NOT tested`);
  }
  console.log(`OpenCode ${version}; Serena 1.7.0; ECC ${commit}. Native network acceptance is a separate check.`);
}
function launch(profile, args) {
  validateProfile(profile);
  preflight();
  checkIdle();
  if (!fs.existsSync(configFile(profile)) || !fs.existsSync(instructionFile(profile))) fail('Profile not configured; run opencode-team setup');
  const { binary } = nativeBinary();
  checkIdle();
  const nativeArgs = [...args];
  const separator = nativeArgs.indexOf('--');
  nativeArgs.splice(separator < 0 ? nativeArgs.length : separator, 0, '--standalone');
  const child = spawn(binary, nativeArgs, { env: profileEnvironment(profile), stdio: 'inherit' });
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => {
    const handler = () => child.kill(signal);
    process.on(signal, handler);
    return handler;
  });
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => {
    signals.forEach((s, i) => process.off(s, handlers[i]));
    if (signal) process.kill(process.pid, signal);
    else process.exitCode = code ?? 1;
  });
}
function help() {
  console.log(`OpenCode Team: native V2 profiles\n\n  opencode-team best|free [native OpenCode arguments]\n  opencode-team start best|free [native OpenCode arguments]\n  opencode-team setup\n  opencode-team doctor\n  opencode-team config best|free\n  opencode-team rollback BACKUP_ID\n  opencode-team cleanup enable|disable|uninstall|status|dry-run\n  opencode-team version\n\nBEST: OpenAI coordinator + Go workers; connect both subscriptions with /connect.\nFREE: anonymous MiMo only; no paid fallback.\nmacOS setup schedules safe caches daily; disable/uninstall persist across setup.\nCustom HOME/root skips automatic scheduling; explicit enable requires the login HOME.\nResume natively: opencode-team best -s SESSION_ID\nNative CLI arguments are preserved, with --standalone added in command scope.\nSee README for migration, backup and security boundaries.`);
}
try {
  const [action = 'help', ...args] = process.argv.slice(2);
  if (profiles.includes(action)) launch(action, args);
  else if (action === 'start') launch(args[0], args.slice(1));
  else if (['help', '--help', '-h'].includes(action)) help();
  else if (action === 'version' || action === '--version') console.log(`OpenCode Team ${fs.readFileSync(path.join(packageRoot, 'VERSION'), 'utf8').trim()}`);
  else if (action === 'setup' && !args.length) setup();
  else if (action === 'doctor' && !args.length) doctor();
  else if (action === 'cleanup' && args.length === 1) {
    if (process.platform !== 'darwin' || ['status', 'dry-run'].includes(args[0])) cleanup(args[0]);
    else locked(() => cleanup(args[0]));
  }
  else if (action === 'config' && args.length === 1) { validateProfile(args[0]); console.log(configFile(args[0])); }
  else if (action === 'rollback' && args.length === 1) { preflight(); locked(() => transaction(readManifest(args[0]))); }
  else fail(`Unknown command or arguments: ${action}. Use --help; only best/free profiles are supported.`);
} catch (error) { console.error(`opencode-team: ${error.message}`); process.exitCode = 1; }
