#!/usr/bin/env python3
"""Sync the private ACL allowlist into Firestore user grants.

Reads <repo root>/private/acl.txt (one email per line; blanks and lines starting
with '#' are ignored) and, for each email, resolves the Firebase Auth user and
writes users/{uid} = {allowed: true, email} with merge=True.

    python3 pi/acl.py            # grant every allowlisted email
    python3 pi/acl.py --prune    # also delete grants whose email is no longer listed

Each person must have signed in once before they can be granted: the Auth user
must exist for its uid to be resolved. Requires the Firebase service-account key
configured via FIREBASE_SERVICE_ACCOUNT (private/bridge.env); see
private.example/README.md and copy the template with
`cp -r private.example private`.

Exits 0 only when every allowlisted email was granted (and pruning, if
requested, succeeded); otherwise exits 1.
"""

import argparse
import sys
from pathlib import Path

from firebase_admin import auth

from bridge import REPO_ROOT, init_firestore, service_account_file

ACL_PATH = REPO_ROOT / "private" / "acl.txt"
SETUP_HINT = "see private.example/README.md (cp -r private.example private)"


def load_allowlist(path):
    """Return non-blank, non-comment lines from the allowlist file."""
    emails = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            emails.append(line)
    return emails


def grant(db, email):
    """Grant one email; return True on success. Never aborts the batch."""
    try:
        uid = auth.get_user_by_email(email).uid
    except auth.UserNotFoundError:
        print(f"failed {email}: must sign in once first (then rerun)")
        return False
    except Exception as exc:  # keep going: one bad entry must not block the rest
        print(f"failed {email}: {exc.__class__.__name__}: {exc}")
        return False

    try:
        db.collection("users").document(uid).set(
            {"allowed": True, "email": email}, merge=True
        )
    except Exception as exc:
        print(f"failed {email} ({uid}): {exc.__class__.__name__}: {exc}")
        return False

    print(f"ok {email} -> {uid}")
    return True


def prune(db, allowed):
    """Delete user grants whose email is not in the (non-empty) allowlist."""
    pruned = 0
    errors = 0
    for doc in db.collection("users").stream():
        data = doc.to_dict() or {}
        email = data.get("email")
        key = email.strip().lower() if isinstance(email, str) else ""
        if key in allowed:
            continue
        try:
            doc.reference.delete()
        except Exception as exc:
            print(f"prune failed {email or doc.id}: {exc.__class__.__name__}: {exc}")
            errors += 1
            continue
        print(f"pruned {email or doc.id}")
        pruned += 1
    return pruned, errors


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Sync private/acl.txt into Firestore users/{uid} grants."
    )
    parser.add_argument(
        "--prune",
        action="store_true",
        help="delete grants whose email is not in private/acl.txt",
    )
    args = parser.parse_args(argv)

    key_file = service_account_file()
    if key_file is None:
        print(
            f"acl: FIREBASE_SERVICE_ACCOUNT is not set; {SETUP_HINT}",
            file=sys.stderr,
        )
        return 1
    if not Path(key_file).is_file():
        print(
            f"acl: service-account key not found: {key_file}; {SETUP_HINT}",
            file=sys.stderr,
        )
        return 1

    if not ACL_PATH.is_file():
        print(
            f"acl: allowlist not found: {ACL_PATH}; {SETUP_HINT}",
            file=sys.stderr,
        )
        return 1
    emails = load_allowlist(ACL_PATH)
    if not emails:
        print(
            f"acl: allowlist is empty: {ACL_PATH}; add one email per line; {SETUP_HINT}",
            file=sys.stderr,
        )
        return 1

    db = init_firestore()

    granted = sum(1 for email in emails if grant(db, email))
    failed = len(emails) - granted

    pruned = prune_errors = 0
    if args.prune:
        pruned, prune_errors = prune(db, {email.lower() for email in emails})

    summary = f"{granted} granted, {failed} failed"
    if args.prune:
        summary += f", {pruned} pruned"
    print(summary)
    if prune_errors:
        print(f"{prune_errors} prune errors", file=sys.stderr)
    return 0 if failed == 0 and prune_errors == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
