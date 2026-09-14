# Team Profiles

Portable templates for BEST, GO, and OPENAI are rendered by `opencode-team setup`
into the user XDG configuration root. Runtime data is kept under the separate XDG
data/state/cache roots.

OMO is installed package-locally by `opencode-team setup` into the isolated data
root. BEST and GO patchers are deterministic source files in this repository;
historical staging paths are never consulted at runtime.
