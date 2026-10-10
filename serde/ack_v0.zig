//! ack_v0 — variable-shape server → client durability ack. See `ack_v0.md`.
//! Payload: count(4) + N × node_id_v0.

const std = @import("std");
const node_id_v0 = @import("node_id_v0.zig");

pub const DISC: u16 = 4;
pub const HEADER_SIZE: usize = 4;

pub fn encodedSize(count: usize) usize {
    return HEADER_SIZE + node_id_v0.SIZE * count;
}

/// Encode an ack payload into `out`. `out` must be at least
/// `encodedSize(group_ids.len)` bytes long. Returns bytes written.
pub fn encode(group_ids: []const node_id_v0.NodeId, out: []u8) usize {
    const total = encodedSize(group_ids.len);
    std.debug.assert(out.len >= total);

    var off: usize = 0;
    std.mem.writeInt(u32, out[off .. off + 4][0..4], @intCast(group_ids.len), .little);
    off += 4;
    for (group_ids) |id| {
        node_id_v0.encode(id, out, off);
        off += node_id_v0.SIZE;
    }
    return off;
}

pub const DecodeError = error{
    Truncated,
    OutOfMemory,
};

pub const Decoded = struct {
    group_ids: []node_id_v0.NodeId,
};

/// Decode an ack payload. The returned `group_ids` slice is allocated with
/// `allocator` (caller frees).
pub fn decode(allocator: std.mem.Allocator, buf: []const u8) DecodeError!Decoded {
    if (buf.len < HEADER_SIZE) return error.Truncated;
    const count = std.mem.readInt(u32, buf[0..4][0..4], .little);

    const need_bytes: usize = HEADER_SIZE + @as(usize, count) * node_id_v0.SIZE;
    if (need_bytes > buf.len) return error.Truncated;

    const ids = try allocator.alloc(node_id_v0.NodeId, count);
    errdefer allocator.free(ids);
    for (ids, 0..) |*slot, i| {
        slot.* = node_id_v0.decode(buf, HEADER_SIZE + i * node_id_v0.SIZE);
    }
    return .{ .group_ids = ids };
}

// ---- tests ----

test "round-trip: empty ack" {
    var buf: [HEADER_SIZE]u8 = undefined;
    const n = encode(&[_]node_id_v0.NodeId{}, buf[0..]);
    try std.testing.expectEqual(@as(usize, HEADER_SIZE), n);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.group_ids);
    try std.testing.expectEqual(@as(usize, 0), got.group_ids.len);
}

test "round-trip: single id" {
    var buf: [HEADER_SIZE + node_id_v0.SIZE]u8 = undefined;
    const id = node_id_v0.NodeId{ .replica_id = 7, .sequence = 42 };
    const n = encode(&[_]node_id_v0.NodeId{id}, buf[0..]);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.group_ids);
    try std.testing.expectEqual(@as(usize, 1), got.group_ids.len);
    try std.testing.expectEqual(id.replica_id, got.group_ids[0].replica_id);
    try std.testing.expectEqual(id.sequence, got.group_ids[0].sequence);
}

test "round-trip: three ids preserve order" {
    const ids = [_]node_id_v0.NodeId{
        .{ .replica_id = 1, .sequence = 10 },
        .{ .replica_id = 2, .sequence = 20 },
        .{ .replica_id = 3, .sequence = 30 },
    };
    var buf: [HEADER_SIZE + 3 * node_id_v0.SIZE]u8 = undefined;
    const n = encode(&ids, buf[0..]);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.group_ids);
    try std.testing.expectEqual(@as(usize, 3), got.group_ids.len);
    for (ids, got.group_ids) |expected, actual| {
        try std.testing.expectEqual(expected.replica_id, actual.replica_id);
        try std.testing.expectEqual(expected.sequence, actual.sequence);
    }
}

test "decode: rejects truncated header" {
    var buf = [_]u8{ 0, 0 };
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, buf[0..]));
}

test "decode: rejects truncated ids" {
    // count=2 but only 1 id worth of bytes follow
    var buf: [HEADER_SIZE + node_id_v0.SIZE]u8 = undefined;
    std.mem.writeInt(u32, buf[0..4][0..4], 2, .little);
    @memset(buf[4..], 0);
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, buf[0..]));
}

test "decode: count_overflow does not allocate" {
    // count = u32_max → ~25.7 GB. Must reject before allocating.
    var buf: [HEADER_SIZE]u8 = undefined;
    std.mem.writeInt(u32, buf[0..4][0..4], 0xFFFFFFFF, .little);
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, buf[0..]));
}

test "byte layout: count LE then ids" {
    const ids = [_]node_id_v0.NodeId{
        .{ .replica_id = 0x0201, .sequence = 0x06050403 },
    };
    var buf: [HEADER_SIZE + node_id_v0.SIZE]u8 = undefined;
    _ = encode(&ids, buf[0..]);
    try std.testing.expectEqualSlices(u8, &[_]u8{
        0x01, 0x00, 0x00, 0x00, // count=1 LE
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, // id
    }, buf[0..]);
}
