"""test_beta.py — FROZEN unittest suite for beta.normalize_slug.

These tests are the contract; workers MUST NOT modify this file.
"""
import unittest

from beta import normalize_slug


class TestNormalizeSlug(unittest.TestCase):
    def test_uppercase_letters_lowercased(self):
        self.assertEqual(normalize_slug("Hello World"), "hello-world")

    def test_punctuation_collapsed_to_hyphen(self):
        self.assertEqual(normalize_slug("Hello, World!"), "hello-world")

    def test_consecutive_non_alphanumeric_runs_collapse_to_one_hyphen(self):
        self.assertEqual(normalize_slug("a!!b"), "a-b")
        self.assertEqual(normalize_slug("foo___bar"), "foo-bar")

    def test_leading_and_trailing_hyphens_stripped(self):
        self.assertEqual(normalize_slug("___foo___"), "foo")
        self.assertEqual(normalize_slug("--bar--"), "bar")

    def test_already_normalized_input(self):
        self.assertEqual(normalize_slug("plain"), "plain")
        self.assertEqual(normalize_slug("a-b-c"), "a-b-c")

    def test_only_whitespace_collapses_to_empty(self):
        self.assertEqual(normalize_slug("   "), "")

    def test_empty_string(self):
        self.assertEqual(normalize_slug(""), "")

    def test_digits_preserved(self):
        self.assertEqual(normalize_slug("Item 42!"), "item-42")

    def test_mixed_case_punctuation(self):
        self.assertEqual(normalize_slug("Hello, World! 123"), "hello-world-123")


if __name__ == "__main__":
    unittest.main()
