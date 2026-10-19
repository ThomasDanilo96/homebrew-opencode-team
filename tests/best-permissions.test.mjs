import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../shared/profiles.mjs'), 'utf8');

test('BEST allows shell and external directories; FREE retains interactive permissions', () => {
  assert.match(source, /rule\('external_directory', profile === 'best' \? 'allow' : 'ask'\)/);
  assert.match(source, /rule\('shell', profile === 'best' \? 'allow' : 'ask'\)/);
  assert.match(source, /for \(const id of \['plan', 'explore', 'reviewer'\]\) agents\[id\]\.permissions = readonlyPermissions\(\)/);
});
