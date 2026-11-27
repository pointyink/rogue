// One version, every place it lives.
//
// The same drift has bitten three times:
//   1. the plugins kept `@pointyink/rogue: ^0.4.0` through three releases, so npm
//      installed a nested 0.4.4 and the demos bundled a different engine from the
//      app;
//   2. the same bug surfaced again at the 0.6.0 bump, from the other side;
//   3. `REJECT_VERSION` is a const, so its literal type is in the generated
//      declarations — bump it without regenerating types and CI fails.
//
// Every one of those is "a version written by hand in more than one place". So
// this script writes all of them, and `make versions-check` verifies the result.
//
// Usage: node scripts/release-prepare.mjs 0.7.1
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: node scripts/release-prepare.mjs <x.y.z>')
  process.exit(1)
}

const PACKAGES = ['serde', 'rogue', 'plugins/tinymce', 'plugins/hugerte']
const names = new Map()

// 1. Each package's own version.
for (const dir of PACKAGES) {
  const file = `${dir}/package.json`
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  names.set(pkg.name, pkg.name)
  pkg.version = version
  // 2. Internal ranges, in the same pass: this is the one that regressed.
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
    const deps = pkg[field]
    if (!deps) continue
    for (const name of Object.keys(deps)) {
      if (name.startsWith('@pointyink/')) deps[name] = `^${version}`
    }
  }
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`${file} → ${version}`)
}

// 3. The validator version, which gates rejection verdicts.
const cacheFile = 'rogue/src/doc-cache.js'
const cache = readFileSync(cacheFile, 'utf8')
const bumped = cache.replace(/REJECT_VERSION\s*=\s*'[^']+'/, `REJECT_VERSION = '${version}'`)
if (bumped === cache) {
  console.error(`${cacheFile}: no REJECT_VERSION to bump — did it move?`)
  process.exit(1)
}
writeFileSync(cacheFile, bumped)
console.log(`${cacheFile} REJECT_VERSION → ${version}`)

// 4. The lockfile and the declarations are derived from those files.
execFileSync('npm', ['install', '--package-lock-only', '--ignore-scripts'], { stdio: 'inherit' })
for (const dir of PACKAGES) {
  execFileSync('npm', ['run', '--silent', 'build:types'], { cwd: dir, stdio: 'inherit' })
}

// 5. Prove it, rather than hoping.
execFileSync('node', ['scripts/check-versions.mjs'], { stdio: 'inherit' })

console.log(`
Next:
  git commit -am "chore(release): ${version}"
  git push && gh pr create …            # the release PR
  gh pr merge … --squash
  git tag -a v${version} && git push origin v${version}
  node scripts/await-publish.mjs ${version}   # all four manifests, not just dist-tags
`)
