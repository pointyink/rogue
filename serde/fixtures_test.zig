//! Fixture-driven conformance tests for the Zig serde codecs. Mirrors the
//! Go and JS runners: for every positive fixture, decode(bytes.bin) must
//! field-match value.json AND encode(value.json) must produce bytes.bin
//! verbatim. For every negative fixture, decode(bytes.bin) must fail.
//!
//! Run:  zig test serde/fixtures_test.zig   (from the repo root)

const std = @import("std");
const node_id_v0 = @import("node_id_v0.zig");
const multi_op_v0 = @import("multi_op_v0.zig");
const insert_v0 = @import("insert_v0.zig");
const insert_bytes_v0 = @import("insert_bytes_v0.zig");
const hide_v0 = @import("hide_v0.zig");
const show_v0 = @import("show_v0.zig");
const ack_v0 = @import("ack_v0.zig");
const json_envelope_v0 = @import("json_envelope_v0.zig");

const FixtureError = error{
    FixtureMismatch,
    MissingExpectedError,
    WrongErrorKind,
};

// ---- helpers ----

fn readFileAlloc(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) ![]u8 {
    const f = try dir.openFile(name, .{});
    defer f.close();
    return try f.readToEndAlloc(allocator, 16 * 1024 * 1024);
}

fn jsonGet(obj: std.json.Value, key: []const u8) std.json.Value {
    return obj.object.get(key).?;
}

fn hexDecode(allocator: std.mem.Allocator, hex: []const u8) ![]u8 {
    const out = try allocator.alloc(u8, hex.len / 2);
    _ = try std.fmt.hexToBytes(out, hex);
    return out;
}

fn bytesEqualReport(name: []const u8, got: []const u8, want: []const u8) !void {
    if (std.mem.eql(u8, got, want)) return;
    std.debug.print("\n{s} byte mismatch:\n  got:  {x}\n  want: {x}\n", .{ name, got, want });
    return FixtureError.FixtureMismatch;
}

// ---- positive: node_id_v0 ----

fn checkNodeIdV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const value_raw = try readFileAlloc(allocator, case_dir, "value.json");
    defer allocator.free(value_raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, value_raw, .{});
    defer parsed.deinit();
    const v = parsed.value;
    const want_replica: u16 = @intCast(jsonGet(v, "replica_id").integer);
    const want_seq: u32 = @intCast(jsonGet(v, "sequence").integer);

    // decode → field match
    const got = node_id_v0.decode(bytes, 0);
    if (got.replica_id != want_replica or got.sequence != want_seq) {
        std.debug.print(
            "\nnode_id_v0/{s} decode mismatch: got ({d},{d}), want ({d},{d})\n",
            .{ name, got.replica_id, got.sequence, want_replica, want_seq },
        );
        return FixtureError.FixtureMismatch;
    }

    // encode → bytes match
    var enc: [node_id_v0.SIZE]u8 = undefined;
    node_id_v0.encode(.{ .replica_id = want_replica, .sequence = want_seq }, enc[0..], 0);
    try bytesEqualReport(name, enc[0..], bytes);
}

// ---- positive: insert_v0 ----

fn checkInsertV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const value_raw = try readFileAlloc(allocator, case_dir, "value.json");
    defer allocator.free(value_raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, value_raw, .{});
    defer parsed.deinit();
    const v = parsed.value;
    const id_v = jsonGet(v, "id");
    const parent_v = jsonGet(v, "parent");
    const want_id_replica: u16 = @intCast(jsonGet(id_v, "replica_id").integer);
    const want_id_seq: u32 = @intCast(jsonGet(id_v, "sequence").integer);
    const want_parent_replica: u16 = @intCast(jsonGet(parent_v, "replica_id").integer);
    const want_parent_seq: u32 = @intCast(jsonGet(parent_v, "sequence").integer);
    const want_side_str = jsonGet(v, "side").string;
    const want_chars_hex = jsonGet(v, "chars_hex").string;

    // decode → field match
    const decoded = try insert_v0.decode(allocator, bytes);
    defer allocator.free(decoded.chars);

    if (decoded.id.replica_id != want_id_replica or decoded.id.sequence != want_id_seq) {
        std.debug.print("\ninsert_v0/{s} id mismatch\n", .{name});
        return FixtureError.FixtureMismatch;
    }
    if (decoded.parent.replica_id != want_parent_replica or decoded.parent.sequence != want_parent_seq) {
        std.debug.print("\ninsert_v0/{s} parent mismatch\n", .{name});
        return FixtureError.FixtureMismatch;
    }
    const got_side_str = sideToString(decoded.side);
    if (!std.mem.eql(u8, got_side_str, want_side_str)) {
        std.debug.print("\ninsert_v0/{s} side: got '{s}', want '{s}'\n", .{ name, got_side_str, want_side_str });
        return FixtureError.FixtureMismatch;
    }
    // Compare chars by converting got.chars to LE bytes and matching against the hex.
    const want_char_bytes = try hexDecode(allocator, want_chars_hex);
    defer allocator.free(want_char_bytes);
    const got_char_bytes = try allocator.alloc(u8, 2 * decoded.chars.len);
    defer allocator.free(got_char_bytes);
    for (decoded.chars, 0..) |c, i| {
        got_char_bytes[2 * i] = @truncate(c);
        got_char_bytes[2 * i + 1] = @truncate(c >> 8);
    }
    try bytesEqualReport(name, got_char_bytes, want_char_bytes);

    // encode → bytes match. Reconstruct chars from the hex.
    const chars = try allocator.alloc(u16, want_char_bytes.len / 2);
    defer allocator.free(chars);
    for (chars, 0..) |*slot, i| {
        slot.* = @as(u16, want_char_bytes[2 * i]) | (@as(u16, want_char_bytes[2 * i + 1]) << 8);
    }
    const side = try sideFromString(want_side_str);
    const enc = try allocator.alloc(u8, insert_v0.encodedSize(chars.len));
    defer allocator.free(enc);
    _ = insert_v0.encode(
        .{ .replica_id = want_id_replica, .sequence = want_id_seq },
        .{ .replica_id = want_parent_replica, .sequence = want_parent_seq },
        side,
        chars,
        enc,
    );
    try bytesEqualReport(name, enc, bytes);
}

fn sideToString(s: insert_v0.Side) []const u8 {
    return switch (s) {
        .Left => "left",
        .Right => "right",
        .Root => "root",
    };
}

fn sideFromString(s: []const u8) !insert_v0.Side {
    if (std.mem.eql(u8, s, "left")) return .Left;
    if (std.mem.eql(u8, s, "right")) return .Right;
    if (std.mem.eql(u8, s, "root")) return .Root;
    return error.UnknownSide;
}

// ---- negative: insert_v0 ----

fn checkInsertV0Negative(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const kind_raw = try readFileAlloc(allocator, case_dir, "error.txt");
    defer allocator.free(kind_raw);
    const expected_kind_raw = std.mem.trim(u8, kind_raw, &std.ascii.whitespace);
    const expected_kind = if (std.mem.startsWith(u8, expected_kind_raw, "truncated_"))
        "truncated"
    else
        expected_kind_raw;

    const result = insert_v0.decode(allocator, bytes);
    if (result) |decoded| {
        allocator.free(decoded.chars);
        std.debug.print("\ninsert_v0/{s}: expected error {s}, got success\n", .{ name, expected_kind });
        return FixtureError.MissingExpectedError;
    } else |err| {
        const got_kind = switch (err) {
            error.Truncated => "truncated",
            error.InvalidSide => "invalid_side",
            else => "unexpected",
        };
        if (!std.mem.eql(u8, got_kind, expected_kind)) {
            std.debug.print(
                "\ninsert_v0/{s}: got error kind '{s}' ({any}), want '{s}'\n",
                .{ name, got_kind, err, expected_kind },
            );
            return FixtureError.WrongErrorKind;
        }
    }
}

// ---- insert_bytes_v0 ----

fn checkInsertBytesV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const value_raw = try readFileAlloc(allocator, case_dir, "value.json");
    defer allocator.free(value_raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, value_raw, .{});
    defer parsed.deinit();
    const v = parsed.value;
    const id_v = jsonGet(v, "id");
    const parent_v = jsonGet(v, "parent");
    const want_id_replica: u16 = @intCast(jsonGet(id_v, "replica_id").integer);
    const want_id_seq: u32 = @intCast(jsonGet(id_v, "sequence").integer);
    const want_parent_replica: u16 = @intCast(jsonGet(parent_v, "replica_id").integer);
    const want_parent_seq: u32 = @intCast(jsonGet(parent_v, "sequence").integer);
    const want_side_str = jsonGet(v, "side").string;
    const want_bytes_hex = jsonGet(v, "bytes_hex").string;

    // decode → field match
    const decoded = try insert_bytes_v0.decode(allocator, bytes);
    defer allocator.free(decoded.bytes);

    if (decoded.id.replica_id != want_id_replica or decoded.id.sequence != want_id_seq) {
        std.debug.print("\ninsert_bytes_v0/{s} id mismatch\n", .{name});
        return FixtureError.FixtureMismatch;
    }
    if (decoded.parent.replica_id != want_parent_replica or decoded.parent.sequence != want_parent_seq) {
        std.debug.print("\ninsert_bytes_v0/{s} parent mismatch\n", .{name});
        return FixtureError.FixtureMismatch;
    }
    const got_side_str = sideToString(decoded.side);
    if (!std.mem.eql(u8, got_side_str, want_side_str)) {
        std.debug.print("\ninsert_bytes_v0/{s} side: got '{s}', want '{s}'\n", .{ name, got_side_str, want_side_str });
        return FixtureError.FixtureMismatch;
    }
    const want_bytes = try hexDecode(allocator, want_bytes_hex);
    defer allocator.free(want_bytes);
    try bytesEqualReport(name, decoded.bytes, want_bytes);

    // encode → bytes match.
    const side = try sideFromString(want_side_str);
    const enc = try allocator.alloc(u8, insert_bytes_v0.encodedSize(want_bytes.len));
    defer allocator.free(enc);
    _ = insert_bytes_v0.encode(
        .{ .replica_id = want_id_replica, .sequence = want_id_seq },
        .{ .replica_id = want_parent_replica, .sequence = want_parent_seq },
        side,
        want_bytes,
        enc,
    );
    try bytesEqualReport(name, enc, bytes);
}

fn checkInsertBytesV0Negative(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const kind_raw = try readFileAlloc(allocator, case_dir, "error.txt");
    defer allocator.free(kind_raw);
    const expected_kind_raw = std.mem.trim(u8, kind_raw, &std.ascii.whitespace);
    const expected_kind = if (std.mem.startsWith(u8, expected_kind_raw, "truncated_"))
        "truncated"
    else
        expected_kind_raw;

    const result = insert_bytes_v0.decode(allocator, bytes);
    if (result) |decoded| {
        allocator.free(decoded.bytes);
        std.debug.print("\ninsert_bytes_v0/{s}: expected error {s}, got success\n", .{ name, expected_kind });
        return FixtureError.MissingExpectedError;
    } else |err| {
        const got_kind = switch (err) {
            error.Truncated => "truncated",
            error.InvalidSide => "invalid_side",
            else => "unexpected",
        };
        if (!std.mem.eql(u8, got_kind, expected_kind)) {
            std.debug.print(
                "\ninsert_bytes_v0/{s}: got error kind '{s}' ({any}), want '{s}'\n",
                .{ name, got_kind, err, expected_kind },
            );
            return FixtureError.WrongErrorKind;
        }
    }
}

// ---- positive: hide_v0 / show_v0 ----
//
// Identical wire shape, so a single template generates the per-type checker.

fn checkHideV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    try checkFixedOpPositive(allocator, dir, name, "hide_v0", hide_v0);
}

fn checkShowV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    try checkFixedOpPositive(allocator, dir, name, "show_v0", show_v0);
}

fn checkFixedOpPositive(
    allocator: std.mem.Allocator,
    dir: std.fs.Dir,
    name: []const u8,
    type_name: []const u8,
    comptime codec: type,
) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const value_raw = try readFileAlloc(allocator, case_dir, "value.json");
    defer allocator.free(value_raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, value_raw, .{});
    defer parsed.deinit();
    const v = parsed.value;
    const id_v = jsonGet(v, "id");
    const target_v = jsonGet(v, "target");
    const want_id_replica: u16 = @intCast(jsonGet(id_v, "replica_id").integer);
    const want_id_seq: u32 = @intCast(jsonGet(id_v, "sequence").integer);
    const want_target_replica: u16 = @intCast(jsonGet(target_v, "replica_id").integer);
    const want_target_seq: u32 = @intCast(jsonGet(target_v, "sequence").integer);
    const want_len: u32 = @intCast(jsonGet(v, "len").integer);

    const got = try codec.decode(bytes);
    if (got.id.replica_id != want_id_replica or got.id.sequence != want_id_seq) {
        std.debug.print("\n{s}/{s} id mismatch\n", .{ type_name, name });
        return FixtureError.FixtureMismatch;
    }
    if (got.target.replica_id != want_target_replica or got.target.sequence != want_target_seq) {
        std.debug.print("\n{s}/{s} target mismatch\n", .{ type_name, name });
        return FixtureError.FixtureMismatch;
    }
    if (got.len != want_len) {
        std.debug.print("\n{s}/{s} len: got {d}, want {d}\n", .{ type_name, name, got.len, want_len });
        return FixtureError.FixtureMismatch;
    }

    var enc: [codec.SIZE]u8 = undefined;
    codec.encode(.{
        .id = .{ .replica_id = want_id_replica, .sequence = want_id_seq },
        .target = .{ .replica_id = want_target_replica, .sequence = want_target_seq },
        .len = want_len,
    }, enc[0..]);
    try bytesEqualReport(name, enc[0..], bytes);
}

// ---- negative: hide_v0 / show_v0 ----

fn checkHideV0Negative(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    try checkFixedOpNegative(allocator, dir, name, "hide_v0", hide_v0);
}

fn checkShowV0Negative(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    try checkFixedOpNegative(allocator, dir, name, "show_v0", show_v0);
}

fn checkFixedOpNegative(
    allocator: std.mem.Allocator,
    dir: std.fs.Dir,
    name: []const u8,
    type_name: []const u8,
    comptime codec: type,
) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const kind_raw = try readFileAlloc(allocator, case_dir, "error.txt");
    defer allocator.free(kind_raw);
    const expected_kind_raw = std.mem.trim(u8, kind_raw, &std.ascii.whitespace);
    const expected_kind = if (std.mem.startsWith(u8, expected_kind_raw, "truncated_"))
        "truncated"
    else
        expected_kind_raw;

    const result = codec.decode(bytes);
    if (result) |_| {
        std.debug.print("\n{s}/{s}: expected error {s}, got success\n", .{ type_name, name, expected_kind });
        return FixtureError.MissingExpectedError;
    } else |err| {
        // Both hide_v0 and show_v0 only emit Truncated.
        const got_kind: []const u8 = switch (err) {
            error.Truncated => "truncated",
        };
        if (!std.mem.eql(u8, got_kind, expected_kind)) {
            std.debug.print(
                "\n{s}/{s}: got '{s}' ({any}), want '{s}'\n",
                .{ type_name, name, got_kind, err, expected_kind },
            );
            return FixtureError.WrongErrorKind;
        }
    }
}

// ---- positive: json_envelope_v0 ----

fn checkJsonEnvelopeV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const value_raw = try readFileAlloc(allocator, case_dir, "value.json");
    defer allocator.free(value_raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, value_raw, .{});
    defer parsed.deinit();
    const want_hex = jsonGet(parsed.value, "payload_hex").string;
    const want_payload = try hexDecode(allocator, want_hex);
    defer allocator.free(want_payload);

    const dec = json_envelope_v0.decode(bytes);
    try bytesEqualReport(name, dec, want_payload);
    const enc = json_envelope_v0.encode(want_payload);
    try bytesEqualReport(name, enc, bytes);
}

// ---- positive: ack_v0 ----

fn checkAckV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const value_raw = try readFileAlloc(allocator, case_dir, "value.json");
    defer allocator.free(value_raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, value_raw, .{});
    defer parsed.deinit();
    const v = parsed.value;
    const want_ids = jsonGet(v, "group_ids").array.items;

    const decoded = try ack_v0.decode(allocator, bytes);
    defer allocator.free(decoded.group_ids);
    if (decoded.group_ids.len != want_ids.len) {
        std.debug.print("\nack_v0/{s} count: got {d}, want {d}\n", .{ name, decoded.group_ids.len, want_ids.len });
        return FixtureError.FixtureMismatch;
    }
    for (decoded.group_ids, want_ids, 0..) |actual, want, i| {
        const w_replica: u16 = @intCast(jsonGet(want, "replica_id").integer);
        const w_seq: u32 = @intCast(jsonGet(want, "sequence").integer);
        if (actual.replica_id != w_replica or actual.sequence != w_seq) {
            std.debug.print("\nack_v0/{s} id[{d}] mismatch\n", .{ name, i });
            return FixtureError.FixtureMismatch;
        }
    }

    // Rebuild ids from json and encode → must match bytes
    const ids = try allocator.alloc(node_id_v0.NodeId, want_ids.len);
    defer allocator.free(ids);
    for (want_ids, 0..) |want, i| {
        ids[i] = .{
            .replica_id = @intCast(jsonGet(want, "replica_id").integer),
            .sequence = @intCast(jsonGet(want, "sequence").integer),
        };
    }
    const enc = try allocator.alloc(u8, ack_v0.encodedSize(ids.len));
    defer allocator.free(enc);
    _ = ack_v0.encode(ids, enc);
    try bytesEqualReport(name, enc, bytes);
}

// ---- negative: ack_v0 ----

fn checkAckV0Negative(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const kind_raw = try readFileAlloc(allocator, case_dir, "error.txt");
    defer allocator.free(kind_raw);
    const expected_kind_raw = std.mem.trim(u8, kind_raw, &std.ascii.whitespace);
    const expected_kind = if (std.mem.startsWith(u8, expected_kind_raw, "truncated_"))
        "truncated"
    else
        expected_kind_raw;

    const result = ack_v0.decode(allocator, bytes);
    if (result) |decoded| {
        allocator.free(decoded.group_ids);
        std.debug.print("\nack_v0/{s}: expected error {s}, got success\n", .{ name, expected_kind });
        return FixtureError.MissingExpectedError;
    } else |err| {
        const got_kind: []const u8 = switch (err) {
            error.Truncated => "truncated",
            error.OutOfMemory => "oom",
        };
        if (!std.mem.eql(u8, got_kind, expected_kind)) {
            std.debug.print(
                "\nack_v0/{s}: got '{s}' ({any}), want '{s}'\n",
                .{ name, got_kind, err, expected_kind },
            );
            return FixtureError.WrongErrorKind;
        }
    }
}

// ---- positive: multi_op_v0 ----

fn checkMultiOpV0Positive(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const value_raw = try readFileAlloc(allocator, case_dir, "value.json");
    defer allocator.free(value_raw);

    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, value_raw, .{});
    defer parsed.deinit();
    const v = parsed.value;
    const g = jsonGet(v, "group_id");
    const want_replica: u16 = @intCast(jsonGet(g, "replica_id").integer);
    const want_seq: u32 = @intCast(jsonGet(g, "sequence").integer);
    const want_ops = jsonGet(v, "ops").array.items;

    // decode → field match
    const decoded = try multi_op_v0.decode(allocator, bytes);
    defer allocator.free(decoded.ops);

    if (decoded.group_id.replica_id != want_replica or decoded.group_id.sequence != want_seq) {
        std.debug.print(
            "\nmulti_op_v0/{s} group_id mismatch: got ({d},{d}), want ({d},{d})\n",
            .{ name, decoded.group_id.replica_id, decoded.group_id.sequence, want_replica, want_seq },
        );
        return FixtureError.FixtureMismatch;
    }
    if (decoded.ops.len != want_ops.len) {
        std.debug.print(
            "\nmulti_op_v0/{s} op count: got {d}, want {d}\n",
            .{ name, decoded.ops.len, want_ops.len },
        );
        return FixtureError.FixtureMismatch;
    }
    for (decoded.ops, want_ops, 0..) |op, want_op, i| {
        const want_disc: u8 = @intCast(jsonGet(want_op, "disc").integer);
        if (op.disc != want_disc) {
            std.debug.print(
                "\nmulti_op_v0/{s} op[{d}] disc: got {d}, want {d}\n",
                .{ name, i, op.disc, want_disc },
            );
            return FixtureError.FixtureMismatch;
        }
        const want_hex = jsonGet(want_op, "payload_hex").string;
        const want_payload = try hexDecode(allocator, want_hex);
        defer allocator.free(want_payload);
        try bytesEqualReport(name, op.payload, want_payload);
    }

    // encode → bytes match. Need to materialize the inner ops with payload
    // slices held alive for the duration of encode.
    var inner_payloads = std.ArrayList([]u8).initCapacity(allocator, want_ops.len) catch unreachable;
    defer {
        for (inner_payloads.items) |p| allocator.free(p);
        inner_payloads.deinit(allocator);
    }
    var inner_ops = try allocator.alloc(multi_op_v0.InnerOp, want_ops.len);
    defer allocator.free(inner_ops);

    for (want_ops, 0..) |want_op, i| {
        const disc: u8 = @intCast(jsonGet(want_op, "disc").integer);
        const want_hex = jsonGet(want_op, "payload_hex").string;
        const payload = try hexDecode(allocator, want_hex);
        try inner_payloads.append(allocator, payload);
        inner_ops[i] = .{ .disc = disc, .payload = payload };
    }

    const enc = try allocator.alloc(u8, multi_op_v0.encodedSize(inner_ops, null));
    defer allocator.free(enc);
    _ = multi_op_v0.encode(.{ .replica_id = want_replica, .sequence = want_seq }, inner_ops, null, enc);
    try bytesEqualReport(name, enc, bytes);
}

// ---- negative: multi_op_v0 ----

fn checkMultiOpV0Negative(allocator: std.mem.Allocator, dir: std.fs.Dir, name: []const u8) !void {
    var case_dir = try dir.openDir(name, .{});
    defer case_dir.close();

    const bytes = try readFileAlloc(allocator, case_dir, "bytes.bin");
    defer allocator.free(bytes);
    const kind_raw = try readFileAlloc(allocator, case_dir, "error.txt");
    defer allocator.free(kind_raw);
    const expected_kind_raw = std.mem.trim(u8, kind_raw, &std.ascii.whitespace);
    // Coalesce truncated_* into "truncated" — same strategy as Go and JS;
    // the fixture name carries the precise sub-kind.
    const expected_kind = if (std.mem.startsWith(u8, expected_kind_raw, "truncated_"))
        "truncated"
    else
        expected_kind_raw;

    const result = multi_op_v0.decode(allocator, bytes);
    if (result) |decoded| {
        allocator.free(decoded.ops);
        std.debug.print("\nmulti_op_v0/{s}: expected error {s}, got success\n", .{ name, expected_kind });
        return FixtureError.MissingExpectedError;
    } else |err| {
        const got_kind = switch (err) {
            error.Truncated => "truncated",
            error.UnknownInnerDisc => "unknown_inner_disc",
            else => "unexpected",
        };
        if (!std.mem.eql(u8, got_kind, expected_kind)) {
            std.debug.print(
                "\nmulti_op_v0/{s}: got error kind '{s}' ({any}), want '{s}'\n",
                .{ name, got_kind, err, expected_kind },
            );
            return FixtureError.WrongErrorKind;
        }
    }
}

// ---- driver ----

fn walkDir(
    allocator: std.mem.Allocator,
    root_rel: []const u8,
    comptime CheckFn: type,
    check: CheckFn,
) !void {
    var dir = try std.fs.cwd().openDir(root_rel, .{ .iterate = true });
    defer dir.close();
    var it = dir.iterate();
    while (try it.next()) |entry| {
        if (entry.kind != .directory) continue;
        try check(allocator, dir, entry.name);
    }
}

test "positive fixtures: node_id_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/positive/node_id_v0",
        @TypeOf(checkNodeIdV0Positive),
        checkNodeIdV0Positive,
    );
}

test "positive fixtures: multi_op_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/positive/multi_op_v0",
        @TypeOf(checkMultiOpV0Positive),
        checkMultiOpV0Positive,
    );
}

test "positive fixtures: insert_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/positive/insert_v0",
        @TypeOf(checkInsertV0Positive),
        checkInsertV0Positive,
    );
}

test "negative fixtures: multi_op_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/negative/multi_op_v0",
        @TypeOf(checkMultiOpV0Negative),
        checkMultiOpV0Negative,
    );
}

test "negative fixtures: insert_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/negative/insert_v0",
        @TypeOf(checkInsertV0Negative),
        checkInsertV0Negative,
    );
}

test "positive fixtures: insert_bytes_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/positive/insert_bytes_v0",
        @TypeOf(checkInsertBytesV0Positive),
        checkInsertBytesV0Positive,
    );
}

test "negative fixtures: insert_bytes_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/negative/insert_bytes_v0",
        @TypeOf(checkInsertBytesV0Negative),
        checkInsertBytesV0Negative,
    );
}

test "positive fixtures: hide_v0" {
    const allocator = std.testing.allocator;
    try walkDir(allocator, "serde/fixtures/positive/hide_v0", @TypeOf(checkHideV0Positive), checkHideV0Positive);
}

test "positive fixtures: show_v0" {
    const allocator = std.testing.allocator;
    try walkDir(allocator, "serde/fixtures/positive/show_v0", @TypeOf(checkShowV0Positive), checkShowV0Positive);
}

test "negative fixtures: hide_v0" {
    const allocator = std.testing.allocator;
    try walkDir(allocator, "serde/fixtures/negative/hide_v0", @TypeOf(checkHideV0Negative), checkHideV0Negative);
}

test "negative fixtures: show_v0" {
    const allocator = std.testing.allocator;
    try walkDir(allocator, "serde/fixtures/negative/show_v0", @TypeOf(checkShowV0Negative), checkShowV0Negative);
}

test "positive fixtures: ack_v0" {
    const allocator = std.testing.allocator;
    try walkDir(allocator, "serde/fixtures/positive/ack_v0", @TypeOf(checkAckV0Positive), checkAckV0Positive);
}

test "negative fixtures: ack_v0" {
    const allocator = std.testing.allocator;
    try walkDir(allocator, "serde/fixtures/negative/ack_v0", @TypeOf(checkAckV0Negative), checkAckV0Negative);
}

test "positive fixtures: json_envelope_v0" {
    const allocator = std.testing.allocator;
    try walkDir(
        allocator,
        "serde/fixtures/positive/json_envelope_v0",
        @TypeOf(checkJsonEnvelopeV0Positive),
        checkJsonEnvelopeV0Positive,
    );
}
