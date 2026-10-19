"""test_alpha.py — FROZEN unittest suite for alpha.add.

These tests are the contract; workers MUST NOT modify this file.
"""
import unittest

from alpha import add


class TestAdd(unittest.TestCase):
    def test_positive_integers(self):
        self.assertEqual(add(2, 3), 5)

    def test_zero_identity(self):
        self.assertEqual(add(0, 7), 7)
        self.assertEqual(add(7, 0), 7)

    def test_negative_numbers(self):
        self.assertEqual(add(-2, 3), 1)
        self.assertEqual(add(-5, -4), -9)

    def test_floats(self):
        self.assertAlmostEqual(add(0.1, 0.2), 0.3, places=7)

    def test_commutative(self):
        self.assertEqual(add(3, 4), add(4, 3))


if __name__ == "__main__":
    unittest.main()
