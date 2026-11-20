---
name: Release Preparation
description: Prepare this OpenCode Team package's frozen release artifact and complete archive-bound operational commands using the existing packaging workflow.
---

For this package only, follow README.md “Release preparation” and the existing
`.github/scripts/render-staging-formula.rb --handoff` interface. Generate from
the committed source archive, not a handwritten digest or a mutable staging copy.

Keep the existing native task for preparation open until the generated complete
preparation command exits zero with `RELEASE_PREPARATION=PASS` for its exact
commit and SHA-256. `HANDOFF_VALID` proves identity/completeness only; plain
packaging PASS does not prove that operational instructions exist.
Use an already applicable `/goal` and its acceptance checks; no additional goal
or review loop is needed. Deliver the full generated commands without asking the
operator to splice new paths or hashes into a previous command.

`SOURCE_MISMATCH`, archive/commit mismatches and missing handoff files are
preparation-input failures, before packaging tests. Isolation negative-control
failure is a fixture/infrastructure blocker, not a demonstrated package defect.
Retain that boundary and error; do not weaken the checks to obtain PASS.
The generated install command is not GO.
