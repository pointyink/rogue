const std = @import("std");

/// Unique identifier for a CRDT operation/node.
/// 48-bit logical value: replica_id (u16) + sequence (u32).
/// Field order is significant: replica_id in low bits, sequence in high bits,
/// so @bitCast to u48 gives sequence-first ordering for free.
pub const NodeId = packed struct(u48) {
    replica_id: u16,
    sequence: u32,

    pub const NULL = NodeId{ .sequence = 0, .replica_id = 0 };

    pub fn isNull(self: NodeId) bool {
        return @as(u48, @bitCast(self)) == 0;
    }

    pub fn eql(self: NodeId, other: NodeId) bool {
        return @as(u48, @bitCast(self)) == @as(u48, @bitCast(other));
    }

    /// Deterministic total order: sequence first, replica_id as tiebreaker.
    pub fn lessThan(self: NodeId, other: NodeId) bool {
        return @as(u48, @bitCast(self)) < @as(u48, @bitCast(other));
    }

    pub const HashContext = struct {
        pub fn hash(_: HashContext, key: NodeId) u64 {
            const raw: u64 = (@as(u64, key.replica_id) << 32) | @as(u64, key.sequence);
            return std.hash.Wyhash.hash(0, std.mem.asBytes(&raw));
        }
        pub fn eql(_: HashContext, a: NodeId, b: NodeId) bool {
            return a.eql(b);
        }
    };
};

test "NodeId bit size" {
    try std.testing.expectEqual(48, @bitSizeOf(NodeId));
}

test "NodeId NULL" {
    try std.testing.expect(NodeId.NULL.isNull());
    const non_null = NodeId{ .sequence = 1, .replica_id = 0 };
    try std.testing.expect(!non_null.isNull());
}

/// Composite key for the op treap.
///
/// Field layout (low → high bits): op_seq, group_seq, group_replica.
/// @bitCast to u80 gives a branchless comparison with group_replica-first
/// ordering, so all ops from the same replica are packed contiguously.
/// This prevents cross-replica ops from being interleaved between ops of
/// the same group during floor/ceiling searches.
///
/// op_replica is elided: every op in a group shares the replica of its group.
/// Use groupId()/opId() to reconstruct full NodeIds.
pub const CompositeId = packed struct(u80) {
    op_seq: u32, // bits  0-31
    group_seq: u32, // bits 32-63
    group_replica: u16, // bits 64-79

    pub fn groupId(self: CompositeId) NodeId {
        return .{ .replica_id = self.group_replica, .sequence = self.group_seq };
    }

    pub fn opId(self: CompositeId) NodeId {
        return .{ .replica_id = self.group_replica, .sequence = self.op_seq };
    }

    pub fn lessThan(a: CompositeId, b: CompositeId) bool {
        return @as(u80, @bitCast(a)) < @as(u80, @bitCast(b));
    }
};

test "CompositeId: group dominates, op_seq breaks ties, cross-replica safe" {
    const make = struct {
        fn f(r: u16, g: u32, o: u32) CompositeId {
            return .{ .group_replica = r, .group_seq = g, .op_seq = o };
        }
    }.f;

    const a = make(1, 5, 1); // replica 1, group 5, op 1
    const b = make(1, 5, 2); // replica 1, group 5, op 2
    const c = make(1, 6, 1); // replica 1, group 6, op 1
    const r2 = make(2, 3, 3); // replica 2, group 3 — lower seq but different replica

    // same group: op_seq breaks tie
    try std.testing.expect(a.lessThan(b));
    try std.testing.expect(!b.lessThan(a));

    // different group: group_seq dominates
    try std.testing.expect(a.lessThan(c));
    try std.testing.expect(b.lessThan(c));
    try std.testing.expect(!c.lessThan(a));

    // cross-replica: replica 1 always < replica 2 regardless of seq
    try std.testing.expect(a.lessThan(r2));
    try std.testing.expect(b.lessThan(r2));
    try std.testing.expect(c.lessThan(r2));

    // reconstruction
    try std.testing.expectEqual(NodeId{ .replica_id = 1, .sequence = 5 }, a.groupId());
    try std.testing.expectEqual(NodeId{ .replica_id = 1, .sequence = 1 }, a.opId());
}

test "NodeId ordering: sequence first, replica_id as tiebreaker" {
    const a = NodeId{ .sequence = 1, .replica_id = 1 };
    const b = NodeId{ .sequence = 2, .replica_id = 1 }; // higher sequence
    const c = NodeId{ .sequence = 1, .replica_id = 2 }; // same sequence, higher replica
    // sequence dominates
    try std.testing.expect(a.lessThan(b));
    try std.testing.expect(!b.lessThan(a));
    // replica_id breaks ties
    try std.testing.expect(a.lessThan(c));
    try std.testing.expect(!c.lessThan(a));
    // higher sequence beats higher replica_id
    try std.testing.expect(c.lessThan(b));
}

test "bench: field-by-field vs bitcast comparison" {
    // NodeId with current layout: { sequence: u32, replica_id: u16 }
    // As u48: replica_id in high bits -> bitcast compares replica_id first (not what we want).
    // Reordered layout: { replica_id: u16, sequence: u32 }
    // As u48: sequence in high bits -> bitcast compares sequence first (desired).
    const NodeIdBitcast = packed struct(u48) {
        replica_id: u16,
        sequence: u32,
        fn lessThan(self: @This(), other: @This()) bool {
            return @as(u48, @bitCast(self)) < @as(u48, @bitCast(other));
        }
    };
    const NodeIdFields = packed struct(u48) {
        sequence: u32,
        replica_id: u16,
        fn lessThan(self: @This(), other: @This()) bool {
            if (self.sequence != other.sequence) return self.sequence < other.sequence;
            return self.replica_id < other.replica_id;
        }
    };

    const N = 10_000_000;
    var prng = std.Random.DefaultPrng.init(42);
    const rand = prng.random();

    const pairs_f = try std.testing.allocator.alloc([2]NodeIdFields, N);
    defer std.testing.allocator.free(pairs_f);
    const pairs_b = try std.testing.allocator.alloc([2]NodeIdBitcast, N);
    defer std.testing.allocator.free(pairs_b);

    for (0..N) |i| {
        const seq_a = rand.int(u32);
        const rep_a = rand.int(u16);
        const seq_b = rand.int(u32);
        const rep_b = rand.int(u16);
        pairs_f[i] = .{ .{ .sequence = seq_a, .replica_id = rep_a }, .{ .sequence = seq_b, .replica_id = rep_b } };
        pairs_b[i] = .{ .{ .sequence = seq_a, .replica_id = rep_a }, .{ .sequence = seq_b, .replica_id = rep_b } };
    }

    // Validate both produce identical ordering across all pairs.
    for (pairs_f, pairs_b) |pf, pb| {
        const by_fields = pf[0].lessThan(pf[1]);
        const by_bits = pb[0].lessThan(pb[1]);
        try std.testing.expectEqual(by_fields, by_bits);
    }

    var sink: u64 = 0;
    var timer = try std.time.Timer.start();
    for (pairs_f) |p| if (p[0].lessThan(p[1])) {
        sink +%= 1;
    };
    const ns_fields = timer.read();

    timer.reset();
    for (pairs_b) |p| if (p[0].lessThan(p[1])) {
        sink +%= 1;
    };
    const ns_bits = timer.read();

    std.debug.print("field-by-field: {}ms ({} ns/op)\n", .{ ns_fields / std.time.ns_per_ms, ns_fields / N });
    std.debug.print("bitcast:        {}ms ({} ns/op)\n", .{ ns_bits / std.time.ns_per_ms, ns_bits / N });
    std.debug.print("(sink={})\n", .{sink});
}
