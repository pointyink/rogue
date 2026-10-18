//! insert_bytes_v0 — variable-shape byte-native CRDT insert op.
//! See `insert_bytes_v0.md`.
//! Payload: id(6) + parent(6) + side(1) + byte_count(4) + bytes(N).

const std = @import("std");
const node_id_v0 = @import("node_id_v0.zig");
const insert_v0 = @import("insert_v0.zig");

pub const DISC: u16 = 6;

/// Same side semantics as insert_v0; reuse the enum so fixture helpers and
/// callers don't need a second side type.
pub const Side = insert_v0.Side;

/// Owned representation of a decoded byte insert. `bytes` is allocated; caller
/// frees with the same allocator used for `decode`.
pub const Insert = struct {
    id: node_id_v0.NodeId,
    parent: node_id_v0.NodeId,
    side: Side,
    bytes: []u8,
};

pub const HEADER_SIZE: usize = 17; // id(6) + parent(6) + side(1) + byte_count(4)

pub fn encodedSize(byte_count: usize) usize {
    return HEADER_SIZE + byte_count;
}

/// Encode an insert payload into `out`. `out` must be at least
/// `encodedSize(bytes.len)` bytes long. Returns bytes written.
pub fn encode(
    id: node_id_v0.NodeId,
    parent: node_id_v0.NodeId,
    side: Side,
    bytes: []const u8,
    out: []u8,
) usize {
    const total = encodedSize(bytes.len);
    std.debug.assert(out.len >= total);

    var off: usize = 0;
    node_id_v0.encode(id, out, off);
    off += node_id_v0.SIZE;
    node_id_v0.encode(parent, out, off);
    off += node_id_v0.SIZE;
    out[off] = @intFromEnum(side);
    off += 1;
    std.mem.writeInt(u32, out[off .. off + 4][0..4], @intCast(bytes.len), .little);
    off += 4;
    @memcpy(out[off .. off + bytes.len], bytes);
    off += bytes.len;
    return off;
}

pub const DecodeError = error{
    Truncated,
    InvalidSide,
    OutOfMemory,
};

/// Decode an insert payload. `bytes` is allocated with `allocator` (caller
/// frees). Other fields are by-value.
pub fn decode(allocator: std.mem.Allocator, buf: []const u8) DecodeError!Insert {
    if (buf.len < HEADER_SIZE) return error.Truncated;

    var off: usize = 0;
    const id = node_id_v0.decode(buf, off);
    off += node_id_v0.SIZE;
    const parent = node_id_v0.decode(buf, off);
    off += node_id_v0.SIZE;

    const side_raw = buf[off];
    off += 1;
    const side: Side = switch (side_raw) {
        0 => .Left,
        1 => .Right,
        2 => .Root,
        else => return error.InvalidSide,
    };

    const byte_count = std.mem.readInt(u32, buf[off .. off + 4][0..4], .little);
    off += 4;

    const need_bytes: usize = @as(usize, byte_count);
    if (off + need_bytes > buf.len) return error.Truncated;

    const bytes = try allocator.alloc(u8, byte_count);
    errdefer allocator.free(bytes);
    @memcpy(bytes, buf[off .. off + need_bytes]);
    return .{ .id = id, .parent = parent, .side = side, .bytes = bytes };
}

// ---- tests ----

test "round-trip: empty bytes, side=Left" {
    var buf: [HEADER_SIZE]u8 = undefined;
    const id = node_id_v0.NodeId{ .replica_id = 1, .sequence = 10 };
    const parent = node_id_v0.NodeId{ .replica_id = 1, .sequence = 9 };
    const n = encode(id, parent, .Left, &[_]u8{}, buf[0..]);
    try std.testing.expectEqual(@as(usize, HEADER_SIZE), n);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.bytes);
    try std.testing.expectEqual(id.replica_id, got.id.replica_id);
    try std.testing.expectEqual(parent.sequence, got.parent.sequence);
    try std.testing.expectEqual(Side.Left, got.side);
    try std.testing.expectEqual(@as(usize, 0), got.bytes.len);
}

test "round-trip: ascii 'Hi', side=Right" {
    const bytes = [_]u8{ 'H', 'i' };
    var buf: [HEADER_SIZE + 2]u8 = undefined;
    const id = node_id_v0.NodeId{ .replica_id = 7, .sequence = 100 };
    const parent = node_id_v0.NodeId{ .replica_id = 7, .sequence = 99 };
    const n = encode(id, parent, .Right, &bytes, buf[0..]);
    try std.testing.expectEqual(@as(usize, HEADER_SIZE + 2), n);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.bytes);
    try std.testing.expectEqualSlices(u8, &bytes, got.bytes);
    try std.testing.expectEqual(Side.Right, got.side);
}

test "round-trip: all byte values" {
    var bytes: [256]u8 = undefined;
    for (&bytes, 0..) |*b, i| b.* = @intCast(i);
    var buf: [HEADER_SIZE + bytes.len]u8 = undefined;
    const id = node_id_v0.NodeId{ .replica_id = 9, .sequence = 1 };
    const parent = node_id_v0.NodeId{ .replica_id = 9, .sequence = 0 };
    const n = encode(id, parent, .Root, &bytes, buf[0..]);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.bytes);
    try std.testing.expectEqualSlices(u8, &bytes, got.bytes);
}

test "decode rejects truncated header" {
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, &[_]u8{}));
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, &[_]u8{0} ** 10));
}

test "decode rejects invalid side" {
    var buf = [_]u8{0} ** HEADER_SIZE;
    buf[12] = 99;
    try std.testing.expectError(error.InvalidSide, decode(std.testing.allocator, &buf));
}

test "decode rejects truncated bytes" {
    var buf = [_]u8{0} ** (HEADER_SIZE + 2);
    buf[12] = 1;
    std.mem.writeInt(u32, buf[13..17][0..4], 5, .little);
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, &buf));
}
