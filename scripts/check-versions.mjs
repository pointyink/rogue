// Every workspace package's internal dependency range must match the workspace
// version, and all four must share that version.
//
// This is not pedantry: `@pointyink/tinymce` declared `@pointyink/rogue: ^0.4.0`
// through three releases, so npm installed a *nested* rogue 0.4.4 under the
// plugin while the repo was at 0.5.x and 0.6.0. The demos bundled one engine and
// the app bundled another — a difference invisible to every test that imports
// the workspace rather than the published package.
import { readFileSync } from 'node:fs'

const packages = ['serde', 'rogue', 'plugins/tinymce', 'plugins/hugerte']
const names = new Map()
const versions = new Map()

for (const dir of packages) {
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  names.set(manifest.name, manifest.version)
  versions.set(dir, manifest.version)
}

let problems = 0
const distinct = new Set(versions.values())
if (distinct.size !== 1) {
  console.error(`workspace versions differ: ${[...distinct].join(', ')}`)
  problems++
}

for (const dir of packages) {
  const manifest = JSON.parse(readFileSync(`${dir}/package.json`, 'utf8'))
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }
  for (const [name, range] of Object.entries(deps)) {
    const version = names.get(name)
    if (!version) continue
    const want = `^${version}`
    if (range !== want) {
      console.error(`${dir}: depends on ${name} ${range}, want ${want} (a mismatch installs a second copy)`)
      problems++
    }
  }
}

if (problems) {
  console.error(`\n${problems} version problem(s). Bump every workspace package together.`)
  process.exit(1)
}
console.log(`versions ok: ${[...distinct][0]}`)
