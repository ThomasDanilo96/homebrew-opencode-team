# DEEP-AUDIT PREMIUM (local; authentication required)

Deep Audit uses native OpenCode `task` agents rather than OmO: the existing OmO plugin supplies additional agents/tools and hooks that are not appropriate for a read-only auditor. No ECC hooks, project plugins, or best-router plugin are loaded. Deep Audit owns a separate checkout of the ECC skills pinned by `best-ecc/ecc.lock`; do not use an unpinned clone. The security specialist can load the relevant ECC skill but must follow the stricter audit policy.

Deep Audit is registered as an isolated launcher profile. Normal setup provisions its separate pinned ECC skill subset and config. The analyzed project is protected by a macOS Seatbelt write-deny sandbox (not a separate read-only APFS mount); project/global OpenCode plugins and external skills are disabled. OAuth refresh tokens are not shared: connect `openai` inside this profile. The configured models are `openai/gpt-6-astra` and `openai/gpt-6.1-sol`; OpenCode's model catalogue is checked and no fallback is configured.

Commands: `opencode-team deep-audit-setup`, `opencode-team deep-audit-doctor`,
`opencode-team deep-audit [TARGET]`, and `opencode-team deep-audit-report
<list|latest|show ID>`. The target defaults to the current directory. Resume
from the same target directory with `--resume SESSION`.

Setup pins Python, PHP, and Node test images by OCI digest, downloads PHPUnit
with a fixed SHA-256, builds the profile-local Python runner from exact package
versions, and runs disposable Python/pytest, Django, PHPUnit, and npm fixtures.
The test tool discovers supported suites and executes only on disposable
snapshots in a local Docker container with network disabled, read-only image
root, no capabilities, no host environment/secret mounts, 2 GiB RAM, 2 CPUs,
96 processes, bounded output, and a 5-minute timeout. Django database aliases
are overridden to temporary SQLite; all other database access is cut off by
the container network boundary. Django evidence explicitly marks
PostgreSQL/MySQL-specific SQL, concurrency, transaction, constraint, and
locking behavior as `NOT_EXECUTED`; SQLite results do not verify those
production database semantics. Credential files and VCS state are excluded
from snapshots, and Gitleaks blocks execution if embedded secrets are found.
Reports and logs are stored outside the source target.

Integration/E2E suites that need external services are reported as
`NOT_EXECUTED` unless a declared test script can run them wholly inside the
networkless container. Unavailable project dependencies are never installed
or fetched from the target. PHP coverage is explicitly reported unavailable
when the project/container has no coverage driver. Project-source failures are
analyzed and documented without modifying source.

Doctor requires profile-local OAuth plus a current fingerprinted pass of the
Python/Django/PHP/JavaScript isolation fixtures. It reports **NOT READY** if
Docker is unavailable, images changed, the sandbox fixture test fails, or
OAuth is not connected. No real project audit or profile model request has
been performed in this setup session. The separate OpenCode launcher uses
macOS `sandbox-exec` to deny target writes, deny common credential/configuration
paths, and deny writes elsewhere in the user's home except profile-owned data,
configuration, and runtime roots. Reads to sibling OpenCode Team profile data
and configuration roots are denied as well. This protects the audited project
and common secrets but is **not complete host isolation**: reads outside the
denied paths and writes outside the user's home/system temporary paths remain
possible to a compromised host process. Shell and project-writing tools remain
disabled. The isolated test runner uses Docker rather than relying on a writable
copy alone.
