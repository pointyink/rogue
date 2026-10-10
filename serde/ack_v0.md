# ack_v0

Discriminator: **`4`**. Shape: **variable** (length-prefixed when framed).

Server → client durability ack. A single ack message carries every group id
that landed in the same blob-flush boundary, so one network round-trip
acknowledges the entire batch.

## Payload layout

| offset | size           | field      | type                  | notes                          |
|--------|----------------|------------|-----------------------|--------------------------------|
|   0    |   4            | count      | u32 LE                | number of group ids that follow|
|   4    | `6 * count`    | group_ids  | array of `node_id_v0` | acked group NodeIds, in order  |

Total: **`4 + 6 * count`** bytes.

## Fields

- **`count`** — number of group ids in the ack. May be zero (a no-op ack is
  legal but uninteresting).
- **`group_ids`** — concatenated `node_id_v0` payloads, no length prefix
  per id since `node_id_v0` is fixed-size. Order has no semantic meaning;
  receivers should treat the ack as a set of group ids to drop from their
  pending queue.

## Errors

Decoders must reject:
- `truncated_header` — fewer than 4 bytes (no room for `count`).
- `truncated_ids` — `count` declares more ids than fit in the remaining
  bytes. A decoder must check `4 + 6 * count <= len(buf)` *before*
  allocating space for the ids array — `count = u32_max` would otherwise
  trigger a ~25 GB allocation attempt.

## Migrations

None. This is `v0`.
