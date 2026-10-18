const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Native static library
    const lib = b.addLibrary(.{
        .name = "rogue",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("crdt/rogue.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(lib);

    // WASM module (freestanding, no OS)
    const wasm_target = b.resolveTargetQuery(.{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    });
    // The serde codecs live in a sibling top-level `serde/` directory so
    // Zig/JS/Go all read the same source of truth. Wire it as a named module
    // so wasm.zig can `@import("serde")` despite being outside its own module
    // path. Sibling deps within serde/ still resolve via relative imports.
    const serde_module = b.createModule(.{
        .root_source_file = b.path("../serde/serde.zig"),
        .target = wasm_target,
        .optimize = optimize,
    });
    const wasm_root = b.createModule(.{
        .root_source_file = b.path("crdt/wasm.zig"),
        .target = wasm_target,
        .optimize = optimize,
    });
    wasm_root.addImport("serde", serde_module);
    const wasm = b.addExecutable(.{
        .name = "rogue",
        .root_module = wasm_root,
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    // Strip debug info: the published wasm doesn't need it, and the DWARF
    // source paths make the artifact host/path-dependent (breaking wasm-check).
    wasm.root_module.strip = true;

    // Byte-native module for the Go file-sync binding (insert_bytes_v0).
    const wasm_u8_root = b.createModule(.{
        .root_source_file = b.path("crdt/wasm_u8.zig"),
        .target = wasm_target,
        .optimize = optimize,
    });
    wasm_u8_root.addImport("serde", serde_module);
    const wasm_u8 = b.addExecutable(.{
        .name = "rogue_u8",
        .root_module = wasm_u8_root,
    });
    wasm_u8.entry = .disabled;
    wasm_u8.rdynamic = true;
    wasm_u8.root_module.strip = true;

    const install_u16 = b.addInstallArtifact(wasm, .{});
    const install_u8 = b.addInstallArtifact(wasm_u8, .{});
    const wasm_step = b.step("wasm", "Build WASM modules");
    wasm_step.dependOn(&install_u16.step);
    wasm_step.dependOn(&install_u8.step);
    const wasm_u8_step = b.step("wasm-u8", "Build the byte-native WASM module");
    wasm_u8_step.dependOn(&install_u8.step);

    // Tests. Run a single test with:  zig build test -Dtest-filter="<name substring>"
    const test_filter = b.option([]const u8, "test-filter", "Only run tests whose name contains this substring");
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("crdt/rogue.zig"),
            .target = target,
            .optimize = optimize,
        }),
        .filters = if (test_filter) |f| &.{f} else &.{},
    });
    const test_step = b.step("test", "Run tests");
    test_step.dependOn(&b.addRunArtifact(tests).step);
}
