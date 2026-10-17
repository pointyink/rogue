---
description: Run the full verification gate and report failures
agent: build
---

Run `make verify` from the repo root. Report:

- each failing command,
- the relevant output (trim noise),
- whether the failure is pre-existing or caused by the current change.

Do not fix anything until you have reported every failure. Then fix them one at
a time, re-running the failing target after each fix. Do not weaken or delete
tests to make the gate pass.
