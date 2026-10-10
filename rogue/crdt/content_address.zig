const std = @import("std");
const NodeId = @import("node_id.zig").NodeId;

pub const CaPair = struct { replica_id: u16, sequence: u32 };

/// A version vector mapping replica_id -> max_seq.
/// An op (replica_id, seq) is "included" if seq <= map[replica_id].
pub const ContentAddress = struct {
    map: std.AutoHashMapUnmanaged(u16, u32),
    cached_max: ?NodeId,

    pub fn init() ContentAddress {
        return .{ .map = .empty, .cached_max = null };
    }

    pub fn deinit(self: *ContentAddress, allocator: std.mem.Allocator) void {
        self.map.deinit(allocator);
    }

    /// Copy this CA into a compact inline representation. Takes the `limit` most
    /// recent entries by sequence.
    pub fn compact(self: *const ContentAddress, limit: usize) CompactCA {
        var result = CompactCA.init();
        var it = self.map.iterator();
        while (it.next()) |entry| {
            result.advance(entry.key_ptr.*, entry.value_ptr.*, limit);
        }
        return result;
    }

    /// Set this CA's map from a compact representation. Existing entries are
    /// replaced; entries not in the compact CA persist.
    pub fn mergeCompact(self: *ContentAddress, allocator: std.mem.Allocator, ca: *const CompactCA) !void {
        for (ca.entries[0..ca.len]) |entry| {
            try self.advance(allocator, entry.replica, entry.seq);
        }
    }

    /// Set replica_id to exactly seq (e.g. when walking an undo cursor backwards).
    pub fn set(self: *ContentAddress, allocator: std.mem.Allocator, replica_id: u16, seq: u32) !void {
        try self.map.put(allocator, replica_id, seq);
        self.cached_max = null;
    }

    /// Advance replica_id to seq only if seq is greater than the current value.
    /// Use this when updating head as ops are applied.
    pub fn advance(self: *ContentAddress, allocator: std.mem.Allocator, replica_id: u16, seq: u32) !void {
        const existing = self.map.get(replica_id) orelse 0;
        if (seq > existing) try self.set(allocator, replica_id, seq);
    }

    /// Remove a replica entry. Safe to call if replica_id is not present.
    pub fn unset(self: *ContentAddress, replica_id: u16) void {
        _ = self.map.remove(replica_id);
        self.cached_max = null;
    }

    /// Deep copy this content address. The caller owns the returned value.
    pub fn clone(self: *const ContentAddress, allocator: std.mem.Allocator) !ContentAddress {
        var result = ContentAddress.init();
        var it = self.map.iterator();
        while (it.next()) |entry| {
            try result.map.put(allocator, entry.key_ptr.*, entry.value_ptr.*);
        }
        result.cached_max = self.cached_max;
        return result;
    }

    /// True if op `id` is covered by this content address.
    pub fn includes(self: *const ContentAddress, id: NodeId) bool {
        const max_seq = self.map.get(id.replica_id) orelse return false;
        return id.sequence <= max_seq;
    }

    /// The NodeId with the highest value (sequence-first, replica_id tiebreaker)
    /// across all entries. Returns NodeId.NULL if empty. Result is cached until
    /// the next call to `set`.
    pub fn maxNodeId(self: *ContentAddress) NodeId {
        if (self.cached_max) |m| return m;
        var best = NodeId.NULL;
        var it = self.map.iterator();
        while (it.next()) |entry| {
            const id = NodeId{ .replica_id = entry.key_ptr.*, .sequence = entry.value_ptr.* };
            if (best.isNull() or best.lessThan(id)) best = id;
        }
        self.cached_max = best;
        return best;
    }
};

/// Inline compact content address for interval tree storage.
/// Stores up to MAX entries as sorted (replica, seq) pairs.
pub const COMPACT_CA_MAX = 8;

pub const CompactCA = struct {
    entries: [COMPACT_CA_MAX]CcaEntry = [_]CcaEntry{.{ .replica = 0, .seq = 0 }} ** COMPACT_CA_MAX,
    len: u8 = 0,

    pub const CcaEntry = struct { replica: u16, seq: u32 };

    pub fn init() CompactCA {
        return .{ .entries = undefined, .len = 0 };
    }

    pub fn includes(self: *const CompactCA, id: NodeId) bool {
        for (self.entries[0..self.len]) |entry| {
            if (entry.replica == id.replica_id) return id.sequence <= entry.seq;
        }
        return false;
    }

    /// Advance replica_id to seq (only if seq > current), keeping at most `limit` entries.
    pub fn advance(self: *CompactCA, replica_id: u16, seq: u32, limit: usize) void {
        for (self.entries[0..self.len]) |*entry| {
            if (entry.replica == replica_id) {
                if (seq > entry.seq) entry.seq = seq;
                return;
            }
        }
        if (self.len < limit) {
            self.entries[self.len] = .{ .replica = replica_id, .seq = seq };
            self.len += 1;
        }
    }

    pub fn maxNodeId(self: *const CompactCA) NodeId {
        var best = NodeId.NULL;
        for (self.entries[0..self.len]) |entry| {
            const id = NodeId{ .replica_id = entry.replica, .sequence = entry.seq };
            if (best.isNull() or best.lessThan(id)) best = id;
        }
        return best;
    }
};
