//! show_v0 — fixed-shape (16 byte) CRDT show op. See `show_v0.md`.
//! Same wire layout as hide_v0; the discriminator carries the difference.

const std = @import("std");
const node_id_v0 = @import("node_id_v0.zig");

pub const DISC: u16 = 2;
pub const SIZE: usize = 16;

pub const Show = struct {
    id: node_id_v0.NodeId,
    target: node_id_v0.NodeId,
    len: u32,
};

pub fn encode(show: Show, out: []u8) void {
    std.debug.assert(out.len >= SIZE);
    node_id_v0.encode(show.id, out, 0);
    node_id_v0.encode(show.target, out, 6);
    std.mem.writeInt(u32, out[12..16][0..4], show.len, .little);
}

pub const DecodeError = error{Truncated};

pub fn decode(buf: []const u8) DecodeError!Show {
    if (buf.len < SIZE) return error.Truncated;
    return .{
        .id = node_id_v0.decode(buf, 0),
        .target = node_id_v0.decode(buf, 6),
        .len = std.mem.readInt(u32, buf[12..16][0..4], .little),
    };
}

test "round-trip" {
    var buf: [SIZE]u8 = undefined;
    const s = Show{
        .id = .{ .replica_id = 7, .sequence = 100 },
        .target = .{ .replica_id = 3, .sequence = 42 },
        .len = 5,
    };
    encode(s, buf[0..]);
    const got = try decode(buf[0..]);
    try std.testing.expectEqual(s.id.replica_id, got.id.replica_id);
    try std.testing.expectEqual(s.target.sequence, got.target.sequence);
    try std.testing.expectEqual(s.len, got.len);
}

test "decode: rejects truncated" {
    var buf = [_]u8{0} ** 10;
    try std.testing.expectError(error.Truncated, decode(buf[0..]));
}
