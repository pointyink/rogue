# JSON envelopes (engine control messages)

Discriminator: **`5`** (`json_envelope_v0`). Shape: a UTF-8 JSON object with a
`"type"` field. The envelope codec is a pass-through; this document is the
schema for the messages the **engine** speaks.

## Why JSON here and bytes for ops

The op stream is the hot path: one binary frame per keystroke, typed by
construction. These messages are not: two per connection plus a rare event.

The reason they stay JSON is **additive evolution**. A client in the field is
frozen at whatever it shipped with, and the server moves ahead:

```jsonc
{"type":"sync_counts","counts":{"1":{"n":27,"max":30873}}}
{"type":"sync_counts","counts":{"1":{"n":27,"max":30873,"epoch":4}}}   // free
```

A byte struct cannot do that: a new field is a new discriminator
(`sync_counts_v1`). Adding a field here costs nothing; both decoders ignore what
they do not know.

## Rules

1. **A `"type"` string is immutable once shipped.** Clients compare it literally;
   renaming one breaks every older client. (`sync_start` and `sync_done` are the
   oldest and are compared by string in clients already in the field.)
2. **Fields are additive.** New fields are optional; unknown keys are ignored.
   Removing or renaming a field is a new message type, not an edit.
3. **The payload is payload only.** `disc: 5` + length is the caller's frame.
4. **Host messages are not here.** Comments, suggestions, usage limits and doc
   deletion are defined by the service, not the engine. The engine forwards them
   by type without understanding them; the registry that keeps both sets from
   colliding lives with the service.

## Messages

| type | direction | fields | meaning |
|---|---|---|---|
| `sync_start` | s→c | `bytes` | Total size of the incoming op stream; pre-grow storage, show progress. |
| `sync_done` | s→c | — | End of stream; the client may replay its own unacked queue. |
| `sync_counts` | s→c | `counts: {"<replica>": {"n", "max"}}` | What the server holds per replica. A larger `n` than the client's cache is an op it never received; a larger `max` is a missing tail. |
| `sync_rejections` | s→c | `rejected: {"<replica>:<seq>": "<engine version>"}` | Recorded verdicts: the op cannot be rendered by that engine. The op is still in the stream — the client skips it instead of walking back. |
| `reject_op` | c→s | `gid`, `version` | A client's verdict about one op. Writer-only; recorded, never enforced. |

## Mapping notes

- `counts` keys are strings in JSON (object keys). Go marshals map keys
  **lexicographically**, so `"10"` sorts before `"2"`; the order is stable, not
  numeric, which is all a fixture needs.
- `n` and `max` are bytes-of-the-wire numbers, not ids: `max` is the highest
  `seq` the server holds for that replica.

## API

Go: `serde.EncodeSyncCounts`, `serde.DecodeSyncCounts`, … — one pair per message,
plus `serde.JsonTypeOf` for dispatch.

JS: the same shape lands with the client half (sending `reject_op` and consuming
`sync_counts`/`sync_rejections`), as `@pointyink/serde/json_envelopes_v0`. Until
then the browser client parses these by hand, which is what this file exists to
prevent — so it is a sequencing artefact, not a design choice.

## Migrations

None. New messages are new `"type"` values; they never touch the discriminator.
