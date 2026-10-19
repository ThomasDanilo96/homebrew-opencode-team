# Tests

```sh
node --test tests/*.test.mjs
node --test --experimental-test-coverage tests/*.test.mjs
bash tests/setup-smoke.sh
bash tests/homebrew-workflow.test.sh
```

- Node tests cover native launcher/config/migration behavior, a Homebrew install
  **Ruby DSL mock**, staging safety and real Zsh completion evaluation.
- Setup smoke exercises installed-package layout with mock native executables,
  disposable HOME/roots, no auth/model traffic or real dependency installation.
- Workflow tests retain immutable archive/staging/install/release gates and run
  actionlint when available. Local PASS is not a remote GitHub Actions result.

Mocks are passed by absolute path. Disk errors use temporary Node preloads, not
production test hooks. Tests verify the Sol low coordinator/native effort setting,
optional medium Plan/Reviewer, Go role split, read-only allowlists, singleton FREE,
original shared AGENTS.md reference without copying/mutation, explicit missing-rule
errors, classic bytes/mtime/mode preservation, data persistence, rollback/recovery,
locking, argument/resume/exit/signal forwarding and credential-environment isolation.
Legacy runtime/OmO/router/benchmark tests were removed with those implementations,
not weakened to make retained behavior pass.

Live Go/OpenAI authentication, anonymous FREE responses, real Serena/ECC use,
native model exports, coding and resume were independently exercised in disposable
profiles. They are **not part of this mock suite**, nor proof of an installed
formula's auth state. A keg-only Homebrew candidate was installed and `brew test`
passed separately. Phase A, official-archive and stable-tap remote CI also passed;
publication-timeout recovery has separate behavioral coverage. See
[recorded results and pending checks](../docs/validation.md).
