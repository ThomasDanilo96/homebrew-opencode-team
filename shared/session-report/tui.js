import { Plugin } from '@opencode/plugin/tui';
import { createClipboard, createHostClipboard, createRendererClipboardAdapter } from '@opentui/core';
import { basename, dirname, join } from 'node:path';
import { registerReport } from './report.mjs';

export default Plugin.define({
  id: 'opencode-team.session-report',
  setup(context) {
    const [state, update] = context.storage.store('handoff-checkpoints', { initial: { sessions: {} } });
    const config = process.env.OPENCODE_CONFIG_DIR;
    const candidate = config && basename(dirname(config));
    const profile = ['best', 'free'].includes(candidate) && basename(config) === 'v2' &&
      process.env.XDG_CONFIG_HOME === join(config, 'xdg-config') ? candidate : 'standard';
    const clipboard = createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(context.renderer),
    });
    registerReport(context, async (markdown) => {
      const result = await clipboard.writeText(markdown, { destination: 'all-available', selection: 'clipboard' });
      if (result.host.status === 'written') return true;
      if (result.terminal.status === 'attempted') return false;
      throw new Error('Clipboard unavailable');
    }, {
      profile,
      get checkpoints() { return state.sessions; },
      saveCheckpoint: (id, checkpoint) => update((draft) => {
        const sessions = draft.sessions && typeof draft.sessions === 'object' ? draft.sessions : {};
        delete sessions[id];
        sessions[id] = checkpoint;
        draft.sessions = Object.fromEntries(Object.entries(sessions).slice(-16));
      }),
    });
    return () => clipboard.dispose();
  },
});
