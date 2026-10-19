"""alpha.py — shipped (buggy) version.

Bug: add(a, b) returns a - b instead of a + b.
Worker Lane A fixes the body of add() only. No other changes.
"""


def add(a, b):
    """Return the arithmetic sum of a and b."""
    return a - b
