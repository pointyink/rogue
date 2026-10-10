const std = @import("std");
pub const NodeId = @import("node_id.zig").NodeId;
pub const NULL: u32 = 0;
pub const Side = @import("op.zig").Side;
const Fugue = @import("fugue.zig");
const Rope = @import("rope.zig");
const History = @import("history.zig");
const Oplog = @import("oplog.zig");
pub const ContentAddress = @import("content_address.zig").ContentAddress;

/// Hard ceiling on the number of nodes a single document may hold. The SoA
/// arrays start small (the `capacity` passed to `init`) and grow toward this
/// bound; a group that would push past it fails atomically with OutOfMemory so
/// the caller can revert the edit cleanly.
const max_nodes: u32 = 2_000_000;

pub fn Rogue(comptime Char: type) type {
    const WireOpT = @import("op.zig").WireOp(Char);
    const MultiOpT = @import("op.zig").MultiOp(Char);

    return struct {
        const Self = @This();

        // --- Rope BST: O(log n) index <-> node ---
        rope: []Rope.Node,

        // --- Fugue tree: CRDT ordering ---
        fugue: []Fugue.Node,

        // --- CRDT identity ---
        node_id: []NodeId,

        // --- Content: one code unit per node ---
        char: []Char,
        deleted: []bool,

        // TODO: replace per-slot history treap with a singly-linked list
        // of {id, visible} pairs. Common case is 1-2 hide/show events per
        // slot; linked list drops 4× capacity overhead while keeping O(K)
        // lookups that walk newest-first.

        // --- Per-slot history treap roots (index = slot_ix) ---
        history_root: []u32,

        // --- History treap node pool ---
        history: []History.Node,
        history_len: u32,

        /// Current root of the rope BST (changes as treap rebalances). NULL = empty.
        rope_root: u32,

        /// NodeId -> SoA slot index (insert nodes only)
        node_index: std.HashMap(NodeId, u32, NodeId.HashContext, 80),

        /// Fugue root slot indices in document order
        roots: std.ArrayListUnmanaged(u32),

        len: u32,
        cap: u32,
        allocator: std.mem.Allocator,

        replica_id: u16,
        sequence: u32,

        /// Op treap pool (one node per op run).
        op_pool: []Oplog.Node,
        op_pool_len: u32,
        op_root: u32,

        /// op_id -> pool_ix (for O(1) idempotency checks).
        /// op_id -> pool_ix (for O(1) idempotency checks).
        op_index: std.HashMap(NodeId, u32, NodeId.HashContext, 80),

        /// Full content address of the document as currently applied.
        head: ContentAddress,

        /// Applied group ids in application order, so `revertTail` can destructively
        /// remove the most-recently-applied groups in place.
        group_order: std.ArrayListUnmanaged(NodeId),

        pub fn init(allocator: std.mem.Allocator, replica_id: u16, cap: u32) !Self {
            var node_index = std.HashMap(NodeId, u32, NodeId.HashContext, 80).init(allocator);
            try node_index.ensureTotalCapacity(cap);
            var op_index = std.HashMap(NodeId, u32, NodeId.HashContext, 80).init(allocator);
            try op_index.ensureTotalCapacity(cap);
            var self = Self{
                .rope = try allocator.alloc(Rope.Node, cap),
                .fugue = try allocator.alloc(Fugue.Node, cap),
                .node_id = try allocator.alloc(NodeId, cap),
                .char = try allocator.alloc(Char, cap),
                .deleted = try allocator.alloc(bool, cap),
                .history_root = try allocator.alloc(u32, cap),
                .history = try allocator.alloc(History.Node, cap * 4),
                .history_len = 1,
                .rope_root = NULL,
                .node_index = node_index,
                .roots = .empty,
                .len = 1,
                .cap = cap,
                .allocator = allocator,
                .replica_id = replica_id,
                .sequence = 1,
                .op_pool = try allocator.alloc(Oplog.Node, cap),
                .op_pool_len = 1, // slot 0 is NULL sentinel
                .op_root = NULL,
                .op_index = op_index,
                .head = ContentAddress.init(),
                .group_order = .empty,
            };
            self.zeroSlot(0);
            return self;
        }

        pub fn deinit(self: *Self) void {
            const a = self.allocator;
            a.free(self.rope);
            a.free(self.fugue);
            a.free(self.node_id);
            a.free(self.char);
            a.free(self.deleted);
            a.free(self.history_root);
            a.free(self.history);
            self.node_index.deinit();
            self.roots.deinit(a);
            a.free(self.op_pool);
            self.op_index.deinit();
            self.head.deinit(a);
            self.group_order.deinit(a);
        }

        // ═══════════════════════════════════════════════════════════
        // Index-based local ops (produce wire ops for sharing)
        // ═══════════════════════════════════════════════════════════

        /// Stamp an insert id and append to out. No document mutation.
        /// chars must remain valid until merge is called.
        pub fn insert(self: *Self, vis_ix: u32, chars: []const Char, out: *std.ArrayListUnmanaged(WireOpT)) !void {
            if (vis_ix > self.visLen()) return error.OutOfBounds;
            const parent, const side = self.parentForInsert(vis_ix);
            const id = self.nextId();
            self.sequence += @as(u32, @intCast(chars.len)) - 1; // reserve slots for multi-char
            try out.append(self.allocator, .{ .insert = .{ .id = id, .parent = parent, .side = side, .chars = chars } });
        }

        /// Stamp hide ops and append to out. Emits one op per consecutive same-replica
        /// run so that non-consecutive or mixed-replica ranges are handled correctly.
        pub fn hide(self: *Self, vis_ix: u32, len: u32, out: *std.ArrayListUnmanaged(WireOpT)) !void {
            var slot_ix = self.visIxToSlot(vis_ix) orelse return error.OutOfBounds;
            var remaining: u32 = len;
            while (remaining > 0) {
                const target = self.node_id[slot_ix];
                var run: u32 = 1;
                var cur = slot_ix;
                while (run < remaining) {
                    const next = self.ropeNextVis(cur);
                    if (next == NULL) break;
                    const next_id = self.node_id[next];
                    if (next_id.replica_id != target.replica_id or
                        next_id.sequence != target.sequence + run) break;
                    cur = next;
                    run += 1;
                }
                try out.append(self.allocator, .{ .hide = .{ .id = self.nextId(), .target = target, .len = run } });
                remaining -= run;
                if (remaining > 0) slot_ix = self.ropeNextVis(cur);
            }
        }

        /// Floor-search the oplog for the group at cursor.maxNodeId(), emit inverse
        /// WireOps with stamped IDs into out, then decrement cursor. No document mutation.
        pub fn undo(self: *Self, cursor: *ContentAddress, out: *std.ArrayListUnmanaged(WireOpT)) !void {
            // Loop until we find a group to invert or exhaust the cursor.
            // A cursor entry can become stale (pointing below the replica's earliest group)
            // when the previous decrement landed in a gap — in that case getOp finds nothing
            // and we unset the entry and try the next highest replica.
            const start = out.items.len;
            while (out.items.len == start) {
                const max_id = cursor.maxNodeId();
                std.log.debug("undo: max_id={d}:{d}", .{ max_id.replica_id, max_id.sequence });
                if (max_id.isNull()) return;
                try self.getOp(max_id, out);
                if (out.items.len == start) cursor.unset(max_id.replica_id);
            }

            // Capture group_id from the first appended op before we overwrite it.
            const group_id = out.items[start].opId();

            // Invert ops in-place.
            for (out.items[start..]) |*wire| {
                wire.* = switch (wire.*) {
                    .insert => |ins| .{ .hide = .{ .id = self.nextId(), .target = ins.id, .len = @intCast(ins.chars.len) } },
                    .hide => |h| .{ .show = .{ .id = self.nextId(), .target = h.target, .len = h.len } },
                    .show => |s| .{ .hide = .{ .id = self.nextId(), .target = s.target, .len = s.len } },
                };
            }

            // Decrement cursor to just before this group.
            if (group_id.sequence <= 1) {
                cursor.unset(group_id.replica_id);
            } else {
                try cursor.set(self.allocator, group_id.replica_id, group_id.sequence - 1);
            }
        }

        /// Ceiling-search the oplog for the smallest (seq-first) group not yet
        /// included in the cursor, emit its re-application, then advance the
        /// cursor. No document mutation. Redo mirrors undo: every group — insert,
        /// hide, or show — is re-applied in order, so deletes (hide groups) are
        /// re-done and the document re-converges exactly.
        pub fn redo(self: *Self, cursor: *ContentAddress, out: *std.ArrayListUnmanaged(WireOpT)) !void {
            // Smallest (seq-first) group id not yet included in the cursor.
            var best: NodeId = NodeId.NULL;
            var it = self.head.map.iterator();
            while (it.next()) |entry| {
                const replica = entry.key_ptr.*;
                const gid = self.nextGroup(replica, cursor.map.get(replica) orelse 0) orelse continue;
                if (best.isNull() or gid.lessThan(best)) best = gid;
            }
            if (best.isNull()) return;

            const start = out.items.len;
            try self.getOp(best, out);
            if (out.items.len == start) return;

            // Re-apply the group's ops: re-SHOW its inserts and re-HIDE its hides
            // (undo inverted both; redo inverts the undo's inversion = re-apply).
            for (out.items[start..]) |*wire| {
                wire.* = switch (wire.*) {
                    .insert => |ins| .{ .show = .{ .id = self.nextId(), .target = ins.id, .len = @intCast(ins.chars.len) } },
                    .hide => |h| .{ .hide = .{ .id = self.nextId(), .target = h.target, .len = h.len } },
                    .show => |s| .{ .show = .{ .id = self.nextId(), .target = s.target, .len = s.len } },
                };
            }

            // Advance the cursor to include this group.
            try cursor.advance(self.allocator, best.replica_id, best.sequence);
        }

        /// Find the smallest group id for `replica` with group_seq > `floor`.
        /// Returns null if none remain.
        fn nextGroup(self: *const Self, replica: u16, floor: u32) ?NodeId {
            const ix = Oplog.ceiling(self.op_pool, self.op_root, .{
                .group_replica = replica,
                .group_seq = floor + 1,
                .op_seq = 0,
            }) catch return null; // no group past the cursor
            const gid = self.op_pool[ix].groupId();
            // The ceiling search spills past `replica` when it has no op ≥ the key
            // (group_replica dominates the CompositeId ordering), so it can return
            // the first group of a *later* replica. That would corrupt redo's `best`
            // selection — it would re-apply an old, already-visible op and leave the
            // genuinely-undone group untouched (redo becomes a no-op).
            if (gid.replica_id != replica) return null;
            return gid;
        }

        /// Sort, compress, and wrap ops into a MultiOp. group_id = min op id.
        /// Sorts and compacts ops in place. No allocation.
        pub fn multiOp(_: *const Self, ops: []WireOpT) MultiOpT {
            std.debug.assert(ops.len > 0);
            if (ops.len == 1) return .{ .group_id = ops[0].opId(), .ops = ops };
            const compressed = @import("op.zig").compress(Char, ops);
            var group_id = compressed[0].opId();
            for (compressed[1..]) |op| if (op.opId().lessThan(group_id)) {
                group_id = op.opId();
            };
            return .{ .group_id = group_id, .ops = compressed };
        }

        // ═══════════════════════════════════════════════════════════
        // Merge (remote ops)
        // ═══════════════════════════════════════════════════════════

        pub fn merge(self: *Self, multi: MultiOpT) !void {
            // Validate the group_id matches its ops: every op shares the group's
            // replica, and group_id is the smallest op id. A mismatched group_id
            // would *apply* but be un-revertable — getOp() floors on
            // group_id.sequence, so revertTail can't find it, silently breaking the
            // structural-op reject and out-of-order replay.
            {
                var min_seq: u32 = std.math.maxInt(u32);
                for (multi.ops) |wire_op| {
                    const id = wire_op.opId();
                    if (id.replica_id != multi.group_id.replica_id) return error.InvalidGroup;
                    if (id.sequence < min_seq) min_seq = id.sequence;
                }
                if (min_seq != multi.group_id.sequence) return error.InvalidGroup;
            }

            // Validate every op's dependencies *before* applying any of them. A
            // multi-op group is the unit of atomicity: if any hide/show target or
            // insert parent is missing, the whole group must park with NO partial
            // state. Without this, a late target (e.g. a hide against a char from a
            // group the receiver hasn't received yet) would apply the earlier ops in
            // the group and then error on the missing one — leaving the doc silently
            // mutated even though the caller treats the group as rejected.
            for (multi.ops) |wire_op| {
                if (self.op_index.contains(wire_op.opId())) continue;
                switch (wire_op) {
                    .insert => |ins| {
                        // Only the first char's parent is external; the rest chain off
                        // their in-group predecessor (see doInsert). Root inserts have
                        // no parent.
                        if (ins.side != .Root) {
                            _ = self.node_index.get(ins.parent) orelse return error.UnknownParent;
                        }
                    },
                    .hide => |h| {
                        for (0..h.len) |i| {
                            const cid = NodeId{ .replica_id = h.target.replica_id, .sequence = h.target.sequence + @as(u32, @intCast(i)) };
                            if (!self.node_index.contains(cid)) return error.UnknownTarget;
                        }
                    },
                    .show => |s| {
                        for (0..s.len) |i| {
                            const cid = NodeId{ .replica_id = s.target.replica_id, .sequence = s.target.sequence + @as(u32, @intCast(i)) };
                            if (!self.node_index.contains(cid)) return error.UnknownTarget;
                        }
                    },
                }
            }

            // Pre-check capacity so a too-large group fails atomically — before any
            // op is applied. Grow the SoA arrays toward max_nodes as needed; a group
            // that would exceed the hard ceiling fails cleanly with OutOfMemory
            // (the caller reverts the edit). Without the pre-check, allocSlot would
            // hit OutOfMemory mid-group and leave the doc partially mutated.
            {
                var needed: u64 = self.len;
                for (multi.ops) |wire_op| {
                    if (self.op_index.contains(wire_op.opId())) continue;
                    switch (wire_op) {
                        .insert => |ins| needed += ins.chars.len,
                        else => {},
                    }
                }
                if (needed > max_nodes) return error.OutOfMemory;
                if (needed > self.cap) {
                    var new_cap: u32 = self.cap;
                    while (new_cap < needed) new_cap *|= 2;
                    try self.grow(new_cap);
                }
            }

            var newly_applied = false;
            for (multi.ops) |wire_op| {
                if (self.op_index.contains(wire_op.opId())) continue;
                newly_applied = true;
                switch (wire_op) {
                    .insert => |ins| try self.doInsert(ins),
                    .hide => |h| try self.doHide(h),
                    .show => |s| try self.doShow(s),
                }
                try self.poolAppendWireOp(wire_op, multi.group_id);
            }
            if (newly_applied) try self.group_order.append(self.allocator, multi.group_id);
        }

        /// Reset the document to empty, preserving cap/allocator/replica_id and the
        /// monotonic Lamport clock (`sequence`). Clears all applied-op bookkeeping so
        /// a caller can replay a fresh group sequence in any order.
        pub fn resetDoc(self: *Self) void {
            self.rope_root = NULL;
            self.len = 1;
            self.roots.clearRetainingCapacity();
            self.node_index.clearRetainingCapacity();
            self.op_root = NULL;
            self.op_pool_len = 1;
            self.op_index.clearRetainingCapacity();
            self.history_len = 1;
            self.head.deinit(self.allocator);
            self.head = ContentAddress.init();
            self.group_order.clearRetainingCapacity();
        }

        /// Destructively un-apply the last `count` applied groups IN PLACE — walk the
        /// tail of `group_order` in reverse, undo each op, and drop the groups + ops
        /// from bookkeeping. No reset, no full-doc rebuild: O(tail). The head content
        /// address and Lamport clock stay monotonic (re-merging the tail re-advances
        /// them to the same values; `advance` is idempotent). Returns groups removed.
        pub fn revertTail(self: *Self, count: u32) u32 {
            const k: u32 = @min(count, @as(u32, @intCast(self.group_order.items.len)));
            var removed: u32 = 0;
            while (removed < k) : (removed += 1) {
                const gid = self.group_order.items[self.group_order.items.len - 1];
                self.group_order.items.len -= 1;

                var ops: std.ArrayListUnmanaged(WireOpT) = .empty;
                defer ops.deinit(self.allocator);
                // getOp is infallible for an applied group; on any failure, restore
                // the popped id and stop rather than corrupt further state.
                self.getOp(gid, &ops) catch {
                    self.group_order.items.len += 1;
                    return removed;
                };

                var i = ops.items.len;
                while (i > 0) {
                    i -= 1;
                    self.revertWireOp(ops.items[i], gid);
                }
            }
            return removed;
        }

        fn revertWireOp(self: *Self, wire: WireOpT, group_id: NodeId) void {
            switch (wire) {
                .insert => |ins| self.revertInsert(ins),
                .hide => |h| self.revertVisibility(h.id, h.target, h.len),
                .show => |s| self.revertVisibility(s.id, s.target, s.len),
            }
            const cid = Oplog.CompositeId{
                .op_seq = wire.opId().sequence,
                .group_seq = group_id.sequence,
                .group_replica = group_id.replica_id,
            };
            Oplog.remove(self.op_pool, &self.op_pool_len, &self.op_root, cid);
            _ = self.op_index.remove(wire.opId());
        }

        fn revertInsert(self: *Self, ins: @FieldType(WireOpT, "insert")) void {
            var i = ins.chars.len;
            while (i > 0) {
                i -= 1;
                const char_id = NodeId{
                    .replica_id = ins.id.replica_id,
                    .sequence = ins.id.sequence + @as(u32, @intCast(i)),
                };
                const slot = self.node_index.get(char_id) orelse continue;
                Rope.remove(self.rope, self.deleted, self.node_id, &self.rope_root, slot);
                if (i == 0) {
                    self.fugueRemove(slot, ins.parent, ins.side);
                } else {
                    const parent_id = NodeId{
                        .replica_id = ins.id.replica_id,
                        .sequence = ins.id.sequence + @as(u32, @intCast(i)) - 1,
                    };
                    self.fugueRemove(slot, parent_id, .Right);
                }
                _ = self.node_index.remove(char_id);
                self.len -= 1;
            }
        }

        fn revertVisibility(self: *Self, id: NodeId, target: NodeId, len: u32) void {
            var i = len;
            while (i > 0) {
                i -= 1;
                const char_id = NodeId{
                    .replica_id = target.replica_id,
                    .sequence = target.sequence + i,
                };
                const slot = self.node_index.get(char_id) orelse continue;
                History.removeById(self.history, &self.history_len, &self.history_root[slot], id);
                self.deleted[slot] = !(History.curVis(self.history, self.history_root[slot]) orelse true);
                Rope.updateSizes(self.rope, self.deleted, slot);
            }
        }

        fn fugueRemove(self: *Self, slot: u32, parent_id: NodeId, side: Side) void {
            if (side == .Root) {
                for (self.roots.items, 0..) |r, idx| {
                    if (r == slot) {
                        _ = self.roots.orderedRemove(idx);
                        return;
                    }
                }
                return;
            }
            const parent_slot = self.node_index.get(parent_id) orelse return;
            const head_ptr = if (side == .Right)
                &self.fugue[parent_slot].right_head
            else
                &self.fugue[parent_slot].left_head;
            Fugue.siblingRemove(self.fugue, head_ptr, slot);
        }

        // ═══════════════════════════════════════════════════════════
        // Op retrieval
        // ═══════════════════════════════════════════════════════════

        /// Retrieve the group of ops that contains id, appending reconstructed
        /// WireOps to out. No-op if id is not found. Chars for insert ops borrow
        /// from self.char and are valid for the lifetime of self.
        pub fn getOp(self: *const Self, id: NodeId, out: *std.ArrayListUnmanaged(WireOpT)) !void {
            const floor_ix = Oplog.find(self.op_pool, self.op_root, .{
                .group_replica = id.replica_id,
                .group_seq = id.sequence,
                .op_seq = id.sequence,
            }) catch {
                std.log.debug("getOp({d}:{d}): floor search: NotFound (no entry ≤ key)", .{ id.replica_id, id.sequence });
                return;
            };
            const group_id = self.op_pool[floor_ix].groupId();
            std.log.debug("getOp({d}:{d}): floor→group {d}:{d}", .{ id.replica_id, id.sequence, group_id.replica_id, group_id.sequence });
            if (group_id.replica_id != id.replica_id) return;

            var cur_ix = try Oplog.ceiling(self.op_pool, self.op_root, .{
                .group_replica = group_id.replica_id,
                .group_seq = group_id.sequence,
                .op_seq = 0,
            });
            while (true) {
                const node = self.op_pool[cur_ix];
                if (!node.groupId().eql(group_id)) break;
                try out.append(self.allocator, switch (node) {
                    .insert => |ins| blk: {
                        const slot = self.node_index.get(ins.id.opId()).?;
                        break :blk WireOpT{ .insert = .{
                            .id = ins.id.opId(),
                            .parent = ins.fugue_parent,
                            .side = ins.side,
                            .chars = self.char[slot .. slot + ins.len],
                        } };
                    },
                    .hide => |h| WireOpT{ .hide = .{ .id = h.id.opId(), .target = h.target, .len = h.len } },
                    .show => |s| WireOpT{ .show = .{ .id = s.id.opId(), .target = s.target, .len = s.len } },
                });
                cur_ix = Oplog.next(self.op_pool, cur_ix) catch break;
            }
        }

        // ═══════════════════════════════════════════════════════════
        // Queries
        // ═══════════════════════════════════════════════════════════

        pub const VisChar = struct { id: NodeId, char: Char };
        pub const TotChar = struct { id: NodeId, char: Char, visible: bool };

        pub fn prevVis(self: *Self, id: NodeId) ?VisChar {
            const slot = self.node_index.get(id) orelse return null;
            const prev = self.ropePrevVis(slot);
            if (prev == NULL) return null;
            return .{ .id = self.node_id[prev], .char = self.char[prev] };
        }

        pub fn nextVis(self: *Self, id: NodeId) ?VisChar {
            const slot = self.node_index.get(id) orelse return null;
            const nxt = self.ropeNextVis(slot);
            if (nxt == NULL) return null;
            return .{ .id = self.node_id[nxt], .char = self.char[nxt] };
        }

        pub fn prevTot(self: *Self, id: NodeId) ?TotChar {
            const slot = self.node_index.get(id) orelse return null;
            const prev = self.ropePrevTot(slot);
            if (prev == NULL) return null;
            return .{ .id = self.node_id[prev], .char = self.char[prev], .visible = !self.deleted[prev] };
        }

        pub fn nextTot(self: *Self, id: NodeId) ?TotChar {
            const slot = self.node_index.get(id) orelse return null;
            const nxt = self.ropeNextTot(slot);
            if (nxt == NULL) return null;
            return .{ .id = self.node_id[nxt], .char = self.char[nxt], .visible = !self.deleted[nxt] };
        }

        pub fn visLen(self: *Self) u32 {
            const root = self.rope_root;
            return if (root == NULL) 0 else self.rope[root].vis_size;
        }

        pub fn totLen(self: *Self) u32 {
            const root = self.rope_root;
            return if (root == NULL) 0 else self.rope[root].tot_size;
        }

        /// Visible index (0-based) of a node. Returns null if deleted or not found.
        pub fn visIx(self: *Self, id: NodeId) ?u32 {
            const slot = self.node_index.get(id) orelse return null;
            if (self.deleted[slot]) return null;
            return self.slotToVisIx(slot);
        }

        /// Total index (0-based, including tombstones) of a node.
        pub fn totIx(self: *Self, id: NodeId) ?u32 {
            const slot = self.node_index.get(id) orelse return null;
            return self.slotToTotIx(slot);
        }

        /// NodeId at visible index ix. Returns null if out of bounds.
        pub fn visId(self: *Self, ix: u32) ?NodeId {
            const slot = self.visIxToSlot(ix) orelse return null;
            return self.node_id[slot];
        }

        /// NodeId at total index ix (including tombstones). Returns null if out of bounds.
        pub fn totId(self: *Self, ix: u32) ?NodeId {
            const slot = self.totIxToSlot(ix) orelse return null;
            return self.node_id[slot];
        }

        /// Whether any char in [target, target+len) is a tag char (`<` / `>`).
        /// Used to decide whether a hide/show op could reveal/hide HTML structure
        /// and therefore needs the DOM round-trip check. Skips chars that aren't
        /// present yet (the target may arrive after the op and park).
        pub fn rangeHasTag(self: *const Self, target: NodeId, len: u32) bool {
            var i: u32 = 0;
            while (i < len) : (i += 1) {
                const cid = NodeId{ .replica_id = target.replica_id, .sequence = target.sequence + i };
                const slot = self.node_index.get(cid) orelse continue;
                if (self.char[slot] == '<' or self.char[slot] == '>') return true;
            }
            return false;
        }

        /// Render visible chars. start_id and end_id are inclusive; pass null for document bounds.
        pub fn render(self: *Self, start_id: ?NodeId, end_id: ?NodeId, out: *std.ArrayListUnmanaged(Char)) !void {
            if (self.rope_root == NULL) return;
            const start_slot = if (start_id) |sid|
                self.node_index.get(sid) orelse return error.UnknownId
            else
                self.totIxToSlot(0).?;
            const end_slot: ?u32 = if (end_id) |eid|
                self.node_index.get(eid) orelse return error.UnknownId
            else
                null;
            var slot = start_slot;
            while (true) {
                if (!self.deleted[slot]) try out.append(self.allocator, self.char[slot]);
                if (end_slot) |es| if (slot == es) break;
                slot = Rope.nextTot(self.rope, slot);
                if (slot == NULL) break;
            }
        }

        /// Render all chars including tombstones. start_id and end_id are inclusive; pass null for document bounds.
        pub fn renderTot(self: *Self, start_id: ?NodeId, end_id: ?NodeId, out: *std.ArrayListUnmanaged(Char)) !void {
            if (self.rope_root == NULL) return;
            const start_slot = if (start_id) |sid|
                self.node_index.get(sid) orelse return error.UnknownId
            else
                self.totIxToSlot(0).?;
            const end_slot: ?u32 = if (end_id) |eid|
                self.node_index.get(eid) orelse return error.UnknownId
            else
                null;
            var slot = start_slot;
            while (true) {
                try out.append(self.allocator, self.char[slot]);
                if (end_slot) |es| if (slot == es) break;
                slot = Rope.nextTot(self.rope, slot);
                if (slot == NULL) break;
            }
        }

        fn visIxToSlot(self: *Self, vis_ix: u32) ?u32 {
            return Rope.visIxToSlot(self.rope, self.deleted, self.rope_root, vis_ix);
        }

        fn totIxToSlot(self: *Self, tot_ix: u32) ?u32 {
            return Rope.totIxToSlot(self.rope, self.rope_root, tot_ix);
        }

        fn slotToVisIx(self: *Self, slot_ix: u32) u32 {
            return Rope.slotToVisIx(self.rope, self.deleted, slot_ix);
        }

        fn slotToTotIx(self: *Self, slot_ix: u32) u32 {
            return Rope.slotToTotIx(self.rope, slot_ix);
        }

        // ═══════════════════════════════════════════════════════════
        // Op bounds — predict the vis-index range an op will affect
        // before applying it, for the partial-rerender path.
        // ═══════════════════════════════════════════════════════════

        /// The tot-order slot of the char just to the LEFT of where a new insert
        /// with `new_id` lands — the rope predecessor, mirroring doInsertOne's
        /// pred_ix. NULL at doc start. Shared by insertIndex and visIxBounds.
        fn insertPredSlot(self: *Self, parent_id: NodeId, side: Side, new_id: NodeId) !u32 {
            var predicted: u32 = NULL;
            if (side == .Root) {
                for (self.roots.items) |r| {
                    if (new_id.lessThan(self.node_id[r])) break;
                    predicted = Fugue.rightmostDescendant(self.fugue, r);
                }
            } else {
                const parent_slot = self.node_index.get(parent_id) orelse return error.UnknownId;
                const head = if (side == .Right) self.fugue[parent_slot].right_head else self.fugue[parent_slot].left_head;
                var prev_sib: u32 = NULL;
                var cur = head;
                while (cur != NULL and self.node_id[cur].lessThan(new_id)) {
                    prev_sib = cur;
                    cur = self.fugue[cur].next_sibling;
                }
                predicted = switch (side) {
                    .Right => if (prev_sib == NULL) parent_slot else Fugue.rightmostDescendant(self.fugue, prev_sib),
                    .Left => if (prev_sib == NULL) Rope.prevTot(self.rope, parent_slot) else Fugue.rightmostDescendant(self.fugue, prev_sib),
                    .Root => unreachable,
                };
            }
            return predicted;
        }

        /// Vis-index just to the LEFT of where this insert will land. Mirrors
        /// the pred_ix computation in doInsertOne. Falls back to 0 at doc start.
        pub fn insertIndex(self: *Self, parent_id: NodeId, side: Side, new_id: NodeId) !u32 {
            const slot = self.ropeFloorVis(try self.insertPredSlot(parent_id, side, new_id));
            if (slot == NULL) return 0;
            return self.slotToVisIx(slot);
        }

        /// (lo, hi) visible neighbors bracketing the id-range [target, target+len-1].
        /// Used by both hide and show: prevVis/nextVis walk to the nearest visible
        /// char regardless of whether the start slot is itself visible. Falls back
        /// to 0 / visLen-1 at doc edges.
        fn bracketIndex(self: *Self, target: NodeId, len: u32) !struct { u32, u32 } {
            _ = self.node_index.get(target) orelse return error.UnknownId;
            const last = NodeId{ .replica_id = target.replica_id, .sequence = target.sequence + len - 1 };
            _ = self.node_index.get(last) orelse return error.UnknownId;
            const prev = self.prevVis(target);
            const next = self.nextVis(last);
            const lo: u32 = if (prev) |p| (self.visIx(p.id) orelse 0) else 0;
            const hi: u32 = if (next) |n| (self.visIx(n.id) orelse 0) else (self.visLen() -| 1);
            return .{ lo, hi };
        }

        pub fn hideIndex(self: *Self, target: NodeId, len: u32) !struct { u32, u32 } {
            return self.bracketIndex(target, len);
        }

        pub fn showIndex(self: *Self, target: NodeId, len: u32) !struct { u32, u32 } {
            return self.bracketIndex(target, len);
        }

        /// Aggregate (min, max) vis-index bounds for a payload — the two *visible
        /// neighbors* bracketing each op's content, whether the op is about to be
        /// applied (pre) or already sits in the doc (post, e.g. a re-fold tail).
        ///
        /// For an insert whose first char is already present (post-apply), we bracket
        /// the op's own char range via prev_vis/next_vis — which skips the op's own
        /// chars by construction. For a not-yet-applied insert the chars don't exist,
        /// so we resolve the landing spot's neighbors instead. hide/show always target
        /// existing chars, so they bracket directly.
        ///
        /// Errors (e.g. unknown id) propagate; the caller falls back to full rerender.
        pub fn visIxBounds(self: *Self, ops: []const WireOpT) !struct { u32, u32 } {
            var min: u32 = std.math.maxInt(u32);
            var max: u32 = 0;
            for (ops) |op| {
                const r: struct { u32, u32 } = switch (op) {
                    .insert => |ins| blk: {
                        if (self.node_index.contains(ins.id)) {
                            break :blk try self.bracketIndex(ins.id, @intCast(ins.chars.len));
                        }
                        const left_slot = self.ropeFloorVis(try self.insertPredSlot(ins.parent, ins.side, ins.id));
                        const left_ix: u32 = if (left_slot == NULL) 0 else self.slotToVisIx(left_slot);
                        const right_slot = if (left_slot == NULL)
                            (self.visIxToSlot(0) orelse NULL)
                        else
                            self.ropeNextVis(left_slot);
                        const right_ix: u32 = if (right_slot == NULL) (self.visLen() -| 1) else self.slotToVisIx(right_slot);
                        break :blk .{ left_ix, right_ix };
                    },
                    .hide => |h| try self.hideIndex(h.target, h.len),
                    .show => |s| try self.showIndex(s.target, s.len),
                };
                if (r[0] < min) min = r[0];
                if (r[1] > max) max = r[1];
            }
            return .{ min, max };
        }

        /// Render the document (or a subsection) at a content address.
        /// start_id and end_id are inclusive; pass null for start/end of document.
        pub fn renderAt(
            self: *Self,
            addr: *ContentAddress,
            start_id: ?NodeId,
            end_id: ?NodeId,
            out: *std.ArrayListUnmanaged(Char),
        ) !void {
            if (self.rope_root == NULL) return;

            const start_slot = if (start_id) |sid|
                self.node_index.get(sid) orelse return error.UnknownId
            else
                self.totIxToSlot(0).?;

            const end_slot: ?u32 = if (end_id) |eid|
                self.node_index.get(eid) orelse return error.UnknownId
            else
                null;

            if (start_id != null and end_id != null) {
                if (self.slotToTotIx(start_slot) >= self.slotToTotIx(end_slot.?))
                    return error.InvalidRange;
            }

            var slot = start_slot;
            while (true) {
                if (addr.includes(self.node_id[slot]) and
                    History.visibleAt(self.history, self.history_root[slot], addr))
                {
                    try out.append(self.allocator, self.char[slot]);
                }
                if (end_slot) |es| if (slot == es) break;
                slot = Rope.nextTot(self.rope, slot);
                if (slot == NULL) break;
            }
        }

        /// Compute the content address (version vector) of the span [start_id,
        /// end_id]. Aggregates the max sequence per replica over every op id that
        /// touched a char in the span — each char's own (insert) id plus its
        /// hide/show history. With no args, covers the whole document. Property:
        /// `renderAt(addrOf(s, e), s, e)` reproduces the span's current text.
        pub fn addrOf(self: *Self, start_id: ?NodeId, end_id: ?NodeId) !ContentAddress {
            var result = ContentAddress.init();
            errdefer result.deinit(self.allocator);
            if (self.rope_root == NULL) return result;

            const start_slot = if (start_id) |sid|
                self.node_index.get(sid) orelse return error.UnknownId
            else
                self.totIxToSlot(0).?;
            const end_slot: ?u32 = if (end_id) |eid|
                self.node_index.get(eid) orelse return error.UnknownId
            else
                null;

            if (start_id != null and end_id != null) {
                if (self.slotToTotIx(start_slot) >= self.slotToTotIx(end_slot.?))
                    return error.InvalidRange;
            }

            var slot = start_slot;
            while (true) {
                const id = self.node_id[slot];
                try result.advance(self.allocator, id.replica_id, id.sequence);
                try History.advanceAddr(self.history, self.history_root[slot], &result, self.allocator);
                if (end_slot) |es| if (slot == es) break;
                slot = Rope.nextTot(self.rope, slot);
                if (slot == NULL) break;
            }
            return result;
        }

        /// Compute the ops needed to restore the document (or a subsection) to the
        /// state described by addr. Appends hide/show WireOps to out with id=NodeId.NULL
        /// as placeholders — the caller assigns real ids when applying.
        pub fn restore(
            self: *Self,
            addr: *ContentAddress,
            start_id: ?NodeId,
            end_id: ?NodeId,
            out: *std.ArrayListUnmanaged(WireOpT),
        ) !void {
            if (self.rope_root == NULL) return;

            const start_slot = if (start_id) |sid|
                self.node_index.get(sid) orelse return error.UnknownId
            else
                self.totIxToSlot(0).?;

            const end_slot: ?u32 = if (end_id) |eid|
                self.node_index.get(eid) orelse return error.UnknownId
            else
                null;

            if (start_id != null and end_id != null) {
                if (self.slotToTotIx(start_slot) >= self.slotToTotIx(end_slot.?))
                    return error.InvalidRange;
            }

            var slot = start_slot;
            while (true) {
                const id = self.node_id[slot];
                const current_visible = !self.deleted[slot];
                const target_visible = addr.includes(id) and
                    History.visibleAt(self.history, self.history_root[slot], addr);

                if (target_visible != current_visible) {
                    if (target_visible) {
                        try out.append(self.allocator, .{ .show = .{
                            .id = self.nextId(),
                            .target = id,
                            .len = 1,
                        } });
                    } else {
                        try out.append(self.allocator, .{ .hide = .{
                            .id = self.nextId(),
                            .target = id,
                            .len = 1,
                        } });
                    }
                }

                if (end_slot) |es| if (slot == es) break;
                slot = Rope.nextTot(self.rope, slot);
                if (slot == NULL) break;
            }
        }

        // ═══════════════════════════════════════════════════════════
        // Fugue + Rope insert
        // ═══════════════════════════════════════════════════════════

        fn parentForInsert(self: *Self, vis_ix: u32) struct { NodeId, Side } {
            if (self.rope_root == NULL) return .{ NodeId.NULL, .Root };
            if (vis_ix == 0) {
                const first_ix = self.totIxToSlot(0).?;
                return .{ self.node_id[first_ix], .Left };
            }
            const slot_ix = self.visIxToSlot(vis_ix - 1).?;
            if (self.fugue[slot_ix].right_head != NULL) {
                const target_slot_ix = Fugue.leftmostDescendant(self.fugue, self.fugue[slot_ix].right_head);
                return .{ self.node_id[target_slot_ix], .Left };
            }
            return .{ self.node_id[slot_ix], .Right };
        }

        fn doInsert(self: *Self, ins: @FieldType(WireOpT, "insert")) !void {
            self.tickClock(ins.id.sequence + @as(u32, @intCast(ins.chars.len)) - 1);
            for (ins.chars, 0..) |char, i| {
                const char_id = NodeId{
                    .replica_id = ins.id.replica_id,
                    .sequence = ins.id.sequence + @as(u32, @intCast(i)),
                };
                const parent_id = if (i == 0)
                    ins.parent
                else
                    NodeId{ .replica_id = ins.id.replica_id, .sequence = ins.id.sequence + @as(u32, @intCast(i)) - 1 };
                const side: Side = if (i == 0) ins.side else .Right;
                try self.doInsertOne(char_id, char, parent_id, side);
            }
        }

        fn doInsertOne(self: *Self, id: NodeId, char: Char, parent_id: NodeId, side: Side) !void {
            if (side == .Root) {
                const slot_ix = try self.allocSlot(id, char, false);
                var pred_ix: u32 = NULL;
                var insert_pos: usize = self.roots.items.len;
                for (self.roots.items, 0..) |r, i| {
                    if (id.lessThan(self.node_id[r])) {
                        insert_pos = i;
                        break;
                    }
                    pred_ix = Fugue.rightmostDescendant(self.fugue, r);
                }
                try self.roots.insert(self.allocator, insert_pos, slot_ix);
                Rope.insertAfter(self.rope, self.deleted, self.node_id, &self.rope_root, pred_ix, slot_ix);
                return;
            }

            // Resolve the parent BEFORE allocating the slot. An out-of-order insert
            // whose parent hasn't arrived must park with NO partial state: allocSlot
            // registers the id in node_index, so allocating first leaves a phantom
            // entry pointing at an unlinked slot. A later child (or a hide) that
            // resolves through that phantom gets placed relative to a node that isn't
            // in the rope, and is lost when the real parent finally lands.
            const parent_ix = self.node_index.get(parent_id) orelse return error.UnknownParent;
            const slot_ix = try self.allocSlot(id, char, false);

            const head_ptr = if (side == .Right)
                &self.fugue[parent_ix].right_head
            else
                &self.fugue[parent_ix].left_head;

            const prev_sib_ix = Fugue.siblingInsert(self.fugue, self.node_id, head_ptr, id, slot_ix);

            const pred_ix: u32 = switch (side) {
                .Right => if (prev_sib_ix == NULL) parent_ix else Fugue.rightmostDescendant(self.fugue, prev_sib_ix),
                .Left => if (prev_sib_ix == NULL) self.ropePrevTot(parent_ix) else self.ropePrevTot(Fugue.leftmostDescendant(self.fugue, prev_sib_ix)),
                .Root => unreachable,
            };

            Rope.insertAfter(self.rope, self.deleted, self.node_id, &self.rope_root, pred_ix, slot_ix);
        }

        fn ropePrevTot(self: *Self, slot_ix: u32) u32 {
            return Rope.prevTot(self.rope, slot_ix);
        }

        fn ropePrevVis(self: *Self, slot_ix: u32) u32 {
            return Rope.prevVis(self.rope, self.deleted, slot_ix);
        }

        fn ropeNextTot(self: *Self, slot_ix: u32) u32 {
            return Rope.nextTot(self.rope, slot_ix);
        }

        fn ropeNextVis(self: *Self, slot_ix: u32) u32 {
            return Rope.nextVis(self.rope, self.deleted, slot_ix);
        }

        /// Round down to nearest visible slot: returns slot_ix itself if visible,
        /// otherwise walks left to the nearest visible slot. NULL at doc start.
        fn ropeFloorVis(self: *Self, slot_ix: u32) u32 {
            if (slot_ix == NULL) return NULL;
            if (!self.deleted[slot_ix]) return slot_ix;
            return Rope.prevVis(self.rope, self.deleted, slot_ix);
        }

        /// Round up to nearest visible slot: returns slot_ix itself if visible,
        /// otherwise walks right to the nearest visible slot. NULL at doc end.
        fn ropeCeilVis(self: *Self, slot_ix: u32) u32 {
            if (slot_ix == NULL) return NULL;
            if (!self.deleted[slot_ix]) return slot_ix;
            return Rope.nextVis(self.rope, self.deleted, slot_ix);
        }

        fn doHide(self: *Self, h: @FieldType(WireOpT, "hide")) !void {
            // Park until every target char is present. An out-of-order hide (a
            // delete arriving before the insert of the char it targets) must NOT be
            // silently dropped — the insert would later create the char visible and
            // nothing would re-hide it, diverging replicas. Symmetric with an
            // insert's UnknownParent; a merge error makes the JS park and retry via
            // drainParked. Check all targets up front so a retry can't double-write
            // history for the chars that were already present.
            for (0..h.len) |i| {
                const char_id = NodeId{
                    .replica_id = h.target.replica_id,
                    .sequence = h.target.sequence + @as(u32, @intCast(i)),
                };
                if (!self.node_index.contains(char_id)) return error.UnknownTarget;
            }
            self.tickClock(h.id.sequence);
            for (0..h.len) |i| {
                const char_id = NodeId{
                    .replica_id = h.target.replica_id,
                    .sequence = h.target.sequence + @as(u32, @intCast(i)),
                };
                const slot_ix = self.node_index.get(char_id).?;
                try self.historyInsert(slot_ix, h.id, false);
                self.deleted[slot_ix] = !History.curVis(self.history, self.history_root[slot_ix]).?;
                Rope.updateSizes(self.rope, self.deleted, slot_ix);
            }
        }

        fn doShow(self: *Self, s: @FieldType(WireOpT, "show")) !void {
            for (0..s.len) |i| {
                const char_id = NodeId{
                    .replica_id = s.target.replica_id,
                    .sequence = s.target.sequence + @as(u32, @intCast(i)),
                };
                if (!self.node_index.contains(char_id)) return error.UnknownTarget;
            }
            self.tickClock(s.id.sequence);
            for (0..s.len) |i| {
                const char_id = NodeId{
                    .replica_id = s.target.replica_id,
                    .sequence = s.target.sequence + @as(u32, @intCast(i)),
                };
                const slot_ix = self.node_index.get(char_id).?;
                try self.historyInsert(slot_ix, s.id, true);
                self.deleted[slot_ix] = !History.curVis(self.history, self.history_root[slot_ix]).?;
                Rope.updateSizes(self.rope, self.deleted, slot_ix);
            }
        }

        // ═══════════════════════════════════════════════════════════
        // History treap (per-slot visibility log)
        // ═══════════════════════════════════════════════════════════

        fn historyInsert(self: *Self, char_slot_ix: u32, id: NodeId, visible: bool) !void {
            try History.insert(
                self.history,
                &self.history_len,
                &self.history_root[char_slot_ix],
                id,
                visible,
            );
        }

        /// Was char_id visible at the given content address?
        /// Returns null if char_id is not found.
        pub fn visibleAt(self: *Self, id: NodeId, addr: *ContentAddress) ?bool {
            const slot = self.node_index.get(id) orelse return null;
            return History.visibleAt(self.history, self.history_root[slot], addr);
        }

        // ═══════════════════════════════════════════════════════════
        // Op treap
        // ═══════════════════════════════════════════════════════════

        fn poolAppendWireOp(self: *Self, wire: WireOpT, group_id: NodeId) !void {
            // Advance head to cover all sequences introduced by this op.
            const op_id = wire.opId();
            const last_seq: u32 = switch (wire) {
                .insert => |ins| ins.id.sequence + @as(u32, @intCast(ins.chars.len)) - 1,
                inline else => op_id.sequence,
            };
            try self.head.advance(self.allocator, op_id.replica_id, last_seq);

            const cid = Oplog.CompositeId{
                .group_replica = group_id.replica_id,
                .group_seq = group_id.sequence,
                .op_seq = op_id.sequence,
            };
            const node: Oplog.Node = switch (wire) {
                .insert => |ins| .{ .insert = .{
                    .id = cid,
                    .len = @intCast(ins.chars.len),
                    .fugue_parent = ins.parent,
                    .side = ins.side,
                    .left = NULL,
                    .right = NULL,
                    .parent = NULL,
                } },
                .hide => |h| .{ .hide = .{
                    .id = cid,
                    .target = h.target,
                    .len = h.len,
                    .left = NULL,
                    .right = NULL,
                    .parent = NULL,
                } },
                .show => |s| .{ .show = .{
                    .id = cid,
                    .target = s.target,
                    .len = s.len,
                    .left = NULL,
                    .right = NULL,
                    .parent = NULL,
                } },
            };
            const ix = try Oplog.insert(self.op_pool, &self.op_pool_len, &self.op_root, node);
            try self.op_index.put(op_id, ix);
        }

        // ═══════════════════════════════════════════════════════════
        // Slot allocation
        // ═══════════════════════════════════════════════════════════

        /// Grow the SoA arrays to `new_cap` nodes. `realloc` copies the used
        /// prefix and frees the old buffer (the arena reclaims it wholesale at
        /// deinit; the testing GPA sees a clean realloc). References are slot
        /// indices, never raw pointers, so moving the arrays invalidates nothing.
        /// A failed realloc partway through leaves the doc intact — `cap` isn't
        /// bumped, so a later grow simply retries.
        fn grow(self: *Self, new_cap: u32) !void {
            const a = self.allocator;
            self.rope = try a.realloc(self.rope, new_cap);
            self.fugue = try a.realloc(self.fugue, new_cap);
            self.node_id = try a.realloc(self.node_id, new_cap);
            self.char = try a.realloc(self.char, new_cap);
            self.deleted = try a.realloc(self.deleted, new_cap);
            self.history_root = try a.realloc(self.history_root, new_cap);
            self.history = try a.realloc(self.history, new_cap * 4);
            self.op_pool = try a.realloc(self.op_pool, new_cap);
            self.cap = new_cap;
        }

        /// Pre-grow the SoA arrays so a doc can be loaded at its target size in
        /// one shot instead of realloc'ing as ops stream in. No-op if already
        /// big enough; fails past the hard ceiling. `nodes` is an estimate (the
        /// caller over/under-shoots by op-granularity), so `grow` stays the
        /// backstop for any under-estimate.
        pub fn reserve(self: *Self, nodes: u32) !void {
            if (nodes <= self.cap) return;
            if (nodes > max_nodes) return error.OutOfMemory;
            var new_cap: u32 = self.cap;
            while (new_cap < nodes) new_cap *|= 2;
            try self.grow(new_cap);
        }

        fn allocSlot(self: *Self, id: NodeId, ch: Char, is_deleted: bool) !u32 {
            if (self.len >= self.cap) return error.OutOfMemory;
            const slot = self.len;
            self.len += 1;
            self.rope[slot] = .{ .parent = NULL, .left = NULL, .right = NULL, .tot_size = 0, .vis_size = 0 };
            self.fugue[slot] = .{ .left_head = NULL, .right_head = NULL, .next_sibling = NULL };
            self.history_root[slot] = NULL;
            self.node_id[slot] = id;
            self.char[slot] = ch;
            self.deleted[slot] = is_deleted;
            try self.node_index.put(id, slot);
            return slot;
        }

        fn zeroSlot(self: *Self, i: u32) void {
            self.rope[i] = .{ .parent = NULL, .left = NULL, .right = NULL, .tot_size = 0, .vis_size = 0 };
            self.fugue[i] = .{ .left_head = NULL, .right_head = NULL, .next_sibling = NULL };
            self.history_root[i] = NULL;
            self.node_id[i] = NodeId.NULL;
            self.char[i] = std.mem.zeroes(Char);
            self.deleted[i] = false;
        }

        // ═══════════════════════════════════════════════════════════
        // Internal helpers
        // ═══════════════════════════════════════════════════════════

        fn tickClock(self: *Self, incoming: u32) void {
            if (incoming >= self.sequence) self.sequence = incoming + 1;
        }

        fn nextId(self: *Self) NodeId {
            defer self.sequence += 1;
            return .{ .replica_id = self.replica_id, .sequence = self.sequence };
        }
    };
}

/// Convert a comptime ASCII string literal to a u16 array (test helper).
fn w(comptime str: []const u8) [str.len]u16 {
    comptime var result: [str.len]u16 = undefined;
    inline for (str, 0..) |c, i| result[i] = c;
    return result;
}

test "error kinds match the shared fixture" {
    const ErrorKind = @import("error_kind.zig").ErrorKind;

    // Read the single source of truth (error_kinds.json) — the JS side asserts
    // against the same file in rogue/src/crdt_error.test.js.
    const file = std.fs.cwd().openFile("crdt/error_kinds.json", .{}) catch
        std.fs.cwd().openFile("rogue/crdt/error_kinds.json", .{}) catch
        @panic("error_kinds.json not found (expected at crdt/error_kinds.json)");
    defer file.close();
    const raw = try file.readToEndAlloc(std.testing.allocator, 4096);
    defer std.testing.allocator.free(raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, raw, .{});
    defer parsed.deinit();
    const entries = parsed.value.array.items;

    // Every enum member must appear in the fixture with the right code…
    const tags = std.meta.tags(ErrorKind);
    try std.testing.expectEqual(entries.len, tags.len);
    for (tags) |tag| {
        const want_name = @tagName(tag);
        const want_code = @intFromEnum(tag);
        var found = false;
        for (entries) |entry| {
            const obj = entry.object;
            const name = obj.get("name").?.string;
            const code: u8 = @intCast(obj.get("code").?.integer);
            if (std.mem.eql(u8, name, want_name)) {
                try std.testing.expectEqual(want_code, code);
                found = true;
                break;
            }
        }
        try std.testing.expect(found);
    }
    // …and the fixture must name exactly the enum's members (no orphan codes).
    for (entries) |entry| {
        const name = entry.object.get("name").?.string;
        const code: u8 = @intCast(entry.object.get("code").?.integer);
        var found = false;
        for (tags) |tag| {
            if (std.mem.eql(u8, @tagName(tag), name)) {
                try std.testing.expectEqual(@intFromEnum(tag), code);
                found = true;
                break;
            }
        }
        try std.testing.expect(found);
    }
}

test "revertTail clamps to the available group count" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    try r.insert(0, &w("hello"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(5, &w(" world"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Request more groups than exist — clamps to the available 2.
    try std.testing.expectEqual(@as(u32, 2), r.revertTail(10));
    try std.testing.expectEqual(@as(u32, 0), r.visLen());
}

/// Build a 3-group scenario on `r`: insert "hello", hide 'e', show 'e'.
/// Final render is "hello". Exercises insert + hide + show ops.
fn buildScenario(r: *Rogue(u16)) !void {
    const alloc = std.testing.allocator;
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    try r.insert(0, &w("hello"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var cursor = try r.head.clone(alloc);
    defer cursor.deinit(alloc);
    try r.undo(&cursor, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
}

/// Reconstruct group `gid`'s ops into `ops` with insert chars COPIED into `chars`
/// (owned storage), so they survive a subsequent revert/re-merge. `chars` must not
/// reallocate while earlier captured slices are still referenced.
fn captureOwned(
    r: *Rogue(u16),
    gid: NodeId,
    chars: *std.ArrayListUnmanaged(u16),
    ops: *std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)),
) !void {
    const alloc = std.testing.allocator;
    var tmp: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer tmp.deinit(alloc);
    try r.getOp(gid, &tmp);
    for (tmp.items) |op| {
        switch (op) {
            .insert => |ins| {
                const start = chars.items.len;
                try chars.appendSlice(alloc, ins.chars);
                try ops.append(alloc, .{ .insert = .{
                    .id = ins.id,
                    .parent = ins.parent,
                    .side = ins.side,
                    .chars = chars.items[start..],
                } });
            },
            .hide => |h| try ops.append(alloc, .{ .hide = .{ .id = h.id, .target = h.target, .len = h.len } }),
            .show => |s| try ops.append(alloc, .{ .show = .{ .id = s.id, .target = s.target, .len = s.len } }),
        }
    }
}

test "merge rejects a group whose group_id doesn't match its ops" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 128);
    defer r.deinit();

    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);
    try r.insert(0, &w("hello"), &buf);
    var multi = r.multiOp(buf.items);

    // Corrupt the group_id so it no longer equals the (single) op id — such a
    // payload would apply but be un-revertable (getOp floors on group_id.seq).
    multi.group_id.sequence += 1;

    try std.testing.expectError(error.InvalidGroup, r.merge(multi));
}

test "revertTail leaves only the head" {
    const alloc = std.testing.allocator;
    // buildScenario: insert "hello" → hide 'e' → show 'e'. Final "hello", 3 groups.
    const cases = [4][]const u16{ &w("hello"), &w("hllo"), &w("hello"), &w("") };
    var k: usize = 0;
    while (k < 4) : (k += 1) {
        var r = try Rogue(u16).init(alloc, 1, 128);
        defer r.deinit();
        try buildScenario(&r);

        try std.testing.expectEqual(@as(u32, @intCast(k)), r.revertTail(@intCast(k)));

        var out: std.ArrayListUnmanaged(u16) = .empty;
        defer out.deinit(alloc);
        try r.render(null, null, &out);
        try std.testing.expectEqualSlices(u16, cases[k], out.items);
    }
}

test "revertTail then re-merge the tail restores the document" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 128);
    defer r.deinit();
    try buildScenario(&r);

    var full: std.ArrayListUnmanaged(u16) = .empty;
    defer full.deinit(alloc);
    try r.render(null, null, &full);

    const n = r.group_order.items.len;
    const k: usize = n; // revert everything, then replay in order

    var chars: std.ArrayListUnmanaged(u16) = .empty;
    defer chars.deinit(alloc);
    var groups: std.ArrayListUnmanaged(std.ArrayListUnmanaged(@import("op.zig").WireOp(u16))) = .empty;
    defer {
        for (groups.items) |*g| g.deinit(alloc);
        groups.deinit(alloc);
    }
    for (n - k..n) |idx| {
        var g: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
        try captureOwned(&r, r.group_order.items[idx], &chars, &g);
        try groups.append(alloc, g);
    }

    try std.testing.expectEqual(@as(u32, @intCast(k)), r.revertTail(@intCast(k)));

    for (groups.items) |g| {
        try r.merge(r.multiOp(g.items));
    }

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(alloc);
    try r.render(null, null, &out);
    try std.testing.expectEqualSlices(u16, full.items, out.items);
}

/// Print a UTF-16 slice as UTF-8, handling surrogate pairs.
fn printDoc(label: []const u8, chars: []const u16) void {
    std.debug.print("{s}: \"", .{label});
    var i: usize = 0;
    while (i < chars.len) {
        const cu = chars[i];
        const cp: u21 = blk: {
            if (cu >= 0xD800 and cu <= 0xDBFF and i + 1 < chars.len) {
                const lo = chars[i + 1];
                if (lo >= 0xDC00 and lo <= 0xDFFF) {
                    i += 1;
                    break :blk 0x10000 + (@as(u21, cu - 0xD800) << 10) + (lo - 0xDC00);
                }
            }
            break :blk cu;
        };
        i += 1;
        var buf: [4]u8 = undefined;
        const len = std.unicode.utf8Encode(cp, &buf) catch {
            std.debug.print("\u{FFFD}", .{});
            continue;
        };
        std.debug.print("{s}", .{buf[0..len]});
    }
    std.debug.print("\"\n", .{});
}

test "insert and render" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &.{@as(u16, 'h')}, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &.{@as(u16, 'e')}, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &.{@as(u16, 'l')}, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(3, &.{@as(u16, 'l')}, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(4, &.{@as(u16, 'o')}, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    try std.testing.expectEqualSlices(u16, &[_]u16{ 'h', 'e', 'l', 'l', 'o' }, out.items);
}

test "grows past initial capacity" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    const chars = [_]u16{'x'} ** 256; // > the 64-node initial capacity
    try r.insert(0, &chars, &buf);
    try r.merge(r.multiOp(buf.items));

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    try std.testing.expectEqualSlices(u16, &chars, out.items);
}

test "hide and show" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &.{@as(u16, 'h')}, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &.{@as(u16, 'i')}, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 1), r.visLen());
}

test "visibleAt" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &.{@as(u16, 'x')}, &buf);
    const x_id = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var addr_inserted = try r.head.clone(std.testing.allocator);
    defer addr_inserted.deinit(std.testing.allocator);

    try r.hide(0, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var addr_hidden = try r.head.clone(std.testing.allocator);
    defer addr_hidden.deinit(std.testing.allocator);

    var cursor = try r.head.clone(std.testing.allocator);
    defer cursor.deinit(std.testing.allocator);
    try r.undo(&cursor, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    try std.testing.expect(r.visibleAt(x_id, &addr_inserted).?);
    try std.testing.expect(!r.visibleAt(x_id, &addr_hidden).?);
    try std.testing.expect(r.visibleAt(x_id, &r.head).?);
}

test "visIx and totIx" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &.{@as(u16, 'A')}, &buf);
    const id1 = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &.{@as(u16, 'B')}, &buf);
    const id2 = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &.{@as(u16, 'C')}, &buf);
    const id3 = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 0), r.visIx(id1).?);
    try std.testing.expectEqual(@as(u32, 1), r.visIx(id2).?);
    try std.testing.expectEqual(@as(u32, 2), r.visIx(id3).?);
    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 1), r.visIx(id3).?); // C shifts to 1
    try std.testing.expectEqual(@as(u32, 1), r.totIx(id2).?); // B still at tot 1
}

test "merge idempotent" {
    var alice = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer alice.deinit();
    var bob = try Rogue(u16).init(std.testing.allocator, 2, 64);
    defer bob.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try alice.insert(0, &.{@as(u16, 'x')}, &buf);
    const ins_id = buf.items[0].insert.id;
    try alice.merge(alice.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try alice.getOp(ins_id, &buf);
    const multi = alice.multiOp(buf.items);
    try bob.merge(multi);
    try bob.merge(multi);
    try std.testing.expectEqual(@as(u32, 1), bob.visLen());
}

test "lamport clock advances on merge" {
    var alice = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer alice.deinit();
    var bob = try Rogue(u16).init(std.testing.allocator, 2, 64);
    defer bob.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try alice.insert(0, &.{@as(u16, 'x')}, &buf);
    const ins_id = buf.items[0].insert.id;
    try alice.merge(alice.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try alice.getOp(ins_id, &buf);
    const multi = alice.multiOp(buf.items);
    try bob.merge(multi);
    try std.testing.expect(bob.sequence > multi.group_id.sequence);
}

test "delete a word" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("hello world"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.hide(5, 6, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity(); // hide " world"
    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    printDoc("delete a word", out.items);
    try std.testing.expectEqualSlices(u16, &w("hello"), out.items);
}

test "delete and retype" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("hello world"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.hide(6, 5, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity(); // hide "world"
    try r.insert(6, &w("beautiful"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    printDoc("delete and retype", out.items);
    try std.testing.expectEqualSlices(u16, &w("hello beautiful"), out.items);
}

test "undo restores deleted text" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("hello"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.hide(0, 5, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 0), r.visLen());
    var cursor = try r.head.clone(std.testing.allocator);
    defer cursor.deinit(std.testing.allocator);
    try r.undo(&cursor, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    printDoc("undo restores deleted text", out.items);
    try std.testing.expectEqualSlices(u16, &w("hello"), out.items);
}

test "insert in middle" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("helo"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &w("l"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity(); // insert 'l' after 'e'
    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    printDoc("insert in middle", out.items);
    try std.testing.expectEqualSlices(u16, &w("hello"), out.items);
}

test "two replicas converge on concurrent inserts" {
    var alice = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer alice.deinit();
    var bob = try Rogue(u16).init(std.testing.allocator, 2, 64);
    defer bob.deinit();

    // Both insert at position 0 independently
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try alice.insert(0, &w("alice"), &buf);
    const alice_ins_id = buf.items[0].insert.id;
    try alice.merge(alice.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try bob.insert(0, &w("bob"), &buf);
    const bob_ins_id = buf.items[0].insert.id;
    try bob.merge(bob.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Sync both ways
    try alice.getOp(alice_ins_id, &buf);
    try bob.merge(alice.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try bob.getOp(bob_ins_id, &buf);
    try alice.merge(bob.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var alice_out: std.ArrayListUnmanaged(u16) = .empty;
    defer alice_out.deinit(std.testing.allocator);
    var bob_out: std.ArrayListUnmanaged(u16) = .empty;
    defer bob_out.deinit(std.testing.allocator);
    try alice.render(null, null, &alice_out);
    try bob.render(null, null, &bob_out);
    printDoc("two replicas converge", alice_out.items);
    try std.testing.expectEqualSlices(u16, alice_out.items, bob_out.items);
    try std.testing.expectEqual(@as(u32, 8), alice.visLen()); // "alice" + "bob"
}

test "visibility is last-writer-wins by op id, not arrival order" {
    // Single replica, ops played in by hand. A char carries a hide (low id) and a
    // show (high id). LWW-by-id: the show wins → the char is VISIBLE no matter which
    // order the two arrive in. The bug: doHide/doShow set `deleted` imperatively, so
    // whichever arrives LAST wins — order-dependent, and divergent under reordering.
    const Op = @import("op.zig").WireOp(u16);
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(Op) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("x"), &buf);
    const x = buf.items[0].insert.id; // the char's NodeId — the hide/show target
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    const hide_lo = Op{ .hide = .{ .id = .{ .replica_id = 2, .sequence = 10 }, .target = x, .len = 1 } };
    const show_hi = Op{ .show = .{ .id = .{ .replica_id = 2, .sequence = 20 }, .target = x, .len = 1 } };

    // Deliver OUT OF ORDER: show (higher id) first, then hide (lower id).
    var a = [_]Op{show_hi};
    try r.merge(r.multiOp(a[0..]));
    var b = [_]Op{hide_lo};
    try r.merge(r.multiOp(b[0..]));

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    // Higher-id show wins → "x" stays visible. Imperative `deleted` renders "".
    try std.testing.expectEqualSlices(u16, &w("x"), out.items);
}

test "out-of-order insert parks cleanly — a later child isn't lost (phantom slot)" {
    // Author "ABXY": a parent chain A ← B ← X ← Y. A fresh receiver sees A first (so
    // its rope is non-empty), then X (parent B missing) and Y (parent X missing)
    // BEFORE B. X and Y must PARK leaving no phantom parent. The bug: allocSlot
    // registers the id before the parent check, so parked-X leaves a node_index entry
    // at an unlinked slot; Y then resolves through phantom-X and links into a subtree
    // unreachable from the rope root — lost for good when the real X finally lands.
    const alloc = std.testing.allocator;
    const Op = @import("op.zig").WireOp(u16);
    var buf: std.ArrayListUnmanaged(Op) = .empty;
    defer buf.deinit(alloc);

    var author = try Rogue(u16).init(alloc, 1, 64);
    defer author.deinit();
    var g: [4]NodeId = undefined;
    for ("ABXY", 0..) |ch, i| {
        try author.insert(@intCast(i), &.{ch}, &buf);
        g[i] = buf.items[0].opId();
        try author.merge(author.multiOp(buf.items));
        buf.clearRetainingCapacity();
    }
    const gA = g[0];
    const gB = g[1];
    const gX = g[2];
    const gY = g[3];

    var rx = try Rogue(u16).init(alloc, 2, 64);
    defer rx.deinit();
    // Deliver one op; a missing dependency parks (caller retries later).
    const deliver = struct {
        fn one(a: *Rogue(u16), r: *Rogue(u16), gid: NodeId, b: *std.ArrayListUnmanaged(Op)) !void {
            b.clearRetainingCapacity();
            try a.getOp(gid, b);
            r.merge(a.multiOp(b.items)) catch |e| switch (e) {
                error.UnknownParent, error.UnknownTarget => {},
                else => return e,
            };
        }
    }.one;

    try deliver(&author, &rx, gA, &buf); // lands → rope non-empty
    try deliver(&author, &rx, gX, &buf); // parks: parent B missing
    try deliver(&author, &rx, gY, &buf); // must park: parent X missing (not via phantom)
    try deliver(&author, &rx, gB, &buf); // lands
    try deliver(&author, &rx, gX, &buf); // retry X → lands
    try deliver(&author, &rx, gY, &buf); // retry Y → lands

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(alloc);
    try rx.render(null, null, &out);
    try std.testing.expectEqualSlices(u16, &w("ABXY"), out.items);
}

test "merge is atomic: a partial multi-op must not leak into the doc" {
    // Replica 1 writes "P". Replica 3 writes "abcdefgh" left of it, then a *second*
    // group "ijkl" (chars 3:9..3:12). Replica 2 (having seen all of replica 3) does a
    // seltype that hides 'a' (3:1) AND 'jkl' (3:10..3:12) and inserts "XY" left of 'b'
    // (3:2) — all in one group. A receiver that has only "abcdefgh" (NOT the "ijkl"
    // group) merges that seltype: hide 'a' succeeds, hide 'jkl' fails (target missing).
    // If merge is non-atomic, 'a' is left deleted even though the group was rejected —
    // the receiver silently loses content. It must park with NO partial state.
    const alloc = std.testing.allocator;
    const Op = @import("op.zig").WireOp(u16);
    var buf: std.ArrayListUnmanaged(Op) = .empty;
    defer buf.deinit(alloc);
    var dbuf: std.ArrayListUnmanaged(Op) = .empty;
    defer dbuf.deinit(alloc);

    var r1 = try Rogue(u16).init(alloc, 1, 64);
    defer r1.deinit();
    var r2 = try Rogue(u16).init(alloc, 2, 64);
    defer r2.deinit();
    var r3 = try Rogue(u16).init(alloc, 3, 64);
    defer r3.deinit();
    var rx = try Rogue(u16).init(alloc, 4, 64);
    defer rx.deinit();

    const deliver = struct {
        fn one(a: *Rogue(u16), r: *Rogue(u16), gid: NodeId, b: *std.ArrayListUnmanaged(Op)) !void {
            b.clearRetainingCapacity();
            try a.getOp(gid, b);
            r.merge(a.multiOp(b.items)) catch |e| switch (e) {
                error.UnknownParent, error.UnknownTarget => {},
                else => return e,
            };
        }
    }.one;

    try r1.insert(0, &w("P"), &buf);
    const gP = buf.items[0].opId();
    try r1.merge(r1.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Replica 3: "abcdefgh" left of P (group A), then "ijkl" right of h (group B).
    try deliver(&r1, &r3, gP, &dbuf);
    try r3.insert(0, &w("abcdefgh"), &buf);
    const gA = buf.items[0].opId();
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r3.insert(8, &w("ijkl"), &buf);
    const gB = buf.items[0].opId();
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Replica 2: hide a (3:1) and jkl (3:10..3:12), insert "XY" left of b (3:2). One group.
    try deliver(&r1, &r2, gP, &dbuf);
    try deliver(&r3, &r2, gA, &dbuf);
    try deliver(&r3, &r2, gB, &dbuf);
    try r2.hide(0, 1, &buf); // a (vis 0)
    try r2.hide(9, 3, &buf); // j,k,l (vis 9..11 in "abcdefghijklP")
    try r2.insert(1, &w("XY"), &buf); // left of b (vis 1)
    const gXY = buf.items[0].opId();
    try r2.merge(r2.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Receiver: has P + group A only (NOT group B). Merges the seltype gXY.
    try deliver(&r1, &rx, gP, &dbuf);
    try deliver(&r3, &rx, gA, &dbuf);
    deliver(&r2, &rx, gXY, &dbuf) catch {};

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(alloc);
    try rx.render(null, null, &out);
    // The rejected group must have left NO partial state: 'a' must still be visible.
    try std.testing.expectEqualSlices(u16, &w("abcdefghP"), out.items);
}

test "rope navigation: ropePrevTot / ropeNextTot / ropePrevVis / ropeNextVis" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 10);
    defer r.deinit();

    // Insert "abcde" — slots 1..5 in document order (a=1, b=2, c=3, d=4, e=5)
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("abcde"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Hide 'b' (vis_ix 1) and 'd' (vis_ix 2 after 'b' is hidden)
    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.hide(2, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Slots 2 (b) and 4 (d) are now deleted; 1 (a), 3 (c), 5 (e) are visible.

    // ropeNextTot: walks every node regardless of visibility
    try std.testing.expectEqual(@as(u32, 2), r.ropeNextTot(1));
    try std.testing.expectEqual(@as(u32, 3), r.ropeNextTot(2));
    try std.testing.expectEqual(@as(u32, 4), r.ropeNextTot(3));
    try std.testing.expectEqual(@as(u32, 5), r.ropeNextTot(4));
    try std.testing.expectEqual(NULL, r.ropeNextTot(5));

    // ropePrevTot: reverse of the above
    try std.testing.expectEqual(NULL, r.ropePrevTot(1));
    try std.testing.expectEqual(@as(u32, 1), r.ropePrevTot(2));
    try std.testing.expectEqual(@as(u32, 2), r.ropePrevTot(3));
    try std.testing.expectEqual(@as(u32, 3), r.ropePrevTot(4));
    try std.testing.expectEqual(@as(u32, 4), r.ropePrevTot(5));

    // ropeNextVis: skips deleted slots (2=b, 4=d)
    try std.testing.expectEqual(@as(u32, 3), r.ropeNextVis(1)); // a -> c
    try std.testing.expectEqual(@as(u32, 3), r.ropeNextVis(2)); // b(del) -> c
    try std.testing.expectEqual(@as(u32, 5), r.ropeNextVis(3)); // c -> e
    try std.testing.expectEqual(@as(u32, 5), r.ropeNextVis(4)); // d(del) -> e
    try std.testing.expectEqual(NULL, r.ropeNextVis(5)); // e -> end

    // ropePrevVis: reverse, skipping deleted slots
    try std.testing.expectEqual(NULL, r.ropePrevVis(1)); // a -> start
    try std.testing.expectEqual(@as(u32, 1), r.ropePrevVis(2)); // b(del) -> a
    try std.testing.expectEqual(@as(u32, 1), r.ropePrevVis(3)); // c -> a
    try std.testing.expectEqual(@as(u32, 3), r.ropePrevVis(4)); // d(del) -> c
    try std.testing.expectEqual(@as(u32, 3), r.ropePrevVis(5)); // e -> c
}

test "convergence: content address snapshots" {
    const n_replicas = 8;
    const n_ops = 1_000; // per replica total
    const ops_per_round = 100; // per replica per round
    const n_rounds = n_ops / ops_per_round;
    const cap: u32 = n_replicas * n_ops * 2 + 1024;
    const a = std.testing.allocator;

    var prng = std.Random.DefaultPrng.init(99);
    const rand = prng.random();

    var rogues: [n_replicas]Rogue(u16) = undefined;
    var op_log: [n_replicas]std.ArrayListUnmanaged(NodeId) = @splat(.empty);

    for (0..n_replicas) |i| {
        rogues[i] = try Rogue(u16).init(a, @intCast(i + 1), cap);
    }
    defer {
        for (0..n_replicas) |i| {
            rogues[i].deinit();
            op_log[i].deinit(a);
        }
    }

    const Snapshot = struct { addr: ContentAddress, text: std.ArrayListUnmanaged(u16) };
    var snapshots: std.ArrayListUnmanaged(Snapshot) = .empty;
    defer {
        for (snapshots.items) |*s| {
            s.addr.deinit(a);
            s.text.deinit(a);
        }
        snapshots.deinit(a);
    }

    // Phase 1: Generate ops in rounds; take occasional snapshots.
    var op_buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer op_buf.deinit(a);
    for (0..n_rounds) |_| {
        for (0..n_replicas) |i| {
            for (0..ops_per_round) |_| {
                const vlen = rogues[i].visLen();
                const r = rand.uintLessThan(u8, 10);
                if (r < 4 and vlen > 0) {
                    const pos = rand.uintLessThan(u32, vlen);
                    try rogues[i].hide(pos, 1, &op_buf);
                    try op_log[i].append(a, op_buf.items[0].opId());
                    try rogues[i].merge(rogues[i].multiOp(op_buf.items));
                    op_buf.clearRetainingCapacity();
                } else {
                    const pos = rand.uintLessThan(u32, vlen + 1);
                    const ch: u16 = @as(u16, 'a') + rand.uintLessThan(u16, 26);
                    try rogues[i].insert(pos, &.{ch}, &op_buf);
                    try op_log[i].append(a, op_buf.items[0].opId());
                    try rogues[i].merge(rogues[i].multiOp(op_buf.items));
                    op_buf.clearRetainingCapacity();
                }
            }
        }

        // ~30% chance per round to snapshot a random replica.
        if (rand.uintLessThan(u8, 10) < 3) {
            const src = rand.uintLessThan(usize, n_replicas);
            var text: std.ArrayListUnmanaged(u16) = .empty;
            try rogues[src].render(null, null, &text);
            try snapshots.append(a, .{
                .addr = try rogues[src].head.clone(a),
                .text = text,
            });
        }
    }

    // Phase 2: Deliver all ops to every replica (including own ops — tests idempotency).
    // Cursor-based interleave preserves per-source ordering while randomising across sources.
    for (0..n_replicas) |target| {
        var cursors = [_]usize{0} ** n_replicas;
        while (true) {
            var srcs: [n_replicas]usize = undefined;
            var nsrcs: usize = 0;
            for (0..n_replicas) |src| {
                if (cursors[src] < op_log[src].items.len) {
                    srcs[nsrcs] = src;
                    nsrcs += 1;
                }
            }
            if (nsrcs == 0) break;
            const src = srcs[rand.uintLessThan(usize, nsrcs)];
            const group_id = op_log[src].items[cursors[src]];
            cursors[src] += 1;
            op_buf.clearRetainingCapacity();
            try rogues[src].getOp(group_id, &op_buf);
            try rogues[target].merge(rogues[src].multiOp(op_buf.items));
        }
    }

    // Phase 3: All replicas must converge to the same visible and total text.
    var vis_bufs: [n_replicas]std.ArrayListUnmanaged(u16) = @splat(.empty);
    defer for (&vis_bufs) |*b| b.deinit(a);
    var tot_bufs: [n_replicas]std.ArrayListUnmanaged(u16) = @splat(.empty);
    defer for (&tot_bufs) |*b| b.deinit(a);

    for (&rogues, &vis_bufs, &tot_bufs) |*rogue, *vb, *tb| {
        try rogue.render(null, null, vb);
        try rogue.renderTot(null, null, tb);
    }
    for (vis_bufs[1..]) |b| try std.testing.expectEqualSlices(u16, vis_bufs[0].items, b.items);
    for (tot_bufs[1..]) |b| try std.testing.expectEqualSlices(u16, tot_bufs[0].items, b.items);

    // Phase 4: Every snapshot must render identically on every replica at its content address.
    var render_buf: std.ArrayListUnmanaged(u16) = .empty;
    defer render_buf.deinit(a);
    for (snapshots.items) |*s| {
        for (&rogues) |*rogue| {
            render_buf.clearRetainingCapacity();
            try rogue.renderAt(&s.addr, null, null, &render_buf);
            try std.testing.expectEqualSlices(u16, s.text.items, render_buf.items);
        }
    }
}

test "addrOf round-trips through renderAt (full and ranged)" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 256);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    try r.insert(0, &w("hello world"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(alloc);

    // Full doc: renderAt(addrOf()) reproduces the whole text.
    var addr = try r.addrOf(null, null);
    defer addr.deinit(alloc);
    try r.renderAt(&addr, null, null, &out);
    try std.testing.expectEqualSlices(u16, &w("hello world"), out.items);

    // Range "hello" (vis indices 0..4): renderAt(addrOf(s,e), s, e).
    const s = r.visId(0).?;
    const e = r.visId(4).?;
    var raddr = try r.addrOf(s, e);
    defer raddr.deinit(alloc);
    out.clearRetainingCapacity();
    try r.renderAt(&raddr, s, e, &out);
    try std.testing.expectEqualSlices(u16, &w("hello"), out.items);
}

test "renderAt shows the document as it was at an earlier address" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 256);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    try r.insert(0, &w("abc"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var snapshot = try r.head.clone(alloc);
    defer snapshot.deinit(alloc);

    // Delete 'b', then insert 'X' in its place.
    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(alloc);
    try r.render(null, null, &out);
    try std.testing.expectEqualSlices(u16, &w("ac"), out.items);

    // At the snapshot, 'b' was still there.
    out.clearRetainingCapacity();
    try r.renderAt(&snapshot, null, null, &out);
    try std.testing.expectEqualSlices(u16, &w("abc"), out.items);
}

test "addrOf changes on hide within the span" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 256);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    try r.insert(0, &w("abc"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    const s = r.visId(0).?;
    const e = r.visId(2).?;
    var before = try r.addrOf(s, e);
    defer before.deinit(alloc);

    try r.hide(1, 1, &buf); // delete 'b' — a hide op lands in its history
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var after = try r.addrOf(s, e);
    defer after.deinit(alloc);
    // The hide op has a higher seq than the insert, so the span's address advances.
    try std.testing.expect(after.maxNodeId().sequence > before.maxNodeId().sequence);
}

test "addrOf is precise: edits outside the span leave it unchanged" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 256);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    try r.insert(0, &w("abcd"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    const s = r.visId(0).?; // 'a'
    const e = r.visId(1).?; // 'b'
    var before = try r.addrOf(s, e);
    defer before.deinit(alloc);

    // Insert 'X' into the "cd" half — the "ab" span's address must not move.
    try r.insert(3, &w("X"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var after_outside = try r.addrOf(s, e);
    defer after_outside.deinit(alloc);
    try std.testing.expectEqual(before.maxNodeId(), after_outside.maxNodeId());

    // Insert 'Y' into the "ab" half — now the span changed.
    try r.insert(1, &w("Y"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var after_inside = try r.addrOf(s, e);
    defer after_inside.deinit(alloc);
    try std.testing.expect(after_inside.maxNodeId().sequence > before.maxNodeId().sequence);
}

test "addrOf and renderAt reject unknown ids and inverted ranges" {
    const alloc = std.testing.allocator;
    var r = try Rogue(u16).init(alloc, 1, 256);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    try r.insert(0, &w("abc"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var addr = try r.addrOf(null, null);
    defer addr.deinit(alloc);
    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(alloc);

    const ghost = NodeId{ .replica_id = 99, .sequence = 99 };
    try std.testing.expectError(error.UnknownId, r.addrOf(ghost, null));
    try std.testing.expectError(error.UnknownId, r.renderAt(&addr, ghost, null, &out));

    // start after end is an inverted range.
    const s = r.visId(2).?;
    const e = r.visId(0).?;
    try std.testing.expectError(error.InvalidRange, r.addrOf(s, e));
    try std.testing.expectError(error.InvalidRange, r.renderAt(&addr, s, e, &out));
}

test "bench: 1M random inserts" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 1_000_002);
    defer r.deinit();

    var prng = std.Random.DefaultPrng.init(42);
    const rand = prng.random();

    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    var timer = try std.time.Timer.start();
    for (0..1_000_000) |_| {
        const vis_ix = rand.uintLessThan(u32, r.visLen() + 1);
        try r.insert(vis_ix, &.{@as(u16, 'a')}, &buf);
        try r.merge(r.multiOp(buf.items));
        buf.clearRetainingCapacity();
    }
    const ns = timer.read();
    std.debug.print("1M random inserts: {}ms ({} ns/op)\n", .{
        ns / std.time.ns_per_ms,
        ns / 1_000_000,
    });

    const n = r.totLen();
    const log2n: u32 = @intFromFloat(@log2(@as(f64, @floatFromInt(n))));
    const height = Rope.height(r.rope, r.rope_root);
    std.debug.print("rope height: {} (log2(n)={})\n", .{ height, log2n });
    try std.testing.expect(height <= 5 * log2n);
}

test "bench: 1M sequential inserts" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 1_000_002);
    defer r.deinit();

    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    var timer = try std.time.Timer.start();
    for (0..1_000_000) |_| {
        try r.insert(r.visLen(), &.{@as(u16, 'a')}, &buf);
        try r.merge(r.multiOp(buf.items));
        buf.clearRetainingCapacity();
    }
    const insert_ns = timer.read();
    std.debug.print("1M sequential inserts: {}ms ({} ns/op)\n", .{
        insert_ns / std.time.ns_per_ms,
        insert_ns / 1_000_000,
    });

    var out = std.ArrayListUnmanaged(u16){};
    defer out.deinit(std.testing.allocator);
    try out.ensureTotalCapacity(std.testing.allocator, r.visLen());
    timer.reset();
    for (0..10) |_| {
        out.clearRetainingCapacity();
        try r.render(null, null, &out);
    }
    const render_ns = timer.read() / 10;
    std.debug.print("render 1M chars: {}ms ({} ns/char)\n", .{
        render_ns / std.time.ns_per_ms,
        render_ns / 1_000_000,
    });

    try std.testing.expectEqual(r.visLen(), @as(u32, @intCast(out.items.len)));
}

test "insert at 0 three times" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("one"), &buf);
    try r.insert(0, &w("two"), &buf);
    try r.insert(0, &w("three"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    printDoc("root sort", out.items);
    try std.testing.expectEqualSlices(u16, &w("onetwothree"), out.items);

    // Sibling sort: insert "one", then stage three inserts at the same position.
    var r2 = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r2.deinit();
    var buf2: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf2.deinit(std.testing.allocator);
    try r2.insert(0, &w("one"), &buf2);
    try r2.merge(r2.multiOp(buf2.items));
    buf2.clearRetainingCapacity();
    try r2.insert(3, &w("two"), &buf2);
    try r2.insert(3, &w("three"), &buf2);
    try r2.insert(3, &w("four"), &buf2);
    try r2.merge(r2.multiOp(buf2.items));
    buf2.clearRetainingCapacity();
    out.clearRetainingCapacity();
    try r2.render(null, null, &out);
    printDoc("sibling sort", out.items);
    try std.testing.expectEqualSlices(u16, &w("onetwothreefour"), out.items);
}

/// One run of the delayed per-channel network convergence fuzz (see the seed-sweep
/// test below). N replicas interleave local ops (insert / hide) with delivery over
/// the N×(N-1) directed channels, each draining at its own random speed → channels
/// drift apart and deliver cross-source ops out of order (a delete before its target
/// insert, a child before its parent). After a full drain every replica must render
/// identically, vis AND tot. This is the discovery engine that found the delete-drop,
/// visibility-LWW, and phantom-slot bugs — a failing seed is a one-line reproducer.
fn convergesUnderDelayedNetwork(comptime n_replicas: usize, seed: u64, n_steps: usize) !void {
    const cap: u32 = @intCast(n_steps + 64);
    const verbose = false;

    var prng = std.Random.DefaultPrng.init(seed);
    const rand = prng.random();

    var rogues: [n_replicas]Rogue(u16) = undefined;
    var all_groups: [n_replicas]std.ArrayListUnmanaged(NodeId) = undefined;

    for (0..n_replicas) |i| {
        rogues[i] = try Rogue(u16).init(std.testing.allocator, @intCast(i + 1), cap);
        all_groups[i] = .empty;
    }
    defer {
        for (0..n_replicas) |i| {
            rogues[i].deinit();
            all_groups[i].deinit(std.testing.allocator);
        }
    }

    // cursors[target][source] = index into all_groups[source] of the next op
    // from `source` that hasn't been delivered to `target` yet.
    var cursors: [n_replicas][n_replicas]usize = undefined;
    for (&cursors) |*row| row.* = [_]usize{0} ** n_replicas;

    var op_buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer op_buf.deinit(std.testing.allocator);

    // Per-(target,source) delivery speed — the whole network of directed channels,
    // each draining at its own rate. A low-speed channel is starved, so a replica
    // lags far behind ONE source while keeping up with the others: the delay that
    // lets B's delete of A's text reach C before A's text does. Uniform delivery
    // keeps every channel roughly caught up and never opens that gap.
    var speed: [n_replicas][n_replicas]f32 = undefined;
    for (0..n_replicas) |t| {
        for (0..n_replicas) |s| speed[t][s] = 0.02 + 0.88 * rand.float(f32);
    }

    var total_inserts: usize = 0; // instrumentation: total chars ever inserted

    for (0..n_steps) |_| {
        // 1. One random replica emits a local op (insert, or hide of a visible char).
        op_buf.clearRetainingCapacity();
        const idx = rand.uintLessThan(usize, n_replicas);
        const vlen = rogues[idx].visLen();
        if (rand.uintLessThan(u8, 10) < 3 and vlen > 0) {
            try rogues[idx].hide(rand.uintLessThan(u32, vlen), 1, &op_buf);
        } else {
            const ch: u16 = @as(u16, 'a') + rand.uintLessThan(u16, 26);
            try rogues[idx].insert(rand.uintLessThan(u32, vlen + 1), &.{ch}, &op_buf);
            total_inserts += 1;
        }
        try all_groups[idx].append(std.testing.allocator, op_buf.items[0].opId());
        try rogues[idx].merge(rogues[idx].multiOp(op_buf.items));

        // 2. Each directed channel independently delivers (at most) one queued op
        //    this step, gated by its own random speed, so channels drift apart. On
        //    UnknownParent the op waits — a parent from a slower channel isn't here.
        for (0..n_replicas) |target| {
            for (0..n_replicas) |src| {
                if (src == target) continue;
                if (cursors[target][src] >= all_groups[src].items.len) continue;
                if (rand.float(f32) >= speed[target][src]) continue;
                const group_id = all_groups[src].items[cursors[target][src]];
                op_buf.clearRetainingCapacity();
                try rogues[src].getOp(group_id, &op_buf);
                rogues[target].merge(rogues[src].multiOp(op_buf.items)) catch |err| switch (err) {
                    // Dependency (parent insert, or a hide/show's target char) from
                    // another, slower channel isn't here yet — wait, don't advance.
                    error.UnknownParent, error.UnknownTarget => continue,
                    else => return err,
                };
                cursors[target][src] += 1;
            }
        }
    }

    // Final drain: keep iterating until a full pass makes no progress. On
    // UnknownParent we skip that (target, src) for this pass; later passes
    // pick it up after the parent arrives via a different (target, src')
    // pair. If a full pass makes no progress but anything is still pending
    // → stuck (genuine bug, not just a delivery-order quirk).
    while (true) {
        var any_progress = false;
        for (0..n_replicas) |target| {
            // Shuffle the source order independently per target so replicas apply
            // cross-source ops in DIFFERENT relative orders. A fixed order makes
            // every replica take the same branch on a delivery-order race, so they
            // converge on it — even if it's wrong — and a dropped op hides as false
            // convergence. Per-target reordering surfaces genuine order-dependence
            // (e.g. a delete delivered before the insert of the char it targets).
            var src_order: [n_replicas]usize = undefined;
            for (0..n_replicas) |k| src_order[k] = k;
            rand.shuffle(usize, &src_order);
            for (src_order) |src| {
                while (src != target and cursors[target][src] < all_groups[src].items.len) {
                    const group_id = all_groups[src].items[cursors[target][src]];
                    op_buf.clearRetainingCapacity();
                    try rogues[src].getOp(group_id, &op_buf);
                    rogues[target].merge(rogues[src].multiOp(op_buf.items)) catch |err| switch (err) {
                        error.UnknownParent, error.UnknownTarget => break, // try next (target, src)
                        else => return err,
                    };
                    cursors[target][src] += 1;
                    any_progress = true;
                }
            }
        }
        if (any_progress) continue;
        // No progress this pass — check if anything still pending.
        var stuck = false;
        var stuck_total: usize = 0;
        for (0..n_replicas) |target| {
            for (0..n_replicas) |src| {
                if (src != target and cursors[target][src] < all_groups[src].items.len) {
                    stuck = true;
                    stuck_total += all_groups[src].items.len - cursors[target][src];
                }
            }
        }
        if (stuck) {
            std.debug.print("seed {d}: drain stuck, {d} ops still pending\n", .{ seed, stuck_total });
            return error.DeliveryStuck;
        }
        break;
    }

    var vis_bufs: [n_replicas]std.ArrayListUnmanaged(u16) = undefined;
    for (&vis_bufs) |*b| b.* = .empty;
    defer for (&vis_bufs) |*b| b.deinit(std.testing.allocator);
    for (&rogues, &vis_bufs) |*rogue, *buf| try rogue.render(null, null, buf);

    if (verbose) {
        std.debug.print("\nfinal renders:\n", .{});
        for (vis_bufs, 0..) |b, i| {
            std.debug.print("  r{d}: ", .{i});
            for (b.items) |c| std.debug.print("{c}", .{@as(u8, @intCast(c))});
            std.debug.print("\n", .{});
        }
    }

    // Render tot up front so a vis divergence can report whether the TOTAL order
    // (including deleted chars) also differs. tot-equal ⇒ pure deleted-flag
    // divergence (a hide/show applied on one replica but not another); tot-differ
    // ⇒ the fugue structure itself diverged (insert placement).
    var tot_bufs: [n_replicas]std.ArrayListUnmanaged(u16) = undefined;
    for (&tot_bufs) |*b| b.* = .empty;
    defer for (&tot_bufs) |*b| b.deinit(std.testing.allocator);
    for (&rogues, &tot_bufs) |*rogue, *buf| try rogue.renderTot(null, null, buf);

    for (vis_bufs[1..], 1..) |b, i| {
        std.testing.expectEqualSlices(u16, vis_bufs[0].items, b.items) catch {
            const tot_equal = std.mem.eql(u16, tot_bufs[0].items, tot_bufs[i].items);
            std.debug.print("seed {d}: vis diverged at r{d} (tot_equal={}) total_inserts={d}\n", .{ seed, i, tot_equal, total_inserts });
            // Classify: nodeCount (authoritative tree size) vs render length. If
            // nodeCounts differ → a real merge-level drop/dup. If nodeCount matches
            // but render differs → a traversal bug. If both == total_inserts on all
            // but the test diverged → the network double-delivered.
            for (0..n_replicas) |ri| {
                const nodes = if (rogues[ri].rope_root == 0) @as(u32, 0) else rogues[ri].rope[rogues[ri].rope_root].tot_size;
                std.debug.print("  r{d}: nodeCount={d} totRenderLen={d} visLen={d}\n", .{ ri, nodes, tot_bufs[ri].items.len, rogues[ri].visLen() });
            }
            return error.TestExpectedEqual;
        };
    }

    for (tot_bufs[1..], 1..) |b, i| {
        std.testing.expectEqualSlices(u16, tot_bufs[0].items, b.items) catch {
            std.debug.print("seed {d}: tot diverged at r{d}\n", .{ seed, i });
            return error.TestExpectedEqual;
        };
    }
}

test "convergence: delayed per-channel network (seed sweep fuzz)" {
    var seed: u64 = 1;
    while (seed <= 40) : (seed += 1) {
        try convergesUnderDelayedNetwork(6, seed, 5_000);
    }
}

/// Helper: undo all ops in `doc` starting from a fresh cursor at doc.head.
/// Returns the number of undo groups applied.
fn undoAll(doc: *Rogue(u16), buf: *std.ArrayListUnmanaged(@import("op.zig").WireOp(u16))) !u32 {
    var cursor = try doc.head.clone(std.testing.allocator);
    defer cursor.deinit(std.testing.allocator);
    var count: u32 = 0;
    while (true) {
        try doc.undo(&cursor, buf);
        if (buf.items.len == 0) break;
        try doc.merge(doc.multiOp(buf.items));
        buf.clearRetainingCapacity();
        count += 1;
    }
    return count;
}

test "undo exhausts to empty: single replica, multiple groups" {
    // Two separate inserts → two groups. Undoing both should leave visLen == 0.
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("hello"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(5, &w(" world"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 11), r.visLen());

    const n = try undoAll(&r, &buf);
    try std.testing.expectEqual(@as(u32, 2), n);
    try std.testing.expectEqual(@as(u32, 0), r.visLen());
}

test "undo exhausts to empty: multi-replica with stale cursor entry" {
    // Scenario that triggered the stale-cursor bug:
    //
    //   Alice inserts "hello" (sequences 1-5, group_seq 1).
    //   Bob merges Alice's op → Bob's Lamport clock ticks to 6.
    //   Bob inserts "world" (sequences 6-10, group_seq 6).
    //   Alice merges Bob's op.
    //
    // Undo pass on Alice's doc:
    //   Step 1 – undo Bob's insert (group {2,6}); cursor[2] → 5.
    //   Step 2 – maxNodeId picks {2,5}; getOp finds no Bob op with group_seq ≤ 5
    //            (Bob's only group is at 6) → stale entry → unset cursor[2] → retry.
    //            maxNodeId picks {1,5}; getOp finds Alice's insert → undo it.
    //   Result  – visLen == 0.

    const alloc = std.testing.allocator;
    var alice = try Rogue(u16).init(alloc, 1, 64);
    defer alice.deinit();
    var bob = try Rogue(u16).init(alloc, 2, 64);
    defer bob.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    // Alice inserts "hello"; sync to Bob (ticks Bob's clock to 6).
    try alice.insert(0, &w("hello"), &buf);
    const alice_op = alice.multiOp(buf.items);
    try alice.merge(alice_op);
    try bob.merge(alice_op);
    buf.clearRetainingCapacity();

    // Bob inserts "world" — his first sequence in this doc is 6, not 1.
    try bob.insert(0, &w("world"), &buf);
    const bob_op = bob.multiOp(buf.items);
    try bob.merge(bob_op);
    try alice.merge(bob_op);
    buf.clearRetainingCapacity();

    try std.testing.expectEqual(@as(u32, 10), alice.visLen());

    // Undo all ops from Alice's perspective.
    const n = try undoAll(&alice, &buf);

    // Both inserts must have been reversed.
    try std.testing.expectEqual(@as(u32, 2), n);
    try std.testing.expectEqual(@as(u32, 0), alice.visLen());
}

test "redo re-applies content" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("hello"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 5), r.visLen());

    var cursor = try r.head.clone(std.testing.allocator);
    defer cursor.deinit(std.testing.allocator);

    // Undo: hide "hello".
    try r.undo(&cursor, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 0), r.visLen());

    // Redo: re-applies "hello" (a SHOW, not a hide).
    try r.redo(&cursor, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 5), r.visLen());
}

test "redo re-applies a delete" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    // "ab", then delete "b" → "a".
    try r.insert(0, &w("ab"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 1), r.visLen());

    var cursor = try r.head.clone(std.testing.allocator);
    defer cursor.deinit(std.testing.allocator);

    // Undo the delete → "ab".
    try r.undo(&cursor, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 2), r.visLen());

    // Redo re-applies the delete → "a".
    try r.redo(&cursor, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 1), r.visLen());
}

test "redo ignores replicas that have no group past the cursor" {
    // A doc shared across three replicas. Replicas 1 and 2 contributed their last
    // op long ago (their cursor sits *at* their head), and replica 3 just typed
    // three groups. Undo all three, then redo: redo must re-apply replica 3's "a".
    //
    // Before the fix, `nextGroup` ceiling-searched with no replica check, so a
    // "spent" replica (no op past its cursor) spilled into the *next* replica and
    // returned that replica's group. redo then picked a stale, already-visible op
    // (e.g. replica 2's "y") and re-applied it as a no-op — leaving the genuinely
    // undone group untouched.
    const alloc = std.testing.allocator;
    var r1 = try Rogue(u16).init(alloc, 1, 64);
    defer r1.deinit();
    var r2 = try Rogue(u16).init(alloc, 2, 64);
    defer r2.deinit();
    var r3 = try Rogue(u16).init(alloc, 3, 64);
    defer r3.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(alloc);

    // Replica 1 inserts "x"; everyone merges.
    try r1.insert(0, &w("x"), &buf);
    const x = r1.multiOp(buf.items);
    try r1.merge(x);
    try r2.merge(x);
    try r3.merge(x);
    buf.clearRetainingCapacity();

    // Replica 2 inserts "y"; everyone merges.
    try r2.insert(1, &w("y"), &buf);
    const y = r2.multiOp(buf.items);
    try r2.merge(y);
    try r1.merge(y);
    try r3.merge(y);
    buf.clearRetainingCapacity();

    // Replica 3 types three separate groups.
    try r3.insert(0, &w("a"), &buf);
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r3.insert(1, &w("b"), &buf);
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r3.insert(2, &w("c"), &buf);
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 5), r3.visLen());

    var cursor = try r3.head.clone(alloc);
    defer cursor.deinit(alloc);

    // Undo all three of replica 3's groups → "xy" remains.
    try r3.undo(&cursor, &buf);
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r3.undo(&cursor, &buf);
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r3.undo(&cursor, &buf);
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 2), r3.visLen());

    // Redo must re-apply replica 3's "a" (the smallest undone group), not a
    // stale op spilled in from replica 1 or 2.
    try r3.redo(&cursor, &buf);
    try r3.merge(r3.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 3), r3.visLen());
}

test "rangeHasTag detects tag chars in a target range" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    // "<p>h</p>" → ids (1,1)..(1,8): < p > h < / p >
    try r.insert(0, &w("<p>h</p>"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // "<p>" (ids 1..3) contains tags.
    try std.testing.expect(r.rangeHasTag(NodeId{ .replica_id = 1, .sequence = 1 }, 3));
    // "h" (id 4) does not.
    try std.testing.expect(!r.rangeHasTag(NodeId{ .replica_id = 1, .sequence = 4 }, 1));
    // "</p>" (ids 5..8) contains tags.
    try std.testing.expect(r.rangeHasTag(NodeId{ .replica_id = 1, .sequence = 5 }, 4));
    // A range that doesn't exist yet is skipped, not a false positive.
    try std.testing.expect(!r.rangeHasTag(NodeId{ .replica_id = 1, .sequence = 99 }, 2));
}

// ═══════════════════════════════════════════════════════════
// Op bounds tests (insertIndex / hideIndex / showIndex / opBounds)
// ═══════════════════════════════════════════════════════════

test "insertIndex: empty doc, Root side falls back to 0" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    const op = buf.items[0].insert;
    try std.testing.expectEqual(@import("op.zig").Side.Root, op.side);
    try std.testing.expectEqual(@as(u32, 0), try r.insertIndex(op.parent, op.side, op.id));
}

test "insertIndex: right-side append after parent returns parent's vis_ix" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "AB"; A at vis 0, B at vis 1.

    // Predict an insert at vis 2 (after B). parentForInsert returns (B, .Right).
    try r.insert(2, &w("C"), &buf);
    const op = buf.items[0].insert;
    try std.testing.expectEqual(@import("op.zig").Side.Right, op.side);
    // Left neighbor of new C is B at vis 1.
    try std.testing.expectEqual(@as(u32, 1), try r.insertIndex(op.parent, op.side, op.id));
}

test "insertIndex: left-side prepend at vis 0 falls back to 0" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Insert at vis 0 (prepend); parentForInsert returns (A, .Left).
    try r.insert(0, &w("X"), &buf);
    const op = buf.items[0].insert;
    try std.testing.expectEqual(@import("op.zig").Side.Left, op.side);
    // No prev sibling, prev_tot(A) = NULL → fallback 0.
    try std.testing.expectEqual(@as(u32, 0), try r.insertIndex(op.parent, op.side, op.id));
}

test "insertIndex: left-side mid-doc (parent has right children)" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "AB". B is a right-child of A. Inserting between A and B targets B as Left.

    try r.insert(1, &w("Y"), &buf);
    const op = buf.items[0].insert;
    try std.testing.expectEqual(@import("op.zig").Side.Left, op.side);
    // Predicted left neighbor: prev_tot(B) = A at vis 0.
    try std.testing.expectEqual(@as(u32, 0), try r.insertIndex(op.parent, op.side, op.id));
}

test "insertIndex: unknown parent errors" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    const fake_parent = NodeId{ .replica_id = 99, .sequence = 99 };
    const fake_new = NodeId{ .replica_id = 99, .sequence = 100 };
    try std.testing.expectError(error.UnknownId, r.insertIndex(fake_parent, .Right, fake_new));
}

test "insertIndex: walks past hidden left-neighbor via floorVis" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    const b_id = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "AB" with B as right-child of A; B has no right-children of its own.
    // Hide B. Visible: just "A".
    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 1), r.visLen());

    // Predict insert as right-child of B with no prev_sib in B's right_head.
    // predicted = parent_slot = B (hidden). floorVis walks left to A (vis 0).
    const new_id = NodeId{ .replica_id = 99, .sequence = 100 };
    try std.testing.expectEqual(@as(u32, 0), try r.insertIndex(b_id, .Right, new_id));
}

test "hideIndex: middle of doc brackets via prev/next visible" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    const b_id = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &w("C"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "ABC" — A vis 0, B vis 1, C vis 2.

    // Hide B: prevVis(B) = A (vis 0), nextVis(B) = C (vis 2).
    const r1 = try r.hideIndex(b_id, 1);
    try std.testing.expectEqual(@as(u32, 0), r1[0]);
    try std.testing.expectEqual(@as(u32, 2), r1[1]);
}

test "hideIndex: at doc start falls back lo=0" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    const a_id = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &w("C"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "ABC". Hide range starting at A (no prev visible to the left).

    const r1 = try r.hideIndex(a_id, 2);
    try std.testing.expectEqual(@as(u32, 0), r1[0]); // prev fallback
    try std.testing.expectEqual(@as(u32, 2), r1[1]); // next is C at vis 2
}

test "hideIndex: at doc end falls back hi=visLen-1" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    const b_id = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &w("C"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "ABC". Hide [B, C] — nextVis(C) is null, hi fallback to visLen-1 = 2.

    const r1 = try r.hideIndex(b_id, 2);
    try std.testing.expectEqual(@as(u32, 0), r1[0]); // prev is A
    try std.testing.expectEqual(@as(u32, 2), r1[1]); // hi fallback
}

test "hideIndex: unknown target errors" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);
    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    const fake_target = NodeId{ .replica_id = 99, .sequence = 99 };
    try std.testing.expectError(error.UnknownId, r.hideIndex(fake_target, 1));
}

test "showIndex: same bracket logic on already-hidden target" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    const b_id = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &w("C"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "ABC", hide B.
    try r.hide(1, 1, &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // Visible "AC". prevVis(B) walks left of B → A (vis 0), nextVis(B) → C (vis 1).

    const r1 = try r.showIndex(b_id, 1);
    try std.testing.expectEqual(@as(u32, 0), r1[0]);
    try std.testing.expectEqual(@as(u32, 1), r1[1]);
}

test "visIxBounds: single insert op matches insertIndex" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("A"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("B"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(2, &w("C"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    try r.insert(3, &w("D"), &buf);
    // visIxBounds on the pending insert; left neighbor is C at vis 2, right is doc end (2).
    const r1 = try r.visIxBounds(buf.items);
    try std.testing.expectEqual(@as(u32, 2), r1[0]);
    try std.testing.expectEqual(@as(u32, 2), r1[1]);
}

test "visIxBounds: mixed payload aggregates min/max" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("ABCDE"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    // "ABCDE", A at 0, B at 1, ..., E at 4.

    // Build a payload: insert at vis 4 (neighbors D=3, E=4)
    // + hide at C (bracket (1, 3): prev B = 1, next D = 3).
    // Aggregate min = 1, max = 4.
    try r.insert(4, &w("X"), &buf); // contributes (3, 4)
    try r.hide(2, 1, &buf); // contributes (1, 3)

    const r1 = try r.visIxBounds(buf.items);
    try std.testing.expectEqual(@as(u32, 1), r1[0]);
    try std.testing.expectEqual(@as(u32, 4), r1[1]);
}

test "visIxBounds: applied insert brackets its own chars via prev/next vis" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 64);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    // "ac", then insert "b" between them → "abc" (a=0, b=1, c=2).
    try r.insert(0, &w("a"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("c"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try r.insert(1, &w("b"), &buf);
    const b_id = buf.items[0].insert.id;
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    // Reconstruct the *applied* "b" op and bound it: neighbors a (0) and c (2),
    // not "b" itself — the case that previously broke the re-fold tail.
    try r.getOp(b_id, &buf);
    const b = try r.visIxBounds(buf.items);
    try std.testing.expectEqual(@as(u32, 0), b[0]);
    try std.testing.expectEqual(@as(u32, 2), b[1]);
}

test "multi-insert batch: paired tags" {
    var r = try Rogue(u16).init(std.testing.allocator, 1, 256);
    defer r.deinit();
    var buf: std.ArrayListUnmanaged(@import("op.zig").WireOp(u16)) = .empty;
    defer buf.deinit(std.testing.allocator);

    try r.insert(0, &w("abcde"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();
    try std.testing.expectEqual(@as(u32, 5), r.visLen());

    try r.insert(0, &w("<b>"), &buf);
    try r.insert(3, &w("</b>"), &buf);
    try r.merge(r.multiOp(buf.items));
    buf.clearRetainingCapacity();

    var out: std.ArrayListUnmanaged(u16) = .empty;
    defer out.deinit(std.testing.allocator);
    try r.render(null, null, &out);
    const utf8 = try std.unicode.utf16LeToUtf8Alloc(std.testing.allocator, out.items);
    defer std.testing.allocator.free(utf8);
    try std.testing.expect(std.mem.indexOf(u8, utf8, "<b>abc</b>") != null);
}

fn textOnlyFuzz(comptime n: usize, seed: u64, steps: usize) !void {
    const Op = @import("op.zig").WireOp(u16);
    const cap: u32 = @intCast(steps * 2 + 64);
    var prng = std.Random.DefaultPrng.init(seed);
    const rand = prng.random();

    var r: [n]Rogue(u16) = undefined;
    var groups: [n]std.ArrayListUnmanaged(NodeId) = undefined;
    var cursors: [n][n]usize = undefined;
    for (&cursors) |*row| row.* = [_]usize{0} ** n;

    for (0..n) |i| {
        r[i] = try Rogue(u16).init(std.testing.allocator, @intCast(i + 1), cap);
        groups[i] = .empty;
    }
    defer {
        for (0..n) |i| {
            r[i].deinit();
            groups[i].deinit(std.testing.allocator);
        }
    }

    var buf: std.ArrayListUnmanaged(Op) = .empty;
    defer buf.deinit(std.testing.allocator);

    // Per-replica undo cursors — walk the oplog backwards.
    var undo_cursor: [n]ContentAddress = undefined;
    for (0..n) |i| {
        undo_cursor[i] = ContentAddress.init();
        undo_cursor[i] = try r[i].head.clone(std.testing.allocator);
    }
    defer for (0..n) |i| undo_cursor[i].deinit(std.testing.allocator);

    var undo_buf: std.ArrayListUnmanaged(Op) = .empty;
    defer undo_buf.deinit(std.testing.allocator);

    for (0..steps) |_| {
        buf.clearRetainingCapacity();
        const idx = rand.uintLessThan(usize, n);
        const vlen = r[idx].visLen();

        if (rand.uintLessThan(u8, 10) < 1 and vlen >= 2) {
            // ~10%: undo — produces hide/show ops that are synced like any other.
            undo_buf.clearRetainingCapacity();
            r[idx].undo(&undo_cursor[idx], &undo_buf) catch continue;
            if (undo_buf.items.len == 0) continue;
            try buf.appendSlice(std.testing.allocator, undo_buf.items);
        } else if (rand.uintLessThan(u8, 10) < 3 and vlen > 0) {
            try r[idx].hide(rand.uintLessThan(u32, vlen), 1, &buf);
        } else {
            const ch: u16 = @as(u16, 'a') + rand.uintLessThan(u16, 26);
            try r[idx].insert(rand.uintLessThan(u32, vlen + 1), &.{ch}, &buf);
        }
        const multi = r[idx].multiOp(buf.items);
        try groups[idx].append(std.testing.allocator, multi.group_id);
        try r[idx].merge(multi);
    }

    var drain_buf: std.ArrayListUnmanaged(Op) = .empty;
    defer drain_buf.deinit(std.testing.allocator);

    while (true) {
        var any_progress = false;
        for (0..n) |t| {
            var src_order: [n]usize = undefined;
            for (0..n) |k| src_order[k] = k;
            rand.shuffle(usize, &src_order);
            for (src_order) |s| {
                if (s == t) continue;
                while (cursors[t][s] < groups[s].items.len) {
                    const gid = groups[s].items[cursors[t][s]];
                    drain_buf.clearRetainingCapacity();
                    try r[s].getOp(gid, &drain_buf);
                    r[t].merge(r[s].multiOp(drain_buf.items)) catch |err| switch (err) {
                        error.UnknownParent, error.UnknownTarget => break,
                        else => return err,
                    };
                    cursors[t][s] += 1;
                    any_progress = true;
                }
            }
        }
        if (any_progress) continue;
        var stuck = false;
        for (0..n) |t| {
            for (0..n) |s| {
                if (s != t and cursors[t][s] < groups[s].items.len) stuck = true;
            }
        }
        if (stuck) {
            std.debug.print("seed {d}: drain stuck\n", .{seed});
            return error.DeliveryStuck;
        }
        break;
    }

    var vis: [n]std.ArrayListUnmanaged(u16) = undefined;
    for (&vis) |*v| v.* = .empty;
    defer {
        for (&vis) |*v| v.deinit(std.testing.allocator);
    }
    for (&r, &vis) |*rogue, *vbuf| try rogue.render(null, null, vbuf);

    for (vis[1..], 1..) |b, i| {
        if (!std.mem.eql(u16, vis[0].items, b.items)) {
            std.debug.print("seed {d} r{d}: {d} vs {d}\n", .{ seed, i, vis[0].items.len, b.items.len });
            return error.TestExpectedEqual;
        }
    }
}

test "text-only fuzz: with undo sweep" {
    var seed: u64 = 1;
    while (seed <= 40) : (seed += 1) {
        try textOnlyFuzz(10, seed, 5000);
    }
}
