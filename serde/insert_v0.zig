//! insert_v0 — variable-shape CRDT insert op. See `insert_v0.md`.
//! Payload: id(6) + parent(6) + side(1) + char_count(4) + chars(2*N).

const std = @import("std");
const node_id_v0 = @import("node_id_v0.zig");

pub const DISC: u16 = 0;

pub const Side = enum(u8) {
    Left = 0,
    Right = 1,
    Root = 2,
};

/// Owned representation of a decoded insert. `chars` is allocated; caller
/// frees with the same allocator used for `decode`.
pub const Insert = struct {
    id: node_id_v0.NodeId,
    parent: node_id_v0.NodeId,
    side: Side,
    chars: []u16,
};

pub const HEADER_SIZE: usize = 17; // id(6) + parent(6) + side(1) + char_count(4)

pub fn encodedSize(char_count: usize) usize {
    return HEADER_SIZE + 2 * char_count;
}

/// Encode an insert payload into `out`. `out` must be at least
/// `encodedSize(chars.len)` bytes long. Returns bytes written.
pub fn encode(
    id: node_id_v0.NodeId,
    parent: node_id_v0.NodeId,
    side: Side,
    chars: []const u16,
    out: []u8,
) usize {
    const total = encodedSize(chars.len);
    std.debug.assert(out.len >= total);

    var off: usize = 0;
    node_id_v0.encode(id, out, off);
    off += node_id_v0.SIZE;
    node_id_v0.encode(parent, out, off);
    off += node_id_v0.SIZE;
    out[off] = @intFromEnum(side);
    off += 1;
    std.mem.writeInt(u32, out[off .. off + 4][0..4], @intCast(chars.len), .little);
    off += 4;
    for (chars) |c| {
        std.mem.writeInt(u16, out[off .. off + 2][0..2], c, .little);
        off += 2;
    }
    return off;
}

pub const DecodeError = error{
    Truncated,
    InvalidSide,
    OutOfMemory,
};

/// Decode an insert payload. `chars` is allocated with `allocator` (caller
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

    const char_count = std.mem.readInt(u32, buf[off .. off + 4][0..4], .little);
    off += 4;

    const need_bytes: usize = 2 * @as(usize, char_count);
    if (off + need_bytes > buf.len) return error.Truncated;

    const chars = try allocator.alloc(u16, char_count);
    errdefer allocator.free(chars);
    for (chars, 0..) |*slot, i| {
        const start = off + 2 * i;
        slot.* = std.mem.readInt(u16, buf[start .. start + 2][0..2], .little);
    }
    return .{ .id = id, .parent = parent, .side = side, .chars = chars };
}

// ---- tests ----

test "round-trip: empty chars, side=Left" {
    var buf: [HEADER_SIZE]u8 = undefined;
    const id = node_id_v0.NodeId{ .replica_id = 1, .sequence = 10 };
    const parent = node_id_v0.NodeId{ .replica_id = 1, .sequence = 9 };
    const n = encode(id, parent, .Left, &[_]u16{}, buf[0..]);
    try std.testing.expectEqual(@as(usize, HEADER_SIZE), n);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.chars);
    try std.testing.expectEqual(id.replica_id, got.id.replica_id);
    try std.testing.expectEqual(parent.sequence, got.parent.sequence);
    try std.testing.expectEqual(Side.Left, got.side);
    try std.testing.expectEqual(@as(usize, 0), got.chars.len);
}

test "round-trip: ascii 'Hi', side=Right" {
    const chars = [_]u16{ 'H', 'i' };
    var buf: [HEADER_SIZE + 4]u8 = undefined;
    const id = node_id_v0.NodeId{ .replica_id = 7, .sequence = 100 };
    const parent = node_id_v0.NodeId{ .replica_id = 7, .sequence = 99 };
    const n = encode(id, parent, .Right, &chars, buf[0..]);

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.chars);
    try std.testing.expectEqual(Side.Right, got.side);
    try std.testing.expectEqualSlices(u16, &chars, got.chars);
}

test "round-trip: emoji surrogate pair, side=Root" {
    // U+1F600 (😀) = surrogate pair D83D DE00
    const chars = [_]u16{ 0xD83D, 0xDE00 };
    var buf: [HEADER_SIZE + 4]u8 = undefined;
    const n = encode(
        .{ .replica_id = 0, .sequence = 0 },
        .{ .replica_id = 0, .sequence = 0 },
        .Root,
        &chars,
        buf[0..],
    );

    const got = try decode(std.testing.allocator, buf[0..n]);
    defer std.testing.allocator.free(got.chars);
    try std.testing.expectEqual(Side.Root, got.side);
    try std.testing.expectEqualSlices(u16, &chars, got.chars);
}

test "decode: rejects invalid side" {
    var buf = [_]u8{0} ** HEADER_SIZE;
    buf[12] = 99; // invalid side
    try std.testing.expectError(error.InvalidSide, decode(std.testing.allocator, buf[0..]));
}

test "decode: rejects truncated header" {
    var buf = [_]u8{0} ** 10;
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, buf[0..]));
}

test "decode: rejects truncated chars" {
    var buf = [_]u8{0} ** HEADER_SIZE;
    // char_count=5 (declares 10 bytes of chars), but no chars follow
    std.mem.writeInt(u32, buf[13..17][0..4], 5, .little);
    try std.testing.expectError(error.Truncated, decode(std.testing.allocator, buf[0..]));
}

test "byte layout: header order is id, parent, side, char_count, then chars LE" {
    const chars = [_]u16{ 0x0048, 0x0069 }; // "Hi"
    var buf: [HEADER_SIZE + 4]u8 = undefined;
    _ = encode(
        .{ .replica_id = 0x0201, .sequence = 0x06050403 },
        .{ .replica_id = 0x0A09, .sequence = 0x0E0D0C0B },
        .Right,
        &chars,
        buf[0..],
    );
    const expected = [_]u8{
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, // id
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x0E, // parent
        0x01, // side = Right
        0x02, 0x00, 0x00, 0x00, // char_count = 2
        0x48, 0x00, 0x69, 0x00, // chars: 'H' (LE), 'i' (LE)
    };
    try std.testing.expectEqualSlices(u8, &expected, buf[0..]);
}
