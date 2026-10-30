// @ts-check
//
// opaqueNode: the fourth rope quadrant — keep an element's tags + attributes,
// drop its children from the CRDT. The host keeps whatever it renders inside
// (an iframe, a chart, a CodeMirror instance); the CRDT only stores the shell.
//
// The failure mode to guard against is the opposite: the host's local children
// leaking into the CRDT through the DOM side of the diff (a deep clone in
// rangeOuterHtml, or a rope resync that tokenizes an opaque subtree).

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'
import { createHeadlessEditor } from './headless.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** @param {Node} n */
const isCell = (n) => n.nodeType === 1 && /** @type {Element} */ (n).hasAttribute('data-cell')

/** @returns {HTMLElement} */
function editor() {
  const e = document.createElement('div')
  e.setAttribute('contenteditable', 'true')
  document.body.appendChild(e)
  return e
}

describe('opaqueNode', () => {
  it('syncs the shell and drops the subtree', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 1, opaqueNode: isCell })

    el.innerHTML = '<p>before</p><div data-cell="a"><span>local</span>text</div><p>after</p>'
    await flush()

    expect(n.getString()).toBe('<p>before</p><div data-cell="a"></div><p>after</p>')
    expect(n.assertConsistent().ok).toBe(true)
  })

  it('emits no op when the host mutates the opaque subtree', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 2, opaqueNode: isCell })

    el.innerHTML = '<div data-cell="a"><span>local</span></div><p>tail</p>'
    await flush()
    const before = n.stats().ops

    const span = /** @type {Element} */ (el.querySelector('span'))
    span.textContent = 'changed locally'
    const cellEl = /** @type {Element} */ (el.querySelector('[data-cell]'))
    cellEl.appendChild(document.createElement('em'))
    await flush()

    expect(n.stats().ops).toBe(before)
    expect(n.getString()).toBe('<div data-cell="a"></div><p>tail</p>')
  })

  it('emits an op when the shell attributes change', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 3, opaqueNode: isCell })

    el.innerHTML = '<div data-cell="a"></div>'
    await flush()
    const before = n.stats().ops

    const cellEl = /** @type {Element} */ (el.querySelector('[data-cell]'))
    cellEl.setAttribute('data-title', 'hi')
    await flush()

    expect(n.stats().ops).toBe(before + 1)
    expect(n.getString()).toBe('<div data-cell="a" data-title="hi"></div>')
  })

  it('does not leak local children when the opaque element is inside a diffed region', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 4, opaqueNode: isCell })

    el.innerHTML = '<div id="wrap"><p>x</p><div data-cell="c"><b>local</b></div></div>'
    await flush()

    // Replacing the wrapper's children puts the opaque element *inside* the DOM
    // diff range, so rangeOuterHtml serializes it. A deep clone would carry
    // "local2" into the CRDT.
    const wrap = /** @type {Element} */ (el.querySelector('#wrap'))
    wrap.innerHTML = '<p>y</p><div data-cell="c"><b>local2</b></div>'
    await flush()

    expect(n.getString()).toBe('<div id="wrap"><p>y</p><div data-cell="c"></div></div>')
    expect(n.assertConsistent().ok).toBe(true)
  })

  it('still routes the shell through serializeNode', async () => {
    const el = editor()
    const n = await createRogueNode({
      element: el,
      replicaId: 5,
      opaqueNode: isCell,
      serializeNode: (e) => e.outerHTML.replace(/\sdata-internal="1"/g, ''),
    })

    el.innerHTML = '<div data-cell="b" data-internal="1"><b>x</b></div>'
    await flush()

    expect(n.getString()).toBe('<div data-cell="b"></div>')
  })

  it('respects precedence: omitNode → unwrapNode → opaqueNode', async () => {
    const el = editor()
    const n = await createRogueNode({
      element: el,
      replicaId: 6,
      omitNode: (nd) => nd.nodeType === 1 && /** @type {Element} */ (nd).hasAttribute('data-omit'),
      unwrapNode: (nd) => nd.nodeType === 1 && /** @type {Element} */ (nd).hasAttribute('data-unwrap'),
      opaqueNode: (nd) =>
        nd.nodeType === 1 &&
        (/** @type {Element} */ (nd).hasAttribute('data-cell') ||
          /** @type {Element} */ (nd).hasAttribute('data-omit') ||
          /** @type {Element} */ (nd).hasAttribute('data-unwrap')),
    })

    el.innerHTML =
      '<div data-omit data-cell><b>drop me</b></div>' +
      '<div data-unwrap data-cell><b>keep me</b></div>'
    await flush()

    // omit wins → nothing at all; unwrap wins over opaque → children kept, tags dropped.
    expect(n.getString()).toBe('<b>keep me</b>')
  })

  it('leaves void elements alone', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 7, opaqueNode: isCell })

    el.innerHTML = '<p>a</p><img data-cell="i" src="x.png"><p>b</p>'
    await flush()

    expect(n.getString()).toBe('<p>a</p><img data-cell="i" src="x.png"><p>b</p>')
  })

  it('keeps the vis-index in step with the rendered shell', async () => {
    const el = editor()
    const n = await createRogueNode({ element: el, replicaId: 8, opaqueNode: isCell })

    el.innerHTML = '<p>one</p><div data-cell="a"><span>ignored</span></div><p>two</p>'
    await flush()

    const html = n.getString()
    expect(n.stats().visLen).toBe(html.length)
    expect(html).not.toContain('ignored')
  })
})

describe('opaqueNode: headless parity', () => {
  it('setHtml keeps the shell, getHtml reports it', async () => {
    const ed = await createHeadlessEditor({ replicaId: 9, opaqueNode: isCell })

    const res = await ed.setHtml('<div data-cell="h"><span>local</span></div><p>tail</p>')
    expect(res.ok).toBe(true)
    expect(res.html).toBe('<div data-cell="h"></div><p>tail</p>')
    expect(ed.getHtml()).toBe('<div data-cell="h"></div><p>tail</p>')

    const appended = await ed.appendHtml('<div data-cell="i"><b>local2</b></div>')
    expect(appended.html).toBe('<div data-cell="h"></div><p>tail</p><div data-cell="i"></div>')
  })
})
