//! Byte-native WASM module for file sync.
//!
//! The HTML engine (`wasm.zig`) is `Rogue(u16)` and speaks `insert_v0`.
//! This module is `Rogue(u8)` and speaks `insert_bytes_v0` — one byte per
//! CRDT unit, raw output (no HTML/UTF-16 layer). It exposes only the surface
//! a Go host needs: init, insert, hide, replace, merge, render, vis_len.

const std = @import("std");
const rogue = @import("rogue.zig");
const Rogue = rogue.Rogue;
const NodeId = rogue.NodeId;
const WireOp = @import("op.zig").WireOp;
const MultiOp = @import("op.zig").MultiOp;
const serde = @import("serde");

// The CRDT logs through std.log; freestanding wasm has no stderr, so swallow it.
pub const std_options: std.Options = .{
    .logFn = noopLogFn,
};

fn noopLogFn(
    comptime level: std.log.Level,
    comptime scope: @TypeOf(.EnumLiteral),
    comptime format: []const u8,
    args: anytype,
) void {
    _ = level;
    _ = scope;
    _ = format;
    _ = args;
}

const Doc = Rogue(u8);
const WireOpU8 = WireOp(u8);

var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
var gpa = arena.allocator();

var doc: Doc = undefined;
var op_buf: std.ArrayListUnmanaged(WireOpU8) = .empty;
var batch_mode: bool = false;

// Static buffers for host <-> WASM data exchange. Bytes, no alignment needed.
// in_buf  – file bytes to insert / serialized multi_op bytes to merge.
// out_buf – serialized multi_op bytes or rendered file bytes.
var in_buf: [8 * 1024 * 1024]u8 = undefined;
var out_buf: [16 * 1024 * 1024]u8 = undefined;
var out_len: u32 = 0;

fn writeError(msg: []const u8) void {
    const n = @min(msg.len, out_buf.len);
    @memcpy(out_buf[0..n], msg[0..n]);
    out_len = @intCast(n);
}

export fn rogue_u8_in_ptr() [*]u8 {
    return &in_buf;
}
export fn rogue_u8_out_ptr() [*]u8 {
    return &out_buf;
}
export fn rogue_u8_out_len() u32 {
    return out_len;
}
export fn rogue_u8_in_cap() u32 {
    return in_buf.len;
}
export fn rogue_u8_out_cap() u32 {
    return out_buf.len;
}

export fn rogue_u8_init(replica_id: u16, capacity: u32) i32 {
    arena.deinit();
    arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    gpa = arena.allocator();
    doc = Doc.init(gpa, replica_id, capacity) catch {
        writeError("out of memory");
        return 0;
    };
    op_buf = .empty;
    batch_mode = false;
    out_len = 0;
    return 1;
}

export fn rogue_u8_deinit() void {
    arena.deinit();
    arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    gpa = arena.allocator();
    out_len = 0;
}

export fn rogue_u8_begin_batch() void {
    batch_mode = true;
    op_buf.clearRetainingCapacity();
}

export fn rogue_u8_commit_batch() i32 {
    batch_mode = false;
    if (op_buf.items.len == 0) return 0;
    return finishOps();
}

/// Insert `in_len` bytes at visible index `vis_ix` (bytes are read from
/// `in_buf[buf_offset..]`). In non-batch mode the op is merged and the
/// serialized multi_op is left in out_buf.
export fn rogue_u8_insert(vis_ix: u32, buf_offset: u32, in_len: u32) i32 {
    const offset: usize = @intCast(buf_offset);
    const len: usize = @intCast(in_len);
    if (offset > in_buf.len or len > in_buf.len - offset) {
        writeError("input overflow");
        return 0;
    }
    if (len == 0) {
        out_len = 0;
        return 1;
    }
    const bytes = in_buf[offset .. offset + len];
    doc.insert(vis_ix, bytes, &op_buf) catch |err| {
        writeError(@errorName(err));
        return 0;
    };
    if (batch_mode) {
        out_len = 0;
        return 1;
    }
    return finishOps();
}

export fn rogue_u8_hide(vis_ix: u32, len: u32) i32 {
    if (len == 0) {
        out_len = 0;
        return 1;
    }
    doc.hide(vis_ix, len, &op_buf) catch |err| {
        writeError(@errorName(err));
        return 0;
    };
    if (batch_mode) {
        out_len = 0;
        return 1;
    }
    return finishOps();
}

/// Atomically replace `del_len` visible bytes at `vis_ix` with `in_len` bytes
/// from `in_buf[buf_offset..]`. Emits one multi_op (or none if both are empty).
/// In batch mode it appends to the current batch; CommitBatch emits the result.
export fn rogue_u8_replace(vis_ix: u32, del_len: u32, buf_offset: u32, in_len: u32) i32 {
    const offset: usize = @intCast(buf_offset);
    const len: usize = @intCast(in_len);
    if (offset > in_buf.len or len > in_buf.len - offset) {
        writeError("input overflow");
        return 0;
    }
    if (!batch_mode) op_buf.clearRetainingCapacity();
    if (del_len > 0) {
        doc.hide(vis_ix, del_len, &op_buf) catch |err| {
            writeError(@errorName(err));
            return 0;
        };
    }
    if (len > 0) {
        const bytes = in_buf[offset .. offset + len];
        doc.insert(vis_ix, bytes, &op_buf) catch |err| {
            writeError(@errorName(err));
            return 0;
        };
    }
    if (op_buf.items.len == 0) return 0;
    if (batch_mode) {
        out_len = 0;
        return 1;
    }
    return finishOps();
}

/// Apply a serialized multi_op (multi_op_v0 container, insert_bytes_v0 inner
/// ops). Returns 1 applied, 0 parkable (missing dependency), -1 permanent.
export fn rogue_u8_merge(in_len: u32) i32 {
    const len: usize = @intCast(in_len);
    if (len > in_buf.len) {
        writeError("input overflow");
        return -1;
    }
    const parsed = parsePayload(in_buf[0..len]) catch |err| {
        writeError(@errorName(err));
        return -1;
    };
    const multi = MultiOp(u8){ .group_id = parsed.group_id, .ops = parsed.ops };
    doc.merge(multi) catch |err| {
        if (err == error.UnknownParent or err == error.UnknownTarget) return 0;
        writeError(@errorName(err));
        return -1;
    };
    return 1;
}

/// Render the visible document as raw bytes into out_buf.
export fn rogue_u8_render() i32 {
    var bytes: std.ArrayListUnmanaged(u8) = .empty;
    defer bytes.deinit(gpa);
    doc.render(null, null, &bytes) catch |err| {
        writeError(@errorName(err));
        return 0;
    };
    if (bytes.items.len > out_buf.len) {
        writeError("render overflow");
        return 0;
    }
    @memcpy(out_buf[0..bytes.items.len], bytes.items);
    out_len = @intCast(bytes.items.len);
    return 1;
}

export fn rogue_u8_vis_len() u32 {
    return doc.visLen();
}

fn finishOps() i32 {
    if (op_buf.items.len == 0) {
        out_len = 0;
        return 0;
    }
    const multi = doc.multiOp(op_buf.items);
    doc.merge(multi) catch |err| {
        writeError(@errorName(err));
        return -1;
    };
    const out = serializeMultiOp(multi, &out_buf);
    if (out.len == 0) {
        writeError("serialize overflow");
        return 0;
    }
    out_len = @intCast(out.len);
    op_buf.clearRetainingCapacity();
    return 1;
}

inline fn toCrdtNodeId(s: serde.node_id_v0.NodeId) NodeId {
    return .{ .replica_id = s.replica_id, .sequence = s.sequence };
}

inline fn fromCrdtNodeId(c: NodeId) serde.node_id_v0.NodeId {
    return .{ .replica_id = c.replica_id, .sequence = c.sequence };
}

fn parsePayload(bytes: []const u8) !struct { group_id: NodeId, ops: []WireOpU8 } {
    const decoded = try serde.multi_op_v0.decode(gpa, bytes);
    const group_id = toCrdtNodeId(decoded.group_id);

    const wire_ops = try gpa.alloc(WireOpU8, decoded.ops.len);
    for (decoded.ops, 0..) |op, i| {
        switch (op.disc) {
            serde.insert_bytes_v0.DISC => {
                const ins = try serde.insert_bytes_v0.decode(gpa, op.payload);
                wire_ops[i] = .{ .insert = .{
                    .id = toCrdtNodeId(ins.id),
                    .parent = toCrdtNodeId(ins.parent),
                    .side = @enumFromInt(@intFromEnum(ins.side)),
                    .chars = ins.bytes,
                } };
            },
            serde.hide_v0.DISC => {
                const h = try serde.hide_v0.decode(op.payload);
                wire_ops[i] = .{ .hide = .{
                    .id = toCrdtNodeId(h.id),
                    .target = toCrdtNodeId(h.target),
                    .len = h.len,
                } };
            },
            serde.show_v0.DISC => {
                const s = try serde.show_v0.decode(op.payload);
                wire_ops[i] = .{ .show = .{
                    .id = toCrdtNodeId(s.id),
                    .target = toCrdtNodeId(s.target),
                    .len = s.len,
                } };
            },
            else => return error.UnknownInnerDisc,
        }
    }
    return .{ .group_id = group_id, .ops = wire_ops };
}

fn serializeMultiOp(multi: MultiOp(u8), buf: []u8) []u8 {
    var inner: std.ArrayListUnmanaged(serde.multi_op_v0.InnerOp) = .empty;
    inner.ensureTotalCapacity(gpa, multi.ops.len) catch return buf[0..0];

    for (multi.ops) |op| {
        switch (op) {
            .insert => |ins| {
                const size = serde.insert_bytes_v0.encodedSize(ins.chars.len);
                const out = gpa.alloc(u8, size) catch return buf[0..0];
                _ = serde.insert_bytes_v0.encode(
                    fromCrdtNodeId(ins.id),
                    fromCrdtNodeId(ins.parent),
                    @enumFromInt(@intFromEnum(ins.side)),
                    ins.chars,
                    out,
                );
                inner.append(gpa, .{ .disc = serde.insert_bytes_v0.DISC, .payload = out }) catch return buf[0..0];
            },
            .hide => |h| {
                const out = gpa.alloc(u8, serde.hide_v0.SIZE) catch return buf[0..0];
                serde.hide_v0.encode(.{
                    .id = fromCrdtNodeId(h.id),
                    .target = fromCrdtNodeId(h.target),
                    .len = h.len,
                }, out);
                inner.append(gpa, .{ .disc = serde.hide_v0.DISC, .payload = out }) catch return buf[0..0];
            },
            .show => |s| {
                const out = gpa.alloc(u8, serde.show_v0.SIZE) catch return buf[0..0];
                serde.show_v0.encode(.{
                    .id = fromCrdtNodeId(s.id),
                    .target = fromCrdtNodeId(s.target),
                    .len = s.len,
                }, out);
                inner.append(gpa, .{ .disc = serde.show_v0.DISC, .payload = out }) catch return buf[0..0];
            },
        }
    }

    const total = serde.multi_op_v0.encodedSize(inner.items, null);
    if (total > buf.len) return buf[0..0];
    const n = serde.multi_op_v0.encode(fromCrdtNodeId(multi.group_id), inner.items, null, buf);
    return buf[0..n];
}
