//! Cross-language error-kind contract (WASM↔JS). The int value is the stable
//! machine key (discriminator semantics — never reorder or reuse a value); the
//! name is the human-facing @tagName. The single source of truth is
//! error_kinds.json, checked by the conformance test (below, run via
//! `zig build test`) and by rogue/src/crdt_error.test.js on the JS side.

pub const ErrorKind = enum(u8) {
    out_of_memory = 1,
    invalid_group = 2,
    out_of_bounds = 3,
    parse_error = 4,
    render_overflow = 5,
    unknown_parent = 6,
    unknown_target = 7,
    unknown_id = 8,
};
