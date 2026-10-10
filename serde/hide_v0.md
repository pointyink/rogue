# hide_v0

Discriminator: **`1`**. Shape: **fixed, 16 bytes** (no length prefix when framed).

A CRDT hide op — marks a contiguous run of `len` nodes starting at `target`
as no longer visible. Same shape as `show_v0`; the discriminator carries
the semantic difference.

## Payload layout

| offset | size | field   | type        | notes                                     |
|--------|------|---------|-------------|-------------------------------------------|
|   0    |   6  | id      | node_id_v0  | this op's own NodeId                      |
|   6    |   6  | target  | node_id_v0  | first node in the hidden run              |
|  12    |   4  | len     | u32 LE      | how many consecutive nodes from `target`  |

Total: **16 bytes**.

## Fields

- **`id`** — the op's identity. Per-replica monotonic; never reused.
- **`target`** — the NodeId of the leftmost node in the run being hidden.
  The remaining `len - 1` nodes are the consecutive sibling sequence with
  matching `replica_id` and `sequence + i` for `i in 1..len`.
- **`len`** — must be `>= 1` for a meaningful op. The encoder doesn't
  enforce this; `len == 0` is malformed but a decoder will accept it
  (zero-length run is a no-op).

## Errors

Decoders must reject:
- `truncated` — payload is fewer than 16 bytes.

## Migrations

None. This is `v0`.
