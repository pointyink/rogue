# Discriminators

Canonical name → number table for binary serde types that travel on the wire
as top-level messages.

**Append-only. Never reuse a number. Never repurpose a name.** Once a type
is on the wire it lives forever — old peers will decode old bytes by these
IDs. To replace a type, add a new version (`foo_v1`) and a `migrate_from_v0`
in the new version's file. The old `foo_v0` stays.

The cross-language fuzz harness asserts every implementation agrees on the
values below.

## Registry

Encoded as a **`u16` little-endian** on the wire — 64k values, with headroom
to spare. Same width whether the discriminator appears as the top-level
wire-frame tag *or* embedded inside another typed message (e.g. an op
inside `multi_op_v0`).

| value | name        | shape       | notes                                            |
|-------|-------------|-------------|--------------------------------------------------|
|  0    | insert_v0   | variable    | CRDT insert op                                   |
|  1    | hide_v0     | fixed (16)  | CRDT hide op                                     |
|  2    | show_v0     | fixed (16)  | CRDT show op                                     |
|  3    | multi_op_v0 | variable    | atomic batch of ops, the unit of replication     |
|  4    | ack_v0      | variable    | server → client durability ack (1+ group ids)    |
|  5    | json_envelope_v0 | variable | thin wrapper carrying a JSON payload          |
|  6    | insert_bytes_v0 | variable | byte-native CRDT insert op (raw u8 content)    |

## Framing

Every typed message — at the top level **or** embedded inside another
discriminated type (e.g. an op inside `multi_op_v0`) — uses the same rule:

```
fixed (N)  →  [disc: u16 LE][payload: N bytes]
variable   →  [disc: u16 LE][len: u32 LE][payload: len bytes]
```

`len` covers only the payload (not `disc` or `len` itself). A type's
fixed-or-variable status is part of its identity and never changes for a
given discriminator — that's why the table above lists exact byte sizes for
fixed types. Decoders can rely on this to walk past unknown messages
safely.

## Reserved ranges

- `0x00–0x3F` — core CRDT + sync transport (this table)
- `0x40–0xBF` — future use
- `0xC0–0xFF` — experimental / local-only. Anything in this range is
  understood to be unstable and **must not** appear on a long-lived wire or
  in any persisted blob.

## Shared primitives (not in the registry)

Types that are *only ever embedded* inside discriminated types do not get a
number. They're versioned files that other codecs call into for layout
reuse. Current primitives:

- `node_id_v0` — 6-byte `(replica_id, sequence)`.

A primitive can be promoted to a discriminated type later by appending a new
row here; the existing files keep working since the layout doesn't change.

## Adding a discriminated type

1. Append the next free value with a unique name `<type>_v<N>`.
2. Write `serde/<type>_v<N>.md` describing the byte layout.
3. Implement `serde/<type>_v<N>.{zig,js,go}` against that spec.
4. If `N > 0`, the file must also export `migrate_from_v<N-1>`.
5. Add fuzz corpus + cross-language round-trip cases under `serde/fuzz/`.
