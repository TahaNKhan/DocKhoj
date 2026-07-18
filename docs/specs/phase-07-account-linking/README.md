# Phase 07 — Account linking: SSO for password users

**Status:** in-progress
**Started:** 2026-07-18

## Isolation
- **Branch:** `main`
- **Worktree:** n/a

## Pointers
- **Tasks:** `T01..Tn` IDs in `./TASKS.md` (this folder)
- **PR / merge commit:** n/a
- **Related specs:** none

## Why isolated (or not)

Sits on `main` because the change is additive: a password user gains
a second login method; existing flows are unchanged. The work is
multi-file (route handler, user-identity-store, a new `/account` SPA
route, a state-cookie mode flag, tests across three layers) but the
blast radius is small — no schema rebuild, no change to the OIDC
sentinel, no change to the password login path. Estimated 1–2 days;
fits the "Medium feature" tier.

## Design call to flag at review

Phase 06 made OIDC users structurally unable to password-login
(`'!oidc!'` sentinel). Phase 07 inverts the relationship for password
users: a password user who links SSO gains a second login method but
keeps the first. The two phases compose: OIDC-only users stay
OIDC-only (sentinel still rejects password login); password users
stay password-only by default until they opt into linking. The
`user_identities` table already supports the "identity → user" map;
the only change is letting the local user be a password user.
