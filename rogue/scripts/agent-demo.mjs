// Multi-agent sync experiment: two headless CRDT replicas (no browser) with a
// validated insert surface. Run with: node scripts/agent-demo.mjs
//
// Demonstrates:
//   - agents read the doc as rope-canonical HTML
//   - writes are gated by a round-trip check (malformed LLM HTML is rejected)
//   - edits flow between replicas via onCommit → mergeOp

import { createHeadlessEditor } from '../src/headless.js'

const a = await createHeadlessEditor({ replicaId: 1 })
const b = await createHeadlessEditor({ replicaId: 2 })

a.subscribe((p) => b.mergeOp(p))
b.subscribe((p) => a.mergeOp(p))

const show = (label) => {
  const ok = a.assertConsistent().ok && b.assertConsistent().ok
  console.log(`${label}\n  A: ${JSON.stringify(a.getHtml())}\n  B: ${JSON.stringify(b.getHtml())}\n  consistent: ${ok}`)
}

show('initial')

console.log('\n--- agent A appends a valid paragraph ---')
console.log(await a.appendHtml('<p>Hello from agent A</p>'))
show('after A append')

console.log('\n--- agent B appends a valid paragraph ---')
console.log(await b.appendHtml('<p>Hello from agent <b>B</b></p>'))
show('after B append')

console.log('\n--- agent B tries malformed HTML (block-in-<p>) ---')
console.log(await b.appendHtml('<p>bad<div>nested</div></p>'))
show('after rejected append (should be unchanged)')

console.log('\n--- agent B tries a mismatched table (fostering) ---')
console.log(await b.appendHtml('<table>stray text<tr><td>x</td></tr></table>'))
show('after rejected table (should be unchanged)')

console.log('\n--- undo on A ---')
a.undo()
show('after A undo')

a.destroy()
b.destroy()
