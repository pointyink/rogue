//! node_id_v0 — shared primitive codec. See `node_id_v0.md` for the spec.
//!
//! Embedded inside discriminated op types; never appears standalone on
//! the wire. The struct here is the wire-time shape; runtime adapters
//! (e.g. `crdt/node_id.zig`) convert as needed.

const std = @import("std");

pub const SIZE: usize = 6;

pub const NodeId = struct {
    replica_id: u16,
    sequence: u32,
};

pub fn encode(id: NodeId, buf: []u8, offset: usize) void {
    std.debug.assert(buf.len >= offset + SIZE);
    std.mem.writeInt(u16, buf[offset .. offset + 2][0..2], id.replica_id, .little);
    std.mem.writeInt(u32, buf[offset + 2 .. offset + 6][0..4], id.sequence, .little);
}

pub fn decode(buf: []const u8, offset: usize) NodeId {
    std.debug.assert(buf.len >= offset + SIZE);
    return .{
        .replica_id = std.mem.readInt(u16, buf[offset .. offset + 2][0..2], .little),
        .sequence = std.mem.readInt(u32, buf[offset + 2 .. offset + 6][0..4], .little),
    };
}

test "round-trip: arbitrary id" {
    var buf: [SIZE]u8 = undefined;
    const id = NodeId{ .replica_id = 0xBEEF, .sequence = 0xCAFEF00D };
    encode(id, buf[0..], 0);
    const got = decode(buf[0..], 0);
    try std.testing.expectEqual(id.replica_id, got.replica_id);
    try std.testing.expectEqual(id.sequence, got.sequence);
}

test "round-trip: NULL" {
    var buf: [SIZE]u8 = undefined;
    const id = NodeId{ .replica_id = 0, .sequence = 0 };
    encode(id, buf[0..], 0);
    for (buf) |b| try std.testing.expectEqual(@as(u8, 0), b);
    const got = decode(buf[0..], 0);
    try std.testing.expectEqual(@as(u16, 0), got.replica_id);
    try std.testing.expectEqual(@as(u32, 0), got.sequence);
}

test "byte layout: little-endian, replica then sequence" {
    var buf: [SIZE]u8 = undefined;
    encode(.{ .replica_id = 0x0201, .sequence = 0x06050403 }, buf[0..], 0);
    try std.testing.expectEqualSlices(u8, &[_]u8{ 0x01, 0x02, 0x03, 0x04, 0x05, 0x06 }, buf[0..]);
}

test "encode at non-zero offset" {
    var buf: [SIZE + 4]u8 = .{0xAA} ** (SIZE + 4);
    encode(.{ .replica_id = 0x1234, .sequence = 0xDEADBEEF }, buf[0..], 2);
    // Guard bytes untouched.
    try std.testing.expectEqual(@as(u8, 0xAA), buf[0]);
    try std.testing.expectEqual(@as(u8, 0xAA), buf[1]);
    // Payload at offset 2.
    try std.testing.expectEqualSlices(u8, &[_]u8{ 0x34, 0x12, 0xEF, 0xBE, 0xAD, 0xDE }, buf[2..8]);
}

test "boundary values" {
    var buf: [SIZE]u8 = undefined;
    encode(.{ .replica_id = std.math.maxInt(u16), .sequence = std.math.maxInt(u32) }, buf[0..], 0);
    const got = decode(buf[0..], 0);
    try std.testing.expectEqual(@as(u16, std.math.maxInt(u16)), got.replica_id);
    try std.testing.expectEqual(@as(u32, std.math.maxInt(u32)), got.sequence);
}
