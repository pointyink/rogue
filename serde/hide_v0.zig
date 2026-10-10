//! hide_v0 — fixed-shape (16 byte) CRDT hide op. See `hide_v0.md`.
//! Payload: id(6) + target(6) + len(4). Identical wire shape to show_v0;
//! the discriminator carries the semantic difference.

const std = @import("std");
const node_id_v0 = @import("node_id_v0.zig");

pub const DISC: u16 = 1;
pub const SIZE: usize = 16;

pub const Hide = struct {
    id: node_id_v0.NodeId,
    target: node_id_v0.NodeId,
    len: u32,
};

pub fn encode(hide: Hide, out: []u8) void {
    std.debug.assert(out.len >= SIZE);
    node_id_v0.encode(hide.id, out, 0);
    node_id_v0.encode(hide.target, out, 6);
    std.mem.writeInt(u32, out[12..16][0..4], hide.len, .little);
}

pub const DecodeError = error{Truncated};

pub fn decode(buf: []const u8) DecodeError!Hide {
    if (buf.len < SIZE) return error.Truncated;
    return .{
        .id = node_id_v0.decode(buf, 0),
        .target = node_id_v0.decode(buf, 6),
        .len = std.mem.readInt(u32, buf[12..16][0..4], .little),
    };
}

// ---- tests ----

test "round-trip" {
    var buf: [SIZE]u8 = undefined;
    const h = Hide{
        .id = .{ .replica_id = 7, .sequence = 100 },
        .target = .{ .replica_id = 3, .sequence = 42 },
        .len = 5,
    };
    encode(h, buf[0..]);
    const got = try decode(buf[0..]);
    try std.testing.expectEqual(h.id.replica_id, got.id.replica_id);
    try std.testing.expectEqual(h.target.sequence, got.target.sequence);
    try std.testing.expectEqual(h.len, got.len);
}

test "decode: rejects truncated" {
    var buf = [_]u8{0} ** 10;
    try std.testing.expectError(error.Truncated, decode(buf[0..]));
}

test "byte layout: id, target, len LE" {
    var buf: [SIZE]u8 = undefined;
    encode(.{
        .id = .{ .replica_id = 0x0201, .sequence = 0x06050403 },
        .target = .{ .replica_id = 0x0807, .sequence = 0x0C0B0A09 },
        .len = 0x100D0E0F,
    }, buf[0..]);
    try std.testing.expectEqualSlices(u8, &[_]u8{
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, // id
        0x07, 0x08, 0x09, 0x0A, 0x0B, 0x0C, // target
        0x0F, 0x0E, 0x0D, 0x10, // len LE
    }, buf[0..]);
}

test "len = 0 round-trips (decoder permissive)" {
    var buf: [SIZE]u8 = undefined;
    encode(.{ .id = .{ .replica_id = 1, .sequence = 1 }, .target = .{ .replica_id = 1, .sequence = 1 }, .len = 0 }, buf[0..]);
    const got = try decode(buf[0..]);
    try std.testing.expectEqual(@as(u32, 0), got.len);
}
