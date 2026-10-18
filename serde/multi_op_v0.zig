//! multi_op_v0 — framing layer for an atomic batch of CRDT ops.
//! See `multi_op_v0.md`. This codec emits/walks `(disc, payload)` tuples;
//! parsing inner payloads is the caller's job (insert_v0/hide_v0/show_v0).

const std = @import("std");
const node_id_v0 = @import("node_id_v0.zig");

pub const DISC: u16 = 3;
pub const DISC_SIZE: usize = 2;

/// Returns the fixed payload size for `disc` if that op is fixed-shape,
/// or null if it is variable (length-prefixed). Must agree with
/// `discriminators.md` and with peer implementations.
pub fn fixedOpSize(disc: u16) ?u32 {
    return switch (disc) {
        1, 2 => 16, // hide_v0 / show_v0 — `id(6) + target(6) + len(4)`
        else => null,
    };
}

pub const InnerOp = struct {
    disc: u16,
    payload: []const u8,
};

/// One framed inner op = 2 byte disc + (4 byte len, if variable) + payload.
fn framedSize(op: InnerOp) usize {
    return if (fixedOpSize(op.disc) != null) DISC_SIZE + op.payload.len else DISC_SIZE + 4 + op.payload.len;
}

/// Byte size of the multi_op payload. If ca_len is non-null, its value is
/// added to the total for the trailing content-address blob.
pub fn encodedSize(ops: []const InnerOp, ca_len: ?usize) usize {
    var n: usize = 6 + 4; // group_id + op_count
    for (ops) |op| n += framedSize(op);
    if (ca_len) |l| n += l;
    return n;
}

/// Encode the multi_op payload into `out`. Returns bytes written. Caller
/// must size `out` with `encodedSize`. If ca is non-null it is appended
/// verbatim after the last op as a trailing content-address blob.
pub fn encode(
    group_id: node_id_v0.NodeId,
    ops: []const InnerOp,
    ca: ?[]const u8,
    out: []u8,
) usize {
    var off: usize = 0;
    node_id_v0.encode(group_id, out, off);
    off += node_id_v0.SIZE;

    std.mem.writeInt(u32, out[off .. off + 4][0..4], @intCast(ops.len), .little);
    off += 4;

    for (ops) |op| {
        std.mem.writeInt(u16, out[off .. off + DISC_SIZE][0..2], op.disc, .little);
        off += DISC_SIZE;
        if (fixedOpSize(op.disc)) |size| {
            std.debug.assert(op.payload.len == size);
            @memcpy(out[off .. off + op.payload.len], op.payload);
            off += op.payload.len;
        } else {
            std.mem.writeInt(u32, out[off .. off + 4][0..4], @intCast(op.payload.len), .little);
            off += 4;
            @memcpy(out[off .. off + op.payload.len], op.payload);
            off += op.payload.len;
        }
    }
    if (ca) |c| {
        @memcpy(out[off .. off + c.len], c);
        off += c.len;
    }
    return off;
}

pub const Decoded = struct {
    group_id: node_id_v0.NodeId,
    /// Each slice points into the caller's `buf` — no copy, lifetime is tied
    /// to `buf`.
    ops: []InnerOp,
    /// Trailing content-address bytes, or null if the sender didn't attach one.
    ca: ?[]const u8 = null,
};

pub const DecodeError = error{
    Truncated,
    UnknownInnerDisc,
    OutOfMemory,
};

/// Decode a multi_op payload. Returned `ops` slice is allocated with
/// `allocator` (caller frees); each op's `payload` is a borrow into `buf`.
/// Any bytes remaining after the last op are returned as `ca`.
pub fn decode(
    allocator: std.mem.Allocator,
    buf: []const u8,
) DecodeError!Decoded {
    if (buf.len < node_id_v0.SIZE + 4) return error.Truncated;

    var off: usize = 0;
    const group_id = node_id_v0.decode(buf, off);
    off += node_id_v0.SIZE;

    const count = std.mem.readInt(u32, buf[off .. off + 4][0..4], .little);
    off += 4;

    const ops = try allocator.alloc(InnerOp, count);
    errdefer allocator.free(ops);

    var i: usize = 0;
    while (i < count) : (i += 1) {
        if (off + DISC_SIZE > buf.len) return error.Truncated;
        const disc = std.mem.readInt(u16, buf[off .. off + DISC_SIZE][0..2], .little);
        off += DISC_SIZE;

        if (fixedOpSize(disc)) |size| {
            if (off + size > buf.len) return error.Truncated;
            ops[i] = .{ .disc = disc, .payload = buf[off .. off + size] };
            off += size;
        } else if (disc == 0 or disc == 6) {
            // insert_v0 / insert_bytes_v0 — variable, length-prefixed
            if (off + 4 > buf.len) return error.Truncated;
            const len = std.mem.readInt(u32, buf[off .. off + 4][0..4], .little);
            off += 4;
            if (off + len > buf.len) return error.Truncated;
            ops[i] = .{ .disc = disc, .payload = buf[off .. off + len] };
            off += len;
        } else {
            return error.UnknownInnerDisc;
        }
    }
    const ca: ?[]const u8 = if (off < buf.len) buf[off..] else null;
    return .{ .group_id = group_id, .ops = ops, .ca = ca };
}

// ---- tests ----

test "round-trip: empty batch" {
    var buf: [10]u8 = undefined;
    const gid = node_id_v0.NodeId{ .replica_id = 7, .sequence = 42 };
    const n = encode(gid, &[_]InnerOp{}, null, buf[0..]);
    try std.testing.expectEqual(@as(usize, 10), n);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.ops);
    try std.testing.expectEqual(@as(u16, 7), got.group_id.replica_id);
    try std.testing.expectEqual(@as(u32, 42), got.group_id.sequence);
    try std.testing.expectEqual(@as(usize, 0), got.ops.len);
}

test "round-trip: one hide, one insert, one show" {
    const hide_payload = [_]u8{0xAA} ** 16;
    const insert_payload = [_]u8{ 0xDE, 0xAD, 0xBE, 0xEF, 0x01, 0x02 };
    const show_payload = [_]u8{0xBB} ** 16;

    const ops = [_]InnerOp{
        .{ .disc = 1, .payload = &hide_payload },
        .{ .disc = 0, .payload = &insert_payload },
        .{ .disc = 2, .payload = &show_payload },
    };
    const gid = node_id_v0.NodeId{ .replica_id = 1, .sequence = 100 };

    const size = encodedSize(&ops, null);
    const buf = try std.testing.allocator.alloc(u8, size);
    defer std.testing.allocator.free(buf);
    const n = encode(gid, &ops, null, buf);
    try std.testing.expectEqual(size, n);

    const got = try decode(std.testing.allocator, buf);
    defer std.testing.allocator.free(got.ops);
    try std.testing.expectEqual(@as(usize, 3), got.ops.len);

    try std.testing.expectEqual(@as(u16, 1), got.ops[0].disc);
    try std.testing.expectEqualSlices(u8, &hide_payload, got.ops[0].payload);

    try std.testing.expectEqual(@as(u16, 0), got.ops[1].disc);
    try std.testing.expectEqualSlices(u8, &insert_payload, got.ops[1].payload);

    try std.testing.expectEqual(@as(u16, 2), got.ops[2].disc);
    try std.testing.expectEqualSlices(u8, &show_payload, got.ops[2].payload);
}

test "decode: rejects unknown inner discriminator" {
    // group_id + op_count=1 + disc=0x9999 + nothing else
    var buf = [_]u8{
        0, 0, 0, 0, 0, 0, // group_id
        1, 0, 0, 0, // op_count = 1
        0x99, 0x99, // unknown disc (u16 LE)
    };
    try std.testing.expectError(error.UnknownInnerDisc, decode(std.testing.allocator, buf[0..]));
}

test "decode: rejects truncated payload" {
    // group_id + op_count=1 + disc=insert (u16 LE) + len=10 but only 4 bytes follow
    var buf = [_]u8{
        0, 0, 0, 0, 0, 0, // group_id
        1, 0, 0, 0, // op_count = 1
        0, 0, // disc = insert_v0 (u16 LE)
        10, 0, 0, 0, // len = 10
        1, 2, 3, 4, // only 4 bytes of payload
    };
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, buf[0..]));
}

test "decode: rejects truncated header" {
    var buf = [_]u8{ 0, 0, 0, 0, 0 }; // less than 10 bytes
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, buf[0..]));
}

test "byte layout: header is group_id then op_count, both LE" {
    var buf: [10]u8 = undefined;
    const gid = node_id_v0.NodeId{ .replica_id = 0x0201, .sequence = 0x06050403 };
    _ = encode(gid, &[_]InnerOp{}, null, buf[0..]);
    try std.testing.expectEqualSlices(
        u8,
        &[_]u8{ 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00 },
        buf[0..10],
    );
}
