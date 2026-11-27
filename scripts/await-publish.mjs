// Wait until every package actually serves the version.
//
// `Publish npm packages` succeeding is a claim; the registry is the proof, and it
// lags per package (serde has trailed by minutes twice). A pointy bump that runs
// before all four are visible fails `npm ci` with ETARGET, which looks like a
// dependency bug and is not.
//
// Usage: node scripts/await-publish.mjs 0.7.1 [--timeout 900]
import { setTimeout as sleep } from 'node:timers/promises'

const version = process.argv[2]
if (!version) {
  console.error('usage: node scripts/await-publish.mjs <x.y.z> [--timeout seconds]')
  process.exit(1)
}
const timeoutAt = Date.now() + (Number(process.argv[4] ?? 900) * 1000)
const PACKAGES = ['serde', 'rogue', 'tinymce', 'hugerte']

for (;;) {
  const pending = []
  for (const name of PACKAGES) {
    const url = `https://registry.npmjs.org/@pointyink%2F${name}/${version}`
    const res = await fetch(url, { headers: { 'cache-control': 'no-cache' } })
    if (res.status !== 200) pending.push(name)
  }
  if (pending.length === 0) {
    console.log(`all four packages serve ${version}`)
    process.exit(0)
  }
  if (Date.now() > timeoutAt) {
    console.error(`still not published: ${pending.join(', ')}`)
    process.exit(1)
  }
  console.log(`waiting on: ${pending.join(', ')}`)
  await sleep(15_000)
}
