# node_id_v0

**Shared primitive** — embedded inside discriminated op types
(`insert_v0.parent_id`, `multi_op_v0.group_id`, `ack_v0.group_ids[i]`, …).
Never appears on the wire as a top-level message, so it has no discriminator
in `discriminators.md`.

The parent type's spec declares "bytes at offset X are a `node_id_v0`" and
the parent's codec calls `encode` / `decode` from this file directly.

## Layout

**6 bytes, little-endian, no padding.**

| offset | size | field      | type   | notes                       |
|--------|------|------------|--------|-----------------------------|
|   0    |   2  | replica_id | u16 LE | random per client / session |
|   2    |   4  | sequence   | u32 LE | per-replica op counter      |

## NULL

`replica_id = 0`, `sequence = 0` (all six bytes zero) is reserved as the
NULL sentinel — used for "no parent" / "no cursor". Encoders may emit it;
decoders must accept it.

## API

Each language exposes:

- `SIZE` — constant `6`.
- `encode(id, buf, offset)` — writes 6 bytes starting at `offset`.
- `decode(buf, offset)` — reads 6 bytes, returns `{replica_id, sequence}`.

## Migrations

None. This is `v0`.
