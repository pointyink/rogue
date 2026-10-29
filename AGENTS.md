# AGENTS.md

Guidance for coding agents working in this repo.

## What this is

`rogue` is an HTML-native sync CRDT (Fugue + rope) compiled to WebAssembly,
plus the JS DOM sync layer and editor plugins. Four npm packages live here:

| Path | Package |
|------|---------|
| `rogue/` | `@pointyink/rogue` — CRDT engine + DOM sync layer |
| `serde/` | `@pointyink/serde` — binary wire codecs (Zig / JS / Go) |
| `plugins/tinymce/` | `@pointyink/tinymce` |
| `plugins/hugerte/` | `@pointyink/hugerte` |

Toolchains: Node 22–24 (CI pins 22), Zig 0.15.2, Go (see `go.mod`). Node ≥25
defines a global `localStorage` that shadows jsdom's, so `replica.test.js` and
the `sync-client` checkpoint tests fail with `Cannot read properties of
undefined (reading 'clear')` — run the suite on 22 or 24. Run `npm ci` at the repo
root once.

## Verify

`make verify` is the gate: tests, JS typecheck, formatting, generated types,
and a dist build. Run it before handing off.

| Command | What it does |
|---------|--------------|
| `make test` | Zig CRDT tests, JS vitest, serde Go/Zig/JS conformance |
| `make typecheck` | `tsc --noEmit` over all `rogue/src` JS (including tests) |
| `make fmt-check` | `zig fmt --check` + `gofmt -l` |
| `make types-check` | regenerate committed `*/types/` and fail on drift |
| `make wasm-check` | rebuild `rogue/src/rogue.wasm.js` from Zig and fail on drift |
| `make build-dist` | esbuild all four packages (publish smoke test) |

Targeted runs:

- One JS file: `cd rogue && npx vitest run src/sync.test.js`
- One Zig test: `cd rogue && zig build test -Dtest-filter="<substring>"`
- One serde language: `go test ./serde/...` / `zig test serde/fixtures_test.zig`
  / `node serde/fixtures_test.js`

## Generated files — never hand-edit

- `serde/fixtures/**/bytes.bin`, `value.json`, `error.txt` — regenerate with
  `go run ./serde/fixtures/gen` from the repo root. The generator wipes and
  rewrites `positive/` and `negative/`.
- `*/types/**` — regenerate with `npm run build:types` in that package and
  commit the result. CI fails on drift.
- `rogue/src/rogue.wasm.js` — the committed base64 copy of the Zig-built wasm.
  Regenerate with `cd rogue && npm run build:wasm`; never hand-edit it. A Zig
  change that is not followed by this step ships a stale JS engine.
- `filesync/rogue_u8.wasm` — the committed byte-native wasm embedded by the Go
  `filesync` package. Regenerate with `cd rogue && npm run build:wasm`; never
  hand-edit it. `make wasm-check` fails if it is stale.
- `*/dist/**`, `rogue/zig-out/**`, `.zig-cache/` — build artifacts, gitignored.
  Never commit them.

## Contract changes

The wire format is a cross-language contract. A change to one codec is not done
until all of these move together:

1. the JS (`.js`), Zig (`.zig`), and Go (`.go`) implementations in `serde/`
2. the op's `serde/<op>.md` layout/field docs
3. regenerated conformance fixtures
4. `serde/fixtures_test.{js,zig,go}` still pass

`rogue/crdt/error_kinds.json` is the single source of truth for CRDT error
kinds. The integer keys are stable discriminators: append new kinds, never
reorder or reuse. Both the Zig and JS conformance tests read it, and
`rogue/crdt/error_kind.zig` plus `rogue/src/crdt_error.js` must match it.

## CRDT invariants

Changes to `rogue/crdt/` or `rogue/src/sync.js` must preserve:

- convergence under reorder, duplication, and delayed delivery
- idempotent apply
- undo/redo and boundary/parking behavior
- multi-author operation
- UTF-16 correctness (emoji/surrogates are two units)

Add a failing property/fuzz case before fixing a bug. Do not weaken, skip, or
delete existing fuzz seeds or assertions to make a change pass. If a test looks
wrong, explain why rather than silently loosening it.

## Code conventions

- JS is ESM with `// @ts-check` and JSDoc types. No semicolons, 2-space indent,
  single quotes. Keep files `snake_case.js` (e.g. `dom_rope.js`).
- Zig code is formatted with `zig fmt`; Go with `gofmt`. CI enforces both.
- Public JS API changes need matching JSDoc so `npm run build:types` emits the
  right `.d.ts`.
- Keep changes scoped. One concern per change; split unrelated refactors.

## Agent workflow

1. **Plan first** for anything touching the wire format, CRDT semantics, or
   more than a couple of files: `/plan <task>`. The plan must name the files,
   the invariants at risk, and the test that should fail before the fix.
2. Implement in small steps. Prefer worktrees for parallel work; one task per
   worktree, and do not let two agents edit the same files. A fresh worktree
   needs its own `npm ci`; the Zig global cache is shared.
3. Run `make verify`. Treat a red gate as unresolved; do not hand off with
   known failures.
4. Run `/review` before declaring non-trivial work done. The reviewer is
   read-only and independent; address blocking findings, then re-run
   `make verify`.
5. Never `git push`, `npm publish`, or tag a release unless the human asks.

## Release

Bump `version` in all four `package.json` files (`serde`, `rogue`,
`plugins/tinymce`, `plugins/hugerte`) to the same value, then tag `v<version>`.
CI enforces the match and publishes via npm Trusted Publishing. `dist/` is
built at publish time; do not commit it.
