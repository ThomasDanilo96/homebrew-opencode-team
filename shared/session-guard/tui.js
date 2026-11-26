import { Plugin } from '@opencode/plugin/tui';
import { registerGuard } from './guard.mjs';

export default Plugin.define({
  id: 'opencode-team.session-guard',
  setup: registerGuard,
});
