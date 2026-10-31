import fs from 'node:fs';
import path from 'node:path';

const staging = process.env.OPENCODE_TEAM_STAGING_ROOT;
const root = path.resolve(import.meta.dirname, '../..');
if (!staging || (root !== fs.realpathSync(staging)
    && !root.startsWith(`${fs.realpathSync(staging)}${path.sep}`))) {
  throw new Error('Run tests with bash tests/guardrail/runner.sh (isolated staging required)');
}
