---
description: Independent review of the current changes
agent: reviewer
---

Review the current changes against `main`. Establish the diff first
(`git merge-base main HEAD`), then read the changed files and their tests in
full.

Focus on correctness, data loss, CRDT invariants, cross-language serde parity,
generated artifacts, and whether the tests would catch the bug. Report blocking
findings first with `file:line` and a suggested test. Do not edit files.
