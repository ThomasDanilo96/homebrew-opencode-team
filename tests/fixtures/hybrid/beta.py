"""Slug normalization: intentionally incomplete for the comparison fixture."""
import re


def normalize_slug(s):
    return re.sub(r"\s+", " ", s.lower()).strip()
