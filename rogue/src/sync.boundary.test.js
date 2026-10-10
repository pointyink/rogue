// @ts-check
// Minimal repro for seed 1337: CRDT diverges from DOM after a large text delete.

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'

const flush = () => new Promise(r => setTimeout(r, 0))

function makeEditor() {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  return el
}

const render = () => /** @type {any} */ (window).rogue.render()

describe('seed 1337 repro', () => {
  it('delete crossing tag boundary', async () => {
    const el = makeEditor()
    const node = await createRogueNode({ element: el })
    const rogue = /** @type {any} */ (window).rogue

    // Exact state from seed 1337 step 145 before the edit.
    el.innerHTML = '<p>amenimet ilorem venyoiam yoenimisyo dolor enimloremsit ametadror</p><h2>enim</h2><p>venxmet ximiaveniam amexquis qusit amet</p>'
    await flush()

    const r1 = render()
    const i1 = el.innerHTML
    console.error('BEFORE:', JSON.stringify(r1), JSON.stringify(i1), r1 === i1)

    // Apply the exact delete: del[23,62] on the first paragraph's text node.
    const t = /** @type {Text} */ (/** @type {HTMLParagraphElement} */ (el.querySelector('p')).firstChild)
    // Delete chars 23-61 (39 chars)
    t.data = t.data.slice(0, 23) + t.data.slice(62)
    await flush()

    const r2 = render()
    const i2 = el.innerHTML
    console.error('AFTER:', JSON.stringify(r2), JSON.stringify(i2), r2 === i2)

    expect(render()).toBe(el.innerHTML)

    node.destroy()
    el.remove()
  })
})
