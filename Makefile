.PHONY: test test-zig test-rogue test-serde test-filesync build-serde verify typecheck fmt-check types-check wasm-check build-dist

test: test-zig test-rogue test-serde test-filesync

# The full gate agents should run before handing off.
verify: test typecheck fmt-check types-check wasm-check build-dist

test-zig:
	cd rogue && zig build test

# vitest resolves @pointyink/serde/* through its package.json `exports`, which
# points at the (gitignored) dist/ — build it first.
build-serde:
	cd serde && npm run build:dist

test-rogue: build-serde
	cd rogue && npx vitest run

test-serde:
	go test ./serde/...
	zig test serde/fixtures_test.zig
	node serde/fixtures_test.js

test-filesync:
	go test ./filesync/...

typecheck:
	cd rogue && npx tsc -p jsconfig.json --noEmit

fmt-check:
	@git ls-files -z '*.zig' | xargs -0 zig fmt --check
	@bad="$$(gofmt -l serde filesync)"; if [ -n "$$bad" ]; then echo "gofmt needed:"; echo "$$bad"; exit 1; fi

# Regenerate every committed declaration set, then fail if the tree changed.
# A release must never ship stale or missing declarations.
types-check:
	cd serde && npm run build:types
	cd rogue && npm run build:types
	cd plugins/tinymce && npm run build:types
	cd plugins/hugerte && npm run build:types
	git diff --exit-code -- serde/types rogue/types plugins/tinymce/types plugins/hugerte/types

# The wasm the JS layer loads is committed as base64 in src/rogue.wasm.js.
# Rebuild it from the Zig source and fail if the committed copy is stale.
wasm-check:
	cd rogue && npm run build:wasm
	git diff --exit-code -- rogue/src/rogue.wasm.js filesync/rogue_u8.wasm

# Publish smoke test: esbuild every package's entrypoints in dependency order.
build-dist:
	cd serde && npm run build:dist
	cd rogue && npm run build:dist
	cd plugins/tinymce && npm run build:dist
	cd plugins/hugerte && npm run build:dist
