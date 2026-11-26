# Session Guard prototype for OpenCode 2.3.2

This is an opt-in prototype for the **full terminal composer**. It does not
change the OpenCode binary or profile installation used by OpenCode Team.
Stock OpenCode 2.3.2 does not expose this hook; the plugin is inert there.

## Interception and decisions

The [native patch](../patches/opencode-v2.3.2-tui-prompt-admission.patch)
adds `ui.prompt.beforeSubmit` to the composer path shared by ordinary
submission, the text input's direct submit callback and queue submission.
The callback sees the target session ID, the native expanded text, the
delivery mode and any staged revert boundary. The original composer retains
its text, pasted parts and attachments. The check happens before clearing the draft, recording it in
history, changing agent/model selection, committing a revert, sending editor
context or contacting the server for prompt admission.

The callback can allow or cancel the current invocation. If its composer,
session, route, payload, pending editor selection or registered hooks change
while it waits, the native path does not send. There is no bypass token,
replay, automatic transfer, new permission or change to the server.
An exception cancels the send.

The [Team plugin](../shared/session-guard) compares explicit scope declarations
against the most recent explicit scope found in up to 20 native user messages
for that session. It checks repository identity or a project/mandate heading
backed by an objective or scope field. It does not infer a different scope
from shared or missing vocabulary alone. The wording-overlap check only
softens the same-project warning. Contradictory declarations and absent
history do not prove a mismatch. With a staged revert, a bounded native page
is used to locate the boundary and only retained messages are considered.
If that boundary cannot be located in the page, the check has insufficient
history. No model, external lookup or new storage is involved.

A different declared project/repository is blocked; a distinct declared
mandate in the same project is suspended. Type `INVIA` in the native dialog
to approve this one send or press Esc to leave the original draft in place.
An empty Enter is not confirmation. A confirmed scope only affects future
checks after it appears in the native user-message history.

This does not cover `run`, Mini, ACP, direct HTTP/SDK submissions, desktop
or web clients. Recognized slash commands and native shell mode intentionally
bypass the check, as do first prompts without history. Plain-text mandates
without explicit scope can pass undetected. A separate protected paste
shortcut would not protect regular Enter or queue paths and cannot acquire
the composer's full draft through the stock API.

## Build, rollback and Homebrew

Use a disposable checkout/archive of upstream
[`c0ad18b402eb2827fc1ee71c171b1177b3fc02d1`](https://github.com/anomalyco/opencode/commit/c0ad18b402eb2827fc1ee71c171b1177b3fc02d1)
(`v2.3.2`), and use Bun 1.4.4 on `PATH`:

```sh
# In that source directory. TEAM_REPO points to the OpenCode Team checkout.
git apply --check "$TEAM_REPO/patches/opencode-v2.3.2-tui-prompt-admission.patch"
git apply "$TEAM_REPO/patches/opencode-v2.3.2-tui-prompt-admission.patch"
bun install --frozen-lockfile
OPENCODE_VERSION=2.3.2 bun run --cwd packages/cli build --single --skip-install --skip-web-ui
```

The macOS arm64 test binary is
`packages/cli/dist/cli-darwin-arm64/bin/opencode`. Run it by absolute path
with disposable HOME, XDG and OpenCode config directories. Copy
`shared/session-guard` into the disposable config directory's `plugins/`
under `opencode-team.session-guard`. Do not use personal configuration or
credential directories for qualification.

Native reproducible check (macOS, `tmux`, Python 3; creates its own fixtures):

```sh
python3 tests/session-guard-native.py /absolute/path/to/patched/opencode
node --test tests/session-guard.test.mjs tests/session-report.test.mjs
```

The native test runs two independent BEST/FREE-style roots and two sessions
in the same fixture directory per root. A loopback provider counts requests;
the OpenCode processes cannot reach external networks. No personal quotas,
accounts, plugins or workspaces are loaded for this test.

| Case | Result in both isolated roots |
| --- | --- |
| A, G | AI Handoff assignment blocked in the Mitech session, while the other window had a separate pending decision. Esc kept the exact composer draft available to retry. No provider request, inbox admission or change to the staged revert and retained history. The temporary newer scope was ignored because the revert would remove it. |
| B, D | Legacy-deploy removal suspended in the disaster-recovery session in the same fixture directory. The pre-submit callback observed `queue`. Typing `INVIA` admitted the native expanded text once, in that session only; a follow-up with the newly admitted scope no longer asked. |
| C, F | The pertinent GO and a pasted diagnostic with a foreign repository reference were admitted without a guard dialog. |
| E | A native background shell in the same session completed with exit 0 while the incompatible draft remained unadmitted. |

Also passed: native CLI build and TUI type check, 11 Guard tests and 15
AI Handoff tests, and the native loopback Governor suite with the patched
binary. This does not requalify live providers; the editor-selection change
check was reviewed statically, not exercised with a live editor connection.

Do not overwrite the Homebrew binary or its symlink. The Team formula does
not build OpenCode core; distributing a patched binary would need a separate
packaging decision and new artifacts/checksums for every supported platform.
The patch modifies no server or database contract. Rollback of the prototype
means closing the isolated binary and continuing to use the untouched
official binary; no profile data needs migration. Each upstream upgrade that
lacks an equivalent hook requires patch review, rebuild and native retesting
of send/queue, cancellation with a pending revert, confirmation and isolation.
An apply without conflicts alone does not establish compatibility.
The dependency install took about 70 seconds in this environment, and the
isolated arm64 executable is about 198 MiB. No other platform was built or
qualified.
