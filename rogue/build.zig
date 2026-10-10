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
    const wasm_step = b.step("wasm", "Build WASM module");
    wasm_step.dependOn(&b.addInstallArtifact(wasm, .{}).step);

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
