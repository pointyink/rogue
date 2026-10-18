// Copies the byte-native wasm (zig-out/bin/rogue_u8.wasm) into the Go module's
// embed directory (filesync/rogue_u8.wasm). The Go binding embeds it with
// //go:embed, so it must live inside the module at build time. Rebuilt by
// `npm run build:wasm`; `make wasm-check` fails if the committed copy is stale.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const wasm = resolve(here, '../zig-out/bin/rogue_u8.wasm')
const outDir = resolve(here, '../../filesync')
const out = resolve(outDir, 'rogue_u8.wasm')

if (!existsSync(wasm)) {
  console.error(`missing ${wasm}; run \`zig build wasm\` first`)
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })
copyFileSync(wasm, out)
console.log(`wrote ${out}`)
