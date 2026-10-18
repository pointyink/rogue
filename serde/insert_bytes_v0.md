# insert_bytes_v0

Discriminator: **`6`**. Shape: **variable** (length-prefixed when framed).

A byte-native CRDT insert — places a run of raw bytes into the document,
anchored relative to a parent node. Unlike `insert_v0` (UTF-16 code units),
each element is one byte. Used by the byte engine for file sync.

This is a distinct content domain from `insert_v0` (raw bytes vs UTF-16
text), not a wire successor. There is no lossless `migrate_from_v0`.

## Payload layout

| offset | size               | field      | type         | notes                              |
|--------|--------------------|------------|--------------|------------------------------------|
|   0    |   6                | id         | node_id_v0   | this op's own NodeId               |
|   6    |   6                | parent     | node_id_v0   | the node this is anchored against  |
|  12    |   1                | side       | u8 enum      | `0=Left`, `1=Right`, `2=Root`      |
|  13    |   4                | byte_count | u32 LE       | number of bytes in `bytes`         |
|  17    | `byte_count`       | bytes      | u8 array     | raw content                        |

Total: **`17 + byte_count`** bytes.

## Fields

- **`id`** — the new node's identity. Per-replica monotonic; never reused.
- **`parent`** — the existing CRDT node this insert is anchored against.
  May be `NULL` (all zeros) when `side = Root`.
- **`side`** — which side of `parent` the run anchors on:
  - `0 (Left)` — leftward of `parent`
  - `1 (Right)` — rightward of `parent`
  - `2 (Root)` — root insert; `parent` is ignored (conventionally NULL).
- **`bytes`** — the inserted content as raw bytes. No UTF-16 decoding or
  text normalization. Every byte value `0x00–0xFF` is preserved.

## byte_count vs outer length

When `insert_bytes_v0` is embedded in `multi_op_v0`, the outer u32 length
prefix (from the standard variable-type framing) AND the internal
`byte_count` both describe the same payload — they are redundant by design.
Both must agree: `outer_len == 17 + byte_count`.

## Errors

Decoders must reject:

- `truncated` — header (17 bytes) or `bytes` (`byte_count` bytes) runs
  past the end of the payload.
- `invalid_side` — `side` byte is not `0`, `1`, or `2`.

## Migrations

None. This is a new op type, not a replacement for `insert_v0`.
