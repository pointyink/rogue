# insert_v0

Discriminator: **`0`**. Shape: **variable** (length-prefixed when framed).

A CRDT insert op — places a run of characters into the document, anchored
relative to a parent node.

## Payload layout

| offset | size               | field       | type         | notes                                |
|--------|--------------------|-------------|--------------|--------------------------------------|
|   0    |   6                | id          | node_id_v0   | this op's own NodeId                 |
|   6    |   6                | parent      | node_id_v0   | the node this is anchored against    |
|  12    |   1                | side        | u8 enum      | `0=Left`, `1=Right`, `2=Root`        |
|  13    |   4                | char_count  | u32 LE       | number of u16 code units in `chars`  |
|  17    | `2 * char_count`   | chars       | u16 LE array | UTF-16 code units                    |

Total: **`17 + 2 * char_count`** bytes.

## Fields

- **`id`** — the new node's identity. Per-replica monotonic; never reused.
- **`parent`** — the existing CRDT node this insert is anchored against.
  May be `NULL` (all zeros) when `side = Root`.
- **`side`** — which side of `parent` the run anchors on:
  - `0 (Left)` — leftward of `parent`
  - `1 (Right)` — rightward of `parent`
  - `2 (Root)` — root insert; `parent` is ignored (conventionally NULL).
- **`chars`** — the inserted content as raw UTF-16 LE code units. Emojis
  arrive as surrogate pairs (two u16 nodes). HTML tags (`<br>`) arrive as
  their literal ASCII characters. This is the codebase's existing
  `Rogue(u16)` invariant; no transcoding at the wire layer.

## char_count vs outer length

When `insert_v0` is embedded in `multi_op_v0`, the outer u32 length prefix
(from the standard variable-type framing) AND the internal `char_count`
both describe the same payload — they are redundant by design. The outer
length lets a generic multi_op walker skip past an insert; the internal
`char_count` keeps insert self-describing if ever sent standalone or
nested in a different container. Both must agree:
`outer_len == 17 + 2 * char_count`.

## Errors

Decoders must reject:
- `truncated` — header (17 bytes) or `chars` (2 * char_count bytes) runs
  past the end of the payload.
- `invalid_side` — `side` byte is not `0`, `1`, or `2`.

## Migrations

None. This is `v0`.
