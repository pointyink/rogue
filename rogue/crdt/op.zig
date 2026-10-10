const std = @import("std");
const NodeId = @import("node_id.zig").NodeId;

/// Which side of a Fugue parent a node sits on.
pub const Side = enum { Left, Right, Root };

/// A single op within a MultiOp. No group_id here — that lives on the MultiOp container.
pub fn WireOp(comptime Char: type) type {
    return union(enum) {
        insert: struct { id: NodeId, parent: NodeId, side: Side, chars: []const Char },
        hide: struct { id: NodeId, target: NodeId, len: u32 },
        show: struct { id: NodeId, target: NodeId, len: u32 },

        pub fn opId(self: @This()) NodeId {
            return switch (self) {
                inline else => |o| o.id,
            };
        }

        /// Sort key: (type_ord, target.replica_id, target.sequence).
        /// Inserts sort last since they are never merged.
        fn sortKey(self: @This()) u64 {
            return switch (self) {
                .hide => |h| (@as(u64, h.target.replica_id) << 32) | h.target.sequence,
                .show => |s| (@as(u64, s.target.replica_id) << 32) | s.target.sequence,
                .insert => std.math.maxInt(u64),
            };
        }
    };
}

/// Sort by (replica, sequence) then merge adjacent same-type consecutive runs.
/// Inserts sort last. No allocation — sorts and compacts in place.
pub fn compress(comptime Char: type, ops: []WireOp(Char)) []WireOp(Char) {
    if (ops.len <= 1) return ops;
    std.sort.pdq(WireOp(Char), ops, {}, struct {
        fn lt(_: void, a: WireOp(Char), b: WireOp(Char)) bool {
            return a.sortKey() < b.sortKey();
        }
    }.lt);
    var write: usize = 0;
    var candidate: usize = 1;
    while (candidate < ops.len) : (candidate += 1) {
        if (!tryMerge(Char, &ops[write], ops[candidate])) {
            write += 1;
            ops[write] = ops[candidate];
        }
    }
    return ops[0 .. write + 1];
}

fn tryMerge(comptime Char: type, cur: *WireOp(Char), next: WireOp(Char)) bool {
    switch (cur.*) {
        .hide => |*h| {
            const n = switch (next) {
                .hide => |n| n,
                else => return false,
            };
            if (n.target.replica_id != h.target.replica_id) return false;
            if (n.target.sequence != h.target.sequence + h.len) return false;
            h.len += n.len;
            return true;
        },
        .show => |*s| {
            const n = switch (next) {
                .show => |n| n,
                else => return false,
            };
            if (n.target.replica_id != s.target.replica_id) return false;
            if (n.target.sequence != s.target.sequence + s.len) return false;
            s.len += n.len;
            return true;
        },
        .insert => return false,
    }
}

/// The envelope sent over the wire. group_id is the min op id across all ops in this batch.
pub fn MultiOp(comptime Char: type) type {
    return struct {
        group_id: NodeId,
        ops: []const WireOp(Char),
    };
}

test "compress: merges consecutive same-replica hide ops" {
    const Op = WireOp(u16);
    var ops = [_]Op{
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 3 }, .len = 1 } },
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 1 }, .len = 1 } },
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 2 }, .len = 1 } },
    };
    const result = compress(u16, &ops);
    try std.testing.expectEqual(@as(usize, 1), result.len);
    try std.testing.expectEqual(@as(u32, 1), result[0].hide.target.sequence);
    try std.testing.expectEqual(@as(u32, 3), result[0].hide.len);
}

test "compress: does not merge across replicas" {
    const Op = WireOp(u16);
    var ops = [_]Op{
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 1 }, .len = 1 } },
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 2, .sequence = 2 }, .len = 1 } },
    };
    const result = compress(u16, &ops);
    try std.testing.expectEqual(@as(usize, 2), result.len);
}

test "compress: does not merge hide with show" {
    const Op = WireOp(u16);
    var ops = [_]Op{
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 1 }, .len = 1 } },
        .{ .show = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 2 }, .len = 1 } },
    };
    const result = compress(u16, &ops);
    try std.testing.expectEqual(@as(usize, 2), result.len);
}

test "compress: merges show runs, hides and shows independently" {
    const Op = WireOp(u16);
    var ops = [_]Op{
        .{ .show = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 5 }, .len = 1 } },
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 2, .sequence = 1 }, .len = 1 } },
        .{ .show = .{ .id = NodeId.NULL, .target = .{ .replica_id = 1, .sequence = 6 }, .len = 1 } },
        .{ .hide = .{ .id = NodeId.NULL, .target = .{ .replica_id = 2, .sequence = 2 }, .len = 1 } },
    };
    const result = compress(u16, &ops);
    // shows: replica 1, seq 5+6 → len 2 (sorts first, r1 < r2)
    // hides: replica 2, seq 1+2 → len 2
    try std.testing.expectEqual(@as(usize, 2), result.len);
    try std.testing.expectEqual(@as(u32, 2), result[0].show.len);
    try std.testing.expectEqual(@as(u32, 2), result[1].hide.len);
}
