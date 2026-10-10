//! json_envelope_v0 — pass-through wrapper for a UTF-8 JSON payload.
//! See `json_envelope_v0.md`. The codec performs no parsing — bytes in,
//! bytes out. Routing happens via a `"type"` field inside the JSON,
//! interpreted by the application.

const std = @import("std");

pub const DISC: u16 = 5;

/// Identity. Provided for symmetry with the other codecs — encoders
/// produce the bytes that the outer wire frame will length-prefix.
pub fn encode(json_bytes: []const u8) []const u8 {
    return json_bytes;
}

/// Identity. The caller-supplied slice (already bounded by the outer
/// wire frame's length) is the payload.
pub fn decode(buf: []const u8) []const u8 {
    return buf;
}

test "round-trip: empty object" {
    const payload = "{}";
    const enc = encode(payload);
    const dec = decode(enc);
    try std.testing.expectEqualSlices(u8, payload, enc);
    try std.testing.expectEqualSlices(u8, payload, dec);
}

test "round-trip: cursor presence example" {
    const payload =
        \\{"type":"cursor","user_id":"abc","line":10,"col":20}
    ;
    const enc = encode(payload);
    const dec = decode(enc);
    try std.testing.expectEqualSlices(u8, payload, enc);
    try std.testing.expectEqualSlices(u8, payload, dec);
}

test "round-trip: empty payload (no JSON validation at this layer)" {
    const payload: []const u8 = "";
    const enc = encode(payload);
    const dec = decode(enc);
    try std.testing.expectEqualSlices(u8, payload, enc);
    try std.testing.expectEqualSlices(u8, payload, dec);
}
