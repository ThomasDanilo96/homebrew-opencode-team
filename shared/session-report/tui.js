import { Plugin } from '@opencode/plugin/tui';
import { createClipboard, createHostClipboard, createRendererClipboardAdapter } from '@opentui/core';
import { registerReport } from './report.mjs';

export default Plugin.define({
  id: 'opencode-team.session-report',
  setup(context) {
    const clipboard = createClipboard({
      host: createHostClipboard(),
      terminal: createRendererClipboardAdapter(context.renderer),
    });
    registerReport(context, async (markdown) => {
      const result = await clipboard.writeText(markdown, { destination: 'all-available', selection: 'clipboard' });
      if (result.host.status !== 'written' && result.terminal.status !== 'attempted') {
        throw new Error('Clipboard unavailable');
      }
    });
    return () => clipboard.dispose();
  },
});
