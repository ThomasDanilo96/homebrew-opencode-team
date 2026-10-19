# ChatGPT implementation mandate: two isolated Python repairs

Work only inside this temporary repository. No network, database, credentials,
commits or access to other repositories. Use configured models without overrides.
Do not change this mandate or the frozen `test_alpha.py` / `test_beta.py` contracts.

Independent goals:
- Map dependencies and acceptance contracts from the frozen test files; report
  concise file/symbol references. Implementations do not depend on this report.
- Repair `alpha.py`: `add(a, b)` must return the arithmetic sum. Its writer owns
  ONLY `alpha.py`; no changes to `beta.py` or tests.
- Repair `beta.py`: lowercase input, collapse runs outside `[a-z0-9]` into one
  hyphen, then strip edge hyphens. Its writer owns ONLY `beta.py`.
- Independently analyze the frozen tests and this mandate for boundary cases and
  missing coverage. This analysis does not need or review changing worker files.

Observe the initial RED state before repairs. The two writers have disjoint
ownership and need no results from each other. Use `PYTHONDONTWRITEBYTECODE=1
python3 -m unittest -v test_alpha.py test_beta.py` for final verification; disable
Python bytecode caches for focused runs too. Do not install dependencies.

After implementations finish, obtain an independent read-only review of the
changed modules, fix relevant findings, and verify the final GREEN state. Return
short results with test exit codes and reasons for any reduced delegation.

Both baseline and candidate must solve exactly this same mandate from identical
buggy files. Agent selection and concurrency are the coordinator's responsibility.
