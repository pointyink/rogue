// Emits src/rogue.wasm.js — the CRDT wasm as a base64 string module — so the
// published package is self-contained (no .wasm asset, no bundler loader config
// for consumers). Reads zig-out/bin/rogue.wasm (produced by `zig build wasm`).
//
// Idempotent: only rewrites the file when the wasm actually changed. The output
// lives in a directory the dev server watches (air), so rewriting it on every
// build — even byte-identically — churns the mtime and loops the rebuild.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const wasm = readFileSync(resolve(here, '../zig-out/bin/rogue.wasm'))
const out = resolve(here, '../src/rogue.wasm.js')
const content = `/** @type {string} */\nconst wasmBase64 = '${wasm.toString('base64')}';\nexport default wasmBase64;\n`

if (existsSync(out) && readFileSync(out, 'utf8') === content) {
  console.log(`unchanged ${out}`)
} else {
  writeFileSync(out, content)
  console.log(`wrote ${out} (${wasm.length} bytes wasm → ${wasm.toString('base64').length} chars base64)`)
}
