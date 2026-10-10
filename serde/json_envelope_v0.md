# json_envelope_v0

Discriminator: **`5`**. Shape: **variable** (length-prefixed when framed).

A thin wrapper marking a wire message whose payload is **UTF-8 encoded
JSON**. The codec performs no parsing or validation — the payload bytes
are passed through verbatim. All routing within the JSON is the
application's concern.

## Why an envelope

Most CRDT traffic on the wire is `multi_op_v0`. But sometimes the editor
needs to send non-CRDT messages (cursor presence, ephemeral typing
indicators, comment events, etc.). Rather than promoting every minor
side-channel message type to a top-level discriminator and bloating
`discriminators.md`, anything that fits a JSON shape lands in a
`json_envelope_v0`.

The convention is that the JSON object inside has a `"type"` field that
the receiver dispatches on:

```json
{ "type": "cursor", "user_id": "abc", "line": 10, "col": 20 }
{ "type": "comment", "id": "x", "text": "hello" }
{ "type": "typing", "user_id": "abc" }
```

This pattern lets you add new side-channel message types freely without
ever coordinating a new wire-level discriminator. The cost is JSON parse
overhead, but for low-volume side channels that's fine — high-volume
binary state goes through the CRDT op machinery instead.

## Payload layout

The payload is **just the JSON bytes, nothing else.** The outer wire frame
supplies `[disc: u16][len: u32]` per the framing rule in
`discriminators.md`; this codec receives a byte slice of exactly `len`
bytes that it treats as opaque UTF-8.

| offset | size       | field        | type            |
|--------|------------|--------------|-----------------|
|   0    | `len`      | json_bytes   | UTF-8 (opaque)  |

Total: **`len`** bytes (where `len` comes from the outer wire frame).

## Errors

None at this layer. Decoders are pass-through; if `json_bytes` is not
well-formed JSON, the consumer's JSON parser is responsible for surfacing
that.

## API

Each language exposes:

- `DISC` — `5`.
- `encode(json_bytes)` — returns `json_bytes` (identity). Provided so
  callers can stay symmetric with other codecs.
- `decode(buf)` — returns the input bytes (identity).

The codec is intentionally minimal. If we ever want a layer that
validates JSON or that splits subtype out of the payload, that's a new
discriminator (`typed_envelope_v0`, `binary_envelope_v0`, etc.), not a
change to this one.

## Migrations

None. This is `v0`.
