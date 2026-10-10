# multi_op_v0

Discriminator: **`3`**. Shape: **variable** (length-prefixed when framed).

A `multi_op_v0` is an atomic batch of CRDT ops that share a group identity.
It is the unit of replication on the wire and the unit of durability in
storage. Either every op in the batch lands, or none does.

## Payload layout

| offset | size  | field      | type           | notes                                |
|--------|-------|------------|----------------|--------------------------------------|
|   0    |   6   | group_id   | node_id_v0     | min op id across the batch           |
|   6    |   4   | op_count   | u32 LE         | number of inner ops that follow      |
|  10+   |  ...  | ops        | framed sequence| `op_count` framed inner messages     |

Each inner op is framed per the **Framing** rule in `discriminators.md`:
fixed-size ops (hide/show) write `[disc: u16 LE][fixed payload]`, variable
ones (insert) write `[disc: u16 LE][len: u32 LE][payload: len bytes]`.

Inner ops are not required to all be the same type — a single batch can
mix inserts, hides, and shows. They are decoded in order.

## Allowed inner discriminators

| disc | type        | shape       |
|------|-------------|-------------|
|  0   | insert_v0   | variable    |
|  1   | hide_v0     | fixed (16)  |
|  2   | show_v0     | fixed (16)  |

Encountering any other inner discriminator during decode is a hard error —
extending the inner-op universe requires `multi_op_v1`.

## Encoder/decoder contract

The codec in this file is the **framing layer only**: it does not parse the
inner ops, just emits/walks `(disc, payload_bytes)` tuples. Callers
encode/decode inner payloads using `insert_v0`, `hide_v0`, `show_v0`
themselves. This keeps multi_op independent of the op zoo's churn.

Each language exposes:

- `DISC` — `3`.
- `encode(group_id, ops, out)` where `ops` is a sequence of
  `{disc, payload}` items. Writes the multi_op payload (not the outer
  frame — that's transport's job). Returns bytes written.
- `decode(buf)` → `{group_id, ops}` where `ops` is a list of
  `{disc, payload}` items.

The framer consults the fixed-size table for inner discriminators when
deciding whether to read a length prefix or a fixed number of bytes. That
table mirrors the **Allowed inner discriminators** section above.

## Migrations

None. This is `v0`.
