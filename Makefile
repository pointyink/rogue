.PHONY: test test-zig test-rogue test-serde build-serde

test: test-zig test-rogue test-serde

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
