# Team Profiles

Portable templates for BEST Native, the BEST OpenCode fallback, BEST-ECC, GO, and OPENAI
are rendered by `opencode-team setup` into the user XDG configuration/data roots.
Runtime data is kept under separate XDG data/state/cache roots.

The pinned OmO Native runtime and OpenCode plugin are installed package-locally
by `opencode-team setup`. BEST Native uses a Senpi extension to preserve the
BEST route classifier and fail-closed delegation gate; `omo.jsonc` enables the
Native memory and recall profile. BEST and GO OpenCode patchers remain
deterministic source files in this repository; historical staging paths are
never consulted at runtime.

BEST-ECC is a separate OpenCode profile. `opencode-team best-ecc-setup` checks
out only the ECC skill, prompt and plugin paths pinned in `best-ecc/ecc.lock`;
its user configuration, memory, session data, logs and caches remain isolated
from BEST. BEST's routing plugin enables the ECC TDD planner only when the
BEST-ECC runtime exports its explicit opt-in flag.
