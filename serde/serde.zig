//! serde module index — re-exports each codec so consumers can `@import("serde")`
//! once and access codecs as namespaces. Stand-alone `zig test` of individual
//! codec files still works because each file uses relative `@import` for its
//! deps.

pub const node_id_v0 = @import("node_id_v0.zig");
pub const insert_v0 = @import("insert_v0.zig");
pub const insert_bytes_v0 = @import("insert_bytes_v0.zig");
pub const hide_v0 = @import("hide_v0.zig");
pub const show_v0 = @import("show_v0.zig");
pub const multi_op_v0 = @import("multi_op_v0.zig");
pub const ack_v0 = @import("ack_v0.zig");
pub const content_address_v0 = @import("content_address_v0.zig");
pub const json_envelope_v0 = @import("json_envelope_v0.zig");
