//! content_address_v0 — compact version vector codec.
//!
//! Wire format: count(u8) + count × (replica_id: u16 LE, sequence: u32 LE).
//! An entry (r, s) means "all ops from replica r up to sequence s."
//!
//! Max 255 entries (far more than any practical CRDT replica count).

const std = @import("std");

pub const Entry = struct {
    replica_id: u16,
    sequence: u32,
};

const ENTRY_SIZE: usize = 6;

pub fn encodedSize(entries: []const Entry) usize {
    return 1 + entries.len * ENTRY_SIZE;
}

pub fn encode(entries: []const Entry, out: []u8) usize {
    std.debug.assert(entries.len <= 255);
    std.debug.assert(out.len >= encodedSize(entries));

    out[0] = @intCast(entries.len);
    var off: usize = 1;
    for (entries) |e| {
        std.mem.writeInt(u16, out[off .. off + 2][0..2], e.replica_id, .little);
        std.mem.writeInt(u32, out[off + 2 .. off + 6][0..4], e.sequence, .little);
        off += ENTRY_SIZE;
    }
    return off;
}

/// Decode content-address bytes into an entry slice. Caller must provide
/// `out` with enough capacity (max 255 entries, so [255]Entry on the stack
/// is always sufficient). Returns the slice of `out` that was filled.
pub fn decode(buf: []const u8, out: []Entry) []const Entry {
    if (buf.len < 1) return out[0..0];
    const count = buf[0];
    if (buf.len < 1 + @as(usize, count) * ENTRY_SIZE) return out[0..0];
    if (count == 0) return out[0..0];
    std.debug.assert(out.len >= count);
    var off: usize = 1;
    for (0..count) |i| {
        out[i] = .{
            .replica_id = std.mem.readInt(u16, buf[off .. off + 2][0..2], .little),
            .sequence = std.mem.readInt(u32, buf[off + 2 .. off + 6][0..4], .little),
        };
        off += ENTRY_SIZE;
    }
    return out[0..count];
}

test "round-trip: empty" {
    var buf: [1]u8 = undefined;
    const n = encode(&.{}, buf[0..]);
    try std.testing.expectEqual(@as(usize, 1), n);
    try std.testing.expectEqual(@as(u8, 0), buf[0]);
    var out: [1]Entry = undefined;
    const got = decode(buf[0..n], out[0..]);
    try std.testing.expectEqual(@as(usize, 0), got.len);
}

test "round-trip: single entry" {
    const entries = [_]Entry{.{ .replica_id = 1, .sequence = 42 }};
    var buf: [64]u8 = undefined;
    const n = encode(&entries, buf[0..]);
    try std.testing.expectEqual(@as(usize, 1 + 6), n);
    try std.testing.expectEqual(@as(u8, 1), buf[0]);
    var out: [16]Entry = undefined;
    const got = decode(buf[0..n], out[0..]);
    try std.testing.expectEqual(@as(usize, 1), got.len);
    try std.testing.expectEqual(@as(u16, 1), got[0].replica_id);
    try std.testing.expectEqual(@as(u32, 42), got[0].sequence);
}

test "round-trip: multiple entries" {
    const entries = [_]Entry{
        .{ .replica_id = 1, .sequence = 10 },
        .{ .replica_id = 2, .sequence = 20 },
        .{ .replica_id = 3, .sequence = 30 },
    };
    var buf: [64]u8 = undefined;
    const n = encode(&entries, buf[0..]);
    var out: [16]Entry = undefined;
    const got = decode(buf[0..n], out[0..]);
    try std.testing.expectEqual(entries.len, got.len);
    for (entries, got) |a, b| {
        try std.testing.expectEqual(a.replica_id, b.replica_id);
        try std.testing.expectEqual(a.sequence, b.sequence);
    }
}

test "decode: truncated buffer returns empty" {
    var buf: [1]u8 = [_]u8{3};
    var out: [4]Entry = undefined;
    const got = decode(buf[0..], out[0..]);
    try std.testing.expectEqual(@as(usize, 0), got.len);
}
