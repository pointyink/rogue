# show_v0

Discriminator: **`2`**. Shape: **fixed, 16 bytes** (no length prefix when framed).

A CRDT show op — restores visibility on a contiguous run of `len` nodes
starting at `target`. Same shape as `hide_v0`; the discriminator carries
the semantic difference.

## Payload layout

| offset | size | field   | type        | notes                                     |
|--------|------|---------|-------------|-------------------------------------------|
|   0    |   6  | id      | node_id_v0  | this op's own NodeId                      |
|   6    |   6  | target  | node_id_v0  | first node in the restored run            |
|  12    |   4  | len     | u32 LE      | how many consecutive nodes from `target`  |

Total: **16 bytes**.

See `hide_v0.md` for field semantics — they are identical.

## Errors

Decoders must reject:
- `truncated` — payload is fewer than 16 bytes.

## Migrations

None. This is `v0`.
