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
const timeoutFlag = process.argv.indexOf('--timeout')
const timeoutSeconds = timeoutFlag === -1 ? 900 : Number(process.argv[timeoutFlag + 1])
if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
  console.error('--timeout needs a positive number of seconds')
  process.exit(1)
}
const timeoutAt = Date.now() + timeoutSeconds * 1000
const PACKAGES = ['serde', 'rogue', 'tinymce', 'hugerte']

for (;;) {
  const pending = []
  for (const name of PACKAGES) {
    // Cache-bust in the URL: the registry sits behind a CDN that does not
    // reliably honour a request-side no-cache, and a cached 404 would make this
    // poll for the full timeout after a successful publish — the exact lag it
    // exists to out-wait.
    const url = `https://registry.npmjs.org/@pointyink%2F${name}/${version}?ts=${Date.now()}`
    let status = 0
    try {
      const res = await fetch(url, { cache: 'no-store' })
      status = res.status
    } catch {
      // A network blip is not "published": treat it as pending and keep waiting.
    }
    if (status !== 200) pending.push(name)
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
