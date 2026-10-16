const std = @import("std");
const Rogue = @import("rogue.zig").Rogue;
const NodeId = @import("rogue.zig").NodeId;
const Side = @import("rogue.zig").Side;
const WireOp = @import("op.zig").WireOp;
const ContentAddress = @import("content_address.zig").ContentAddress;
const ErrorKind = @import("error_kind.zig").ErrorKind;

// Wire format codecs — single source of truth for serde across Zig/JS/Go.
// See serde/discriminators.md for the byte layout. The on-wire format
// crossing this WASM<->JS boundary (in_buf, out_buf) is multi_op_v0 binary.
const serde = @import("serde");

extern fn jsLog(ptr: [*]const u8, len: usize) void;

pub const std_options: std.Options = .{
    .logFn = wasmLogFn,
};

fn wasmLogFn(
    comptime level: std.log.Level,
    comptime scope: @TypeOf(.EnumLiteral),
    comptime format: []const u8,
    args: anytype,
) void {
    _ = level;
    _ = scope;
    if (!debug_logging) return;
    var buf: [1024]u8 = undefined;
    const msg = std.fmt.bufPrint(&buf, format, args) catch buf[0..];
    jsLog(msg.ptr, msg.len);
}

const Doc = Rogue(u16);
const WireOpU16 = WireOp(u16);

var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
var gpa = arena.allocator();

var doc: Doc = undefined;
var op_buf: std.ArrayListUnmanaged(WireOpU16) = .empty;
var cursor: ContentAddress = .init();
var cursor_stale: bool = true;
var batch_mode: bool = false;
// Runtime gate for all WASM-side console logging (undo cursor, getOp, ...).
// Toggled from JS via rogue_set_debug_logging, wired to the same ?debug=sync
// flag as the JS-side sync logs.
var debug_logging: bool = false;

// Static buffers for JS <-> WASM data exchange.
// Both are align(2) so they can be reinterpreted as []u16 for UTF-16LE I/O.
// in_buf  – holds DMP diff text (UTF-16LE) for inserts; 8 MB covers multi-MB pastes.
// out_buf – holds rendered HTML (UTF-16LE); 16 MB covers multi-MB documents.
var in_buf: [8 * 1024 * 1024]u8 align(@alignOf(u16)) = undefined;
var out_buf: [16 * 1024 * 1024]u8 align(@alignOf(u16)) = undefined;
var out_len: u32 = 0;
// Length of the content-address JSON that rogue_undo writes back into in_buf
// (the decremented frontier is returned in place, where the input CA was).
var ca_out_len: u32 = 0;

export fn rogue_in_ptr() [*]u8 {
    return &in_buf;
}
export fn rogue_out_ptr() [*]u8 {
    return &out_buf;
}
export fn rogue_out_len() u32 {
    return out_len;
}
export fn rogue_ca_len() u32 {
    return ca_out_len;
}

/// The merge error set. Declared explicitly so `mergeErrorKind` is provably
/// exhaustive and a future merge error is a compile error, not a silent `else`.
const MergeError = error{
    OutOfMemory,
    InvalidGroup,
    UnknownParent,
    UnknownTarget,
};

fn mergeErrorKind(err: MergeError) ErrorKind {
    return switch (err) {
        error.OutOfMemory => .out_of_memory,
        error.InvalidGroup => .invalid_group,
        error.UnknownParent => .unknown_parent,
        error.UnknownTarget => .unknown_target,
    };
}

/// The local stamp (insert/hide) error set — likewise exhaustive.
const StampError = error{
    OutOfBounds,
    OutOfMemory,
};

fn stampErrorKind(err: StampError) ErrorKind {
    return switch (err) {
        error.OutOfBounds => .out_of_bounds,
        error.OutOfMemory => .out_of_memory,
    };
}

/// Write a structured error payload `{"type":N,"name":"...","desc":"..."}` into
/// out_buf (out_len = byte length) for the JS side to JSON.parse after a failed
/// call. `desc` is optional human detail (e.g. byte counts).
fn writeErrorPayload(kind: ErrorKind, desc: ?[]const u8) void {
    var buf: [256]u8 = undefined;
    const s = if (desc) |d|
        std.fmt.bufPrint(&buf, "{{\"type\":{d},\"name\":\"{s}\",\"desc\":\"{s}\"}}", .{ @intFromEnum(kind), @tagName(kind), d }) catch return
    else
        std.fmt.bufPrint(&buf, "{{\"type\":{d},\"name\":\"{s}\"}}", .{ @intFromEnum(kind), @tagName(kind) }) catch return;
    if (s.len > out_buf.len) return;
    @memcpy(out_buf[0..s.len], s);
    out_len = @intCast(s.len);
}

export fn rogue_init(replica_id: u16, capacity: u32) i32 {
    arena.deinit();
    arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    gpa = arena.allocator();
    doc = Doc.init(gpa, replica_id, capacity) catch {
        writeErrorPayload(.out_of_memory, null);
        return 0;
    };
    op_buf = .empty;
    cursor = .init();
    cursor_stale = true;
    batch_mode = false;
    return 1;
}

export fn rogue_deinit() void {
    arena.deinit();
    arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    gpa = arena.allocator();
}

/// Pre-grow the doc's SoA storage to `nodes` so a sync stream loads at its
/// target size in one shot. Returns 1 on success (or already big enough), 0 if
/// the requested size exceeds the hard ceiling.
export fn rogue_reserve(nodes: u32) i32 {
    doc.reserve(nodes) catch return 0;
    return 1;
}

/// Toggle WASM-side console logging (undo cursor, getOp, etc.). Wired to the
/// same ?debug=sync flag as the JS-side sync logs.
export fn rogue_set_debug_logging(on: i32) void {
    debug_logging = on != 0;
}

/// Register (and switch to) an author identity for subsequent local ops, so one
/// replica can stamp ops under several replica ids — a shared server-side
/// replica multiplexing many agent connections. Returns 1 on success, 0 on OOM.
export fn rogue_set_author(author: u16) i32 {
    doc.setAuthor(author) catch return 0;
    return 1;
}

export fn rogue_begin_batch() void {
    batch_mode = true;
    op_buf.clearRetainingCapacity();
}

export fn rogue_commit_batch() i32 {
    batch_mode = false;
    if (op_buf.items.len == 0) return 0;
    const multi = doc.multiOp(op_buf.items);
    // -1 = merge failed. The structured error payload in out_buf (type = the
    // ErrorKind int) lets the JS side distinguish out_of_memory (revert + report
    // onDocTooLarge) from anything else (onError).
    doc.merge(multi) catch |err| {
        writeErrorPayload(mergeErrorKind(err), null);
        return -1;
    };
    out_len = @intCast(serializeMultiOp(multi, &out_buf).len);
    op_buf.clearRetainingCapacity();
    cursor_stale = true;
    return 1;
}

/// JS writes UTF-16LE chars into in_buf at buf_offset (in_len = byte count), calls this,
/// reads JSON op result from out_buf as UTF-8. Returns 1 on success, 0 on error.
/// In batch mode callers must pack inserts at successive offsets so slices don't overlap.
export fn rogue_insert(vis_ix: u32, buf_offset: u32, in_len: u32) i32 {
    const ptr: [*]align(2) u16 = @ptrCast(@alignCast(&in_buf[buf_offset]));
    const chars = ptr[0 .. in_len / 2];
    doc.insert(vis_ix, chars, &op_buf) catch |err| {
        writeErrorPayload(stampErrorKind(err), null);
        return 0;
    };
    if (batch_mode) return 1;
    const multi = doc.multiOp(op_buf.items);
    doc.merge(multi) catch |err| {
        writeErrorPayload(mergeErrorKind(err), null);
        return 0;
    };
    out_len = @intCast(serializeMultiOp(multi, &out_buf).len);
    op_buf.clearRetainingCapacity();
    cursor_stale = true;
    return 1;
}

export fn rogue_hide(vis_ix: u32, len: u32) i32 {
    doc.hide(vis_ix, len, &op_buf) catch |err| {
        writeErrorPayload(stampErrorKind(err), null);
        return 0;
    };
    if (batch_mode) return 1;
    const multi = doc.multiOp(op_buf.items);
    doc.merge(multi) catch |err| {
        writeErrorPayload(mergeErrorKind(err), null);
        return 0;
    };
    out_len = @intCast(serializeMultiOp(multi, &out_buf).len);
    op_buf.clearRetainingCapacity();
    cursor_stale = true;
    return 1;
}

/// Compute the inverse ops for the next undo step and serialize them as
/// multi_op_v0 binary into out_buf. Does NOT apply — caller follows up with
/// `rogue_merge` (or JS-side `applyOpPartial`) so partial-rerender bounds
/// can be computed on the pre-merge CRDT state.
///
/// Cursor handling:
///   - in_len == 0  → use the internal cursor (refreshed from doc.head if stale).
///   - in_len  > 0  → parse `in_buf[0..in_len]` as a ContentAddress (array of
///                    `[replica_id, max_seq]` pairs, JSON) and use that. Lets
///                    callers do per-author undo by filtering the cursor.
///
/// Returns 1 on success, 0 if nothing more to undo or on parse error.
export fn rogue_undo(in_len: u32) i32 {
    var external: ContentAddress = undefined;
    var owns_external = false;
    defer if (owns_external) external.deinit(gpa);

    const active: *ContentAddress = blk: {
        if (in_len > 0) {
            external = parseContentAddress(in_buf[0..in_len]) catch return 0;
            owns_external = true;
            break :blk &external;
        }
        if (cursor_stale) {
            cursor.deinit(gpa);
            cursor = doc.head.clone(gpa) catch return 0;
            cursor_stale = false;
        }
        break :blk &cursor;
    };

    logContentAddress("undo cursor", active);
    logContentAddress("doc head  ", &doc.head);
    std.log.debug("vis_len={d}", .{doc.visLen()});

    doc.undo(active, &op_buf) catch return 0;
    if (op_buf.items.len == 0) return 0;

    const multi = doc.multiOp(op_buf.items);
    out_len = @intCast(serializeMultiOp(multi, &out_buf).len);
    op_buf.clearRetainingCapacity();

    // Serialize the decremented cursor back into in_buf (in place, where the
    // input CA was) so the caller can pass it back for the next undo step.
    const ca = writeContentAddress(active, &in_buf) catch return 0;
    ca_out_len = @intCast(ca.len);
    return 1;
}

/// Forward counterpart of rogue_undo: parse a content address from in_buf,
/// walk the oplog forward past it, invert the next group, and serialize the
/// inverse payload + the advanced address. in_len must be > 0 (the JS owns the
/// address). Returns 1 on success, 0 if there's nothing past the cursor.
export fn rogue_redo(in_len: u32) i32 {
    if (in_len == 0) return 0;
    var external = parseContentAddress(in_buf[0..in_len]) catch return 0;
    defer external.deinit(gpa);

    logContentAddress("redo cursor", &external);
    logContentAddress("doc head  ", &doc.head);

    doc.redo(&external, &op_buf) catch return 0;
    if (op_buf.items.len == 0) return 0;

    const multi = doc.multiOp(op_buf.items);
    out_len = @intCast(serializeMultiOp(multi, &out_buf).len);
    op_buf.clearRetainingCapacity();

    // Serialize the advanced cursor back into in_buf (in place).
    const ca = writeContentAddress(&external, &in_buf) catch return 0;
    ca_out_len = @intCast(ca.len);
    return 1;
}

/// Serialize a ContentAddress as a JSON array of `[replica_id, seq]` pairs.
fn writeContentAddress(ca: *const ContentAddress, buf: []u8) ![]u8 {
    // ContentAddress is tiny in practice (one entry per active replica).
    var pairs: [256][2]u32 = undefined;
    var n: usize = 0;
    var it = ca.map.iterator();
    while (it.next()) |entry| : (n += 1) {
        if (n >= pairs.len) return error.TooManyReplicas;
        pairs[n] = .{ entry.key_ptr.*, entry.value_ptr.* };
    }
    var w: std.Io.Writer = .fixed(buf);
    try std.json.Stringify.value(pairs[0..n], .{}, &w);
    try w.flush();
    return buf[0..w.end];
}

/// Parse a JSON array of `[replica_id, seq]` pairs into a ContentAddress.
/// Caller owns the returned value (must deinit with the global gpa).
fn parseContentAddress(bytes: []const u8) !ContentAddress {
    const parsed = try std.json.parseFromSlice(std.json.Value, gpa, bytes, .{});
    defer parsed.deinit();
    var ca = ContentAddress.init();
    for (parsed.value.array.items) |pair| {
        const pa = pair.array.items;
        try ca.set(gpa, @intCast(pa[0].integer), @intCast(pa[1].integer));
    }
    return ca;
}

/// JS writes serialized MultiOp binary (multi_op_v0) into in_buf, calls this to apply it.
/// Return codes:
///   1  = applied
///   0  = parkable — a dependency (insert parent / hide/show target) hasn't
///        arrived yet; the caller parks and retries it later.
///  -1  = permanent — the payload is malformed, its group_id is inconsistent,
///        or the doc is at capacity; it can never apply, so the caller drops it.
export fn rogue_merge(in_len: u32) i32 {
    const p = parsePayload(in_buf[0..in_len]) catch {
        writeErrorPayload(.parse_error, null);
        return -1;
    };
    const multi = @import("op.zig").MultiOp(u16){ .group_id = p.group_id, .ops = p.ops };
    doc.merge(multi) catch |err| {
        // Only these two mean "dependency not here yet" — parkable, not an error.
        if (err == error.UnknownParent or err == error.UnknownTarget) return 0;
        // Everything else (InvalidGroup, OutOfMemory) is permanent — write the
        // structured payload so the JS side can surface it.
        writeErrorPayload(mergeErrorKind(err), null);
        return -1;
    };
    return 1;
}

/// Destructively un-apply the last `count` applied groups IN PLACE (no rebuild).
/// Returns the number of groups removed.
export fn rogue_revert_tail(count: u32) i32 {
    const removed = doc.revertTail(count);
    cursor_stale = true;
    return @intCast(removed);
}

/// JS writes serialized MultiOp binary into in_buf. Returns the (min_vis_ix, max_vis_ix)
/// the payload's content will occupy — the two visible neighbors bracketing each op,
/// valid both before applying (predicted landing spot) and after (the op's own chars).
/// Returns 1 on success, 0 on any error (caller falls back to full rerender).
export fn rogue_op_bounds(in_len: u32) i32 {
    const p = parsePayload(in_buf[0..in_len]) catch return 0;
    const bounds = doc.visIxBounds(p.ops) catch return 0;
    var fbs = std.io.fixedBufferStream(&out_buf);
    fbs.writer().print("{d},{d}", .{ bounds[0], bounds[1] }) catch return 0;
    out_len = @intCast(fbs.pos);
    return 1;
}

inline fn toCrdtNodeId(s: serde.node_id_v0.NodeId) NodeId {
    return .{ .replica_id = s.replica_id, .sequence = s.sequence };
}

inline fn fromCrdtNodeId(c: NodeId) serde.node_id_v0.NodeId {
    return .{ .replica_id = c.replica_id, .sequence = c.sequence };
}

/// Decode multi_op_v0 binary wire bytes into a {group_id, ops} pair the CRDT
/// can merge. Allocates the inner-op structs and (for inserts) the chars
/// slices on the global arena; not reclaimed (consistent with existing
/// pattern — the arena's never reset).
fn parsePayload(bytes: []const u8) !struct { group_id: NodeId, ops: []WireOpU16 } {
    const decoded = try serde.multi_op_v0.decode(gpa, bytes);
    const group_id = toCrdtNodeId(decoded.group_id);

    const wire_ops = try gpa.alloc(WireOpU16, decoded.ops.len);
    for (decoded.ops, 0..) |op, i| {
        switch (op.disc) {
            serde.insert_v0.DISC => {
                const ins = try serde.insert_v0.decode(gpa, op.payload);
                wire_ops[i] = .{ .insert = .{
                    .id = toCrdtNodeId(ins.id),
                    .parent = toCrdtNodeId(ins.parent),
                    .side = @enumFromInt(@intFromEnum(ins.side)),
                    .chars = ins.chars,
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

// --- Cursor / presence helpers ---

fn parseNodeId(in_len: u32) !NodeId {
    const s = in_buf[0..in_len];
    const colon = std.mem.indexOfScalar(u8, s, ':') orelse return error.InvalidFormat;
    const r = try std.fmt.parseInt(u16, s[0..colon], 10);
    const seq = try std.fmt.parseInt(u32, s[colon + 1 ..], 10);
    return NodeId{ .replica_id = r, .sequence = seq };
}

fn writeNodeId(id: NodeId) void {
    var fbs = std.io.fixedBufferStream(&out_buf);
    fbs.writer().print("{d}:{d}", .{ id.replica_id, id.sequence }) catch {};
    out_len = @intCast(fbs.pos);
}

/// Writes the current undo cursor as a JSON object {"replica_id": max_seq, ...} to out_buf.
export fn rogue_debug_cursor() void {
    var fbs = std.io.fixedBufferStream(&out_buf);
    const w = fbs.writer();
    w.writeAll("{\"stale\":") catch return;
    w.writeAll(if (cursor_stale) "true" else "false") catch return;
    w.writeAll(",\"cursor\":{") catch return;
    var it = cursor.map.iterator();
    var first = true;
    while (it.next()) |entry| {
        if (!first) w.writeByte(',') catch return;
        first = false;
        w.print("\"{d}\":{d}", .{ entry.key_ptr.*, entry.value_ptr.* }) catch return;
    }
    w.writeAll("},\"doc_head\":{") catch return;
    var it2 = doc.head.map.iterator();
    first = true;
    while (it2.next()) |entry| {
        if (!first) w.writeByte(',') catch return;
        first = false;
        w.print("\"{d}\":{d}", .{ entry.key_ptr.*, entry.value_ptr.* }) catch return;
    }
    w.writeAll("}}") catch return;
    out_len = @intCast(fbs.pos);
}

/// Serialize the document's current head as a content address (JSON array of
/// `[replica_id, seq]` pairs) into out_buf. Used to seed the undo frontier.
export fn rogue_head() void {
    const n = writeContentAddress(&doc.head, &out_buf) catch return;
    out_len = @intCast(n.len);
}

/// Returns the number of visible characters in the document.
export fn rogue_vis_len() u32 {
    return doc.visLen();
}

/// Writes the NodeId of the visible character at vis_ix to out_buf as "r:s".
/// Returns 1 on success, 0 if vis_ix is out of bounds.
export fn rogue_id_at(vis_ix: u32) i32 {
    const id = doc.visId(vis_ix) orelse return 0;
    writeNodeId(id);
    return 1;
}

/// Reads a NodeId ("r:s") from in_buf. Returns its current visible index,
/// or -1 if the character is deleted or not found.
export fn rogue_vis_ix(in_len: u32) i32 {
    const id = parseNodeId(in_len) catch return -1;
    const ix = doc.visIx(id) orelse return -1;
    return @intCast(ix);
}

/// Reads a NodeId from in_buf. Writes the nearest visible character to the LEFT
/// to out_buf. Returns 1 if found, 0 if already at the start of the document.
export fn rogue_prev_vis(in_len: u32) i32 {
    const id = parseNodeId(in_len) catch return 0;
    const vc = doc.prevVis(id) orelse return 0;
    writeNodeId(vc.id);
    return 1;
}

/// Reads a NodeId from in_buf. Writes the nearest visible character to the RIGHT
/// to out_buf. Returns 1 if found, 0 if already at the end of the document.
export fn rogue_next_vis(in_len: u32) i32 {
    const id = parseNodeId(in_len) catch return 0;
    const vc = doc.nextVis(id) orelse return 0;
    writeNodeId(vc.id);
    return 1;
}

/// Renders document HTML as UTF-16LE into out_buf (out_len = byte count).
/// Returns 1 on success, 0 on failure (out_buf overflow or OOM — out_len is
/// reset to 0 so the caller never reads a stale buffer).
export fn rogue_render() i32 {
    return renderRange(null, null);
}

/// Renders a range of the document between two NodeIds (inclusive).
/// in_buf format: "start_r:start_s\nend_r:end_s" (newline-separated).
/// Returns 1 on success, 0 on failure.
export fn rogue_render_range(in_len: u32) i32 {
    const s = in_buf[0..in_len];
    const nl = std.mem.indexOfScalar(u8, s, '\n') orelse return 0;
    const start_id = parseNodeIdFromSlice(s[0..nl]) catch return 0;
    const end_id = parseNodeIdFromSlice(s[nl + 1 ..]) catch return 0;
    return renderRange(start_id, end_id);
}

/// Render the whole document at a historical content address.
/// in_buf = ContentAddress JSON (array of [replica_id, seq] pairs).
/// Returns 1 on success, 0 on failure.
export fn rogue_render_at(in_len: u32) i32 {
    var addr = parseContentAddress(in_buf[0..in_len]) catch {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    defer addr.deinit(gpa);
    return renderRangeAt(&addr, null, null);
}

/// Render a range at a historical content address.
/// in_buf = ContentAddress JSON + "\n" + "start_r:start_s\nend_r:end_s".
/// Returns 1 on success, 0 on failure.
export fn rogue_render_at_range(in_len: u32) i32 {
    const s = in_buf[0..in_len];
    const nl1 = std.mem.indexOfScalar(u8, s, '\n') orelse {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    var addr = parseContentAddress(s[0..nl1]) catch {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    defer addr.deinit(gpa);
    const rest = s[nl1 + 1 ..];
    const nl2 = std.mem.indexOfScalar(u8, rest, '\n') orelse {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    const start_id = parseNodeIdFromSlice(rest[0..nl2]) catch {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    const end_id = parseNodeIdFromSlice(rest[nl2 + 1 ..]) catch {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    return renderRangeAt(&addr, start_id, end_id);
}

/// Compute the content address (version vector) of a range.
/// in_buf = "start_r:start_s\nend_r:end_s". Writes the address as JSON to out_buf.
/// Returns 1 on success, 0 on failure.
export fn rogue_addr_of_range(in_len: u32) i32 {
    const s = in_buf[0..in_len];
    const nl = std.mem.indexOfScalar(u8, s, '\n') orelse {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    const start_id = parseNodeIdFromSlice(s[0..nl]) catch {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    const end_id = parseNodeIdFromSlice(s[nl + 1 ..]) catch {
        writeErrorPayload(.parse_error, null);
        return 0;
    };
    var addr = doc.addrOf(start_id, end_id) catch |err| {
        writeErrorPayload(switch (err) {
            error.OutOfMemory => .out_of_memory,
            error.UnknownId => .unknown_id,
            error.InvalidRange => .out_of_bounds,
        }, null);
        return 0;
    };
    defer addr.deinit(gpa);
    const ca = writeContentAddress(&addr, &out_buf) catch {
        writeErrorPayload(.out_of_memory, null);
        return 0;
    };
    out_len = @intCast(ca.len);
    return 1;
}

fn parseNodeIdFromSlice(s: []const u8) !NodeId {
    const colon = std.mem.indexOfScalar(u8, s, ':') orelse return error.InvalidFormat;
    const r = try std.fmt.parseInt(u16, s[0..colon], 10);
    const seq = try std.fmt.parseInt(u32, s[colon + 1 ..], 10);
    return NodeId{ .replica_id = r, .sequence = seq };
}

/// Copy a rendered char buffer into out_buf as UTF-16LE. Returns 1 on success,
/// 0 on out_buf overflow.
fn finishRender(char_buf: std.ArrayListUnmanaged(u16)) i32 {
    const bytes = std.mem.sliceAsBytes(char_buf.items);
    if (bytes.len > out_buf.len) {
        std.log.debug("render: output {d} bytes exceeds out_buf {d} bytes", .{ bytes.len, out_buf.len });
        var desc_buf: [64]u8 = undefined;
        const desc = std.fmt.bufPrint(&desc_buf, "output {d} bytes exceeds {d}", .{ bytes.len, out_buf.len }) catch null;
        writeErrorPayload(.render_overflow, desc);
        return 0;
    }
    @memcpy(out_buf[0..bytes.len], bytes);
    out_len = @intCast(bytes.len);
    return 1;
}

fn renderRange(start_id: ?NodeId, end_id: ?NodeId) i32 {
    var char_buf: std.ArrayListUnmanaged(u16) = .empty;
    defer char_buf.deinit(gpa);
    doc.render(start_id, end_id, &char_buf) catch |err| {
        // UnknownId means a scoped-render fencepost no longer exists (a stale
        // region) — a recoverable edge, not an error. Distinguish it from a
        // genuine allocation failure so the JS side can fall back gracefully.
        writeErrorPayload(switch (err) {
            error.OutOfMemory => .out_of_memory,
            error.UnknownId => .unknown_id,
        }, null);
        return 0;
    };
    return finishRender(char_buf);
}

fn renderRangeAt(addr: *ContentAddress, start_id: ?NodeId, end_id: ?NodeId) i32 {
    var char_buf: std.ArrayListUnmanaged(u16) = .empty;
    defer char_buf.deinit(gpa);
    doc.renderAt(addr, start_id, end_id, &char_buf) catch |err| {
        writeErrorPayload(switch (err) {
            error.OutOfMemory => .out_of_memory,
            error.UnknownId => .unknown_id,
            error.InvalidRange => .out_of_bounds,
        }, null);
        return 0;
    };
    return finishRender(char_buf);
}

fn logContentAddress(label: []const u8, ca: *const ContentAddress) void {
    if (!debug_logging) return;
    var buf: [512]u8 = undefined;
    var fbs = std.io.fixedBufferStream(&buf);
    const w = fbs.writer();
    w.print("{s}: {{", .{label}) catch return;
    var it = ca.map.iterator();
    var first = true;
    while (it.next()) |entry| {
        if (!first) w.writeAll(", ") catch return;
        first = false;
        w.print("{d}:{d}", .{ entry.key_ptr.*, entry.value_ptr.* }) catch return;
    }
    w.writeByte('}') catch return;
    jsLog(buf[0..fbs.pos].ptr, fbs.pos);
}

/// Encode a CRDT MultiOp(u16) as multi_op_v0 binary into `buf`. Uses the
/// global arena to materialize each inner-op payload as a byte slice that
/// multi_op_v0.encode then frames into the output buffer. Returns the
/// written slice; empty slice on overflow.
fn serializeMultiOp(multi: @import("op.zig").MultiOp(u16), buf: []u8) []u8 {
    var inner: std.ArrayListUnmanaged(serde.multi_op_v0.InnerOp) = .empty;
    inner.ensureTotalCapacity(gpa, multi.ops.len) catch return buf[0..0];

    for (multi.ops) |op| {
        switch (op) {
            .insert => |ins| {
                const size = serde.insert_v0.encodedSize(ins.chars.len);
                const out = gpa.alloc(u8, size) catch return buf[0..0];
                _ = serde.insert_v0.encode(
                    fromCrdtNodeId(ins.id),
                    fromCrdtNodeId(ins.parent),
                    @enumFromInt(@intFromEnum(ins.side)),
                    ins.chars,
                    out,
                );
                inner.append(gpa, .{ .disc = serde.insert_v0.DISC, .payload = out }) catch return buf[0..0];
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
