---
description: Plan a change without editing code
agent: plan
---

Plan this change: $ARGUMENTS

Read the relevant code, tests, and docs before writing anything. Produce:

1. **Goal / non-goals** — what is in scope, what is explicitly not.
2. **Files** — every file to change and why, including generated files and
   fixtures that must be regenerated.
3. **Contracts at risk** — CRDT invariants, serde wire format, error kinds,
   public JS API and types.
4. **Test plan** — the existing test that proves current behavior, the new or
   updated test that fails before the fix, and any fuzz/property case.
5. **Verification** — the exact commands (`make verify` plus targeted runs).
6. **Risks / rollback** — what could break, how to detect it, how to revert.

Do not edit project files. Ask questions if the scope or desired behavior is
ambiguous. Keep the plan short enough to review in one screen.
