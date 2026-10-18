"""Unit tests for pi/acl.py (stdlib unittest; no Auth or Firestore calls)."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import acl  # noqa: E402
from fakes import FakeDB  # noqa: E402


class AllowlistTests(unittest.TestCase):
    def test_parsing_skips_blanks_comments_and_keeps_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "acl.txt"
            path.write_text("# owner\na@example.com\n\n  b@example.com  \n")
            self.assertEqual(
                acl.load_allowlist(path), ["a@example.com", "b@example.com"]
            )


class PruneTests(unittest.TestCase):
    def setUp(self):
        self.db = FakeDB(
            {
                "users": {
                    "u1": {"allowed": True, "email": "keep@example.com"},
                    "u2": {"allowed": True},  # hand-created console grant
                    "u3": {"allowed": True, "email": "remove@example.com"},
                },
                "fcmTokens": {
                    "token-remove": {"uid": "u3"},
                    "token-unmanaged": {"uid": "u2"},
                },
            }
        )

    def test_prune_keeps_unmanaged_grants_and_deletes_revoked_tokens(self):
        pruned, errors, tokens, kept = acl.prune(
            self.db, {"keep@example.com"}
        )
        self.assertEqual((pruned, errors, tokens, kept), (1, 0, 1, 1))
        self.assertIn("u1", self.db.data["users"])
        self.assertIn("u2", self.db.data["users"])
        self.assertNotIn("u3", self.db.data["users"])
        self.assertNotIn("token-remove", self.db.data["fcmTokens"])
        self.assertIn("token-unmanaged", self.db.data["fcmTokens"])

    def test_prune_matches_email_case_insensitively(self):
        self.db.data["users"]["u1"]["email"] = "Keep@Example.com"
        pruned, _, _, _ = acl.prune(self.db, {"keep@example.com"})
        self.assertEqual(pruned, 1)
        self.assertIn("u1", self.db.data["users"])

    def test_prune_with_empty_email_is_not_a_grant_deletion(self):
        pruned, errors, tokens, kept = acl.prune(self.db, set())
        self.assertEqual((pruned, errors, tokens, kept), (2, 0, 1, 1))
        self.assertIn("u2", self.db.data["users"])


if __name__ == "__main__":
    unittest.main()
