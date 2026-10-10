// @ts-check
//
// TinyMCE scrub hooks — lock the "content vs editor chrome" boundary so TinyMCE's
// transient bookmarks (format-caret, ﻿, resize handles) never leak into the
// CRDT. These run the *real* hooks from plugins/tinymce/scrub.js against a fake
// TinyMCE DOM in jsdom, plus an end-to-end sync test.

import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'
import { serializeNode, omitNode, unwrapNode } from '../../plugins/tinymce/scrub.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** @returns {HTMLElement} */
function makeEditor() {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  return el
}

describe('TinyMCE scrub hooks', () => {
  it('omitNode drops whole chrome containers, keeps everything else', () => {
    const div = document.createElement('div')
    div.innerHTML =
      '<p>real</p>' +
      '<div data-mce-bogus="all"><div>nested bar</div></div>' +
      '<p><br data-mce-bogus="1"></p>'

    const [p, chrome, empty] = div.children
    const br = /** @type {HTMLBRElement} */ (empty.querySelector('br'))
    expect(omitNode(p)).toBe(false)
    expect(omitNode(chrome)).toBe(true)
    // The empty block and its bogus <br> are kept — they become a visible <br>.
    expect(omitNode(empty)).toBe(false)
    expect(omitNode(br)).toBe(false)
  })

  it('unwrapNode matches the format-caret wrapper only', () => {
    const div = document.createElement('div')
    div.innerHTML = '<span data-mce-type="format-caret"><sup>x</sup></span>'
    const caret = /** @type {Element} */ (div.firstChild)
    expect(unwrapNode(caret)).toBe(true)
    expect(unwrapNode(/** @type {Element} */ (caret.firstChild))).toBe(false)
  })

  it('serializeNode strips attrs/caret/chrome, keeps the bogus <br> as a plain <br>', () => {
    const div = document.createElement('div')
    div.innerHTML =
      '<table><tbody><tr><td data-mce-selected="1">' +
      '<span data-mce-type="format-caret" data-mce-bogus="1"><sup>\uFEFFx2</sup></span>' +
      '</td></tr></tbody></table>' +
      '<p><br data-mce-bogus="1"></p>' +
      '<div data-mce-bogus="all"></div>'

    const td = /** @type {Element} */ (div.querySelector('td'))
    expect(serializeNode(/** @type {Element} */ (td.cloneNode(true)))).toBe('<td><sup>x2</sup></td>')

    // The empty block keeps its <br> (now without data-mce-bogus), so it stays
    // visible as a real line in the editor.
    const p = /** @type {Element} */ (div.querySelector('p'))
    expect(serializeNode(/** @type {Element} */ (p.cloneNode(true)))).toBe('<p><br></p>')
  })

  it('sync: the CRDT never sees TinyMCE chrome', async () => {
    const el = makeEditor()
    const node = await createRogueNode({ element: el, serializeNode, omitNode, unwrapNode })
    const rogue = /** @type {any} */ (window).rogue
    try {
      el.innerHTML =
        '<table data-mce-selected="1"><tbody><tr><td>' +
        '<span data-mce-type="format-caret" data-mce-bogus="1"><sup>\uFEFFx2</sup></span>' +
        '</td></tr></tbody></table>' +
        '<div data-mce-bogus="all"></div>'
      await flush()

      const render = rogue.render()
      expect(render).not.toContain('_mce_caret')
      expect(render).not.toContain('data-mce-')
      expect(render).not.toContain('\uFEFF')
      expect(render).toBe('<table><tbody><tr><td><sup>x2</sup></td></tr></tbody></table>')
    } finally {
      node.destroy()
      el.remove()
    }
  })

  it('sync: empty blocks are kept as a visible <br> (blank line)', async () => {
    const el = makeEditor()
    const node = await createRogueNode({ element: el, serializeNode, omitNode, unwrapNode })
    const rogue = /** @type {any} */ (window).rogue
    try {
      // A blank line the user created with Enter (empty <p> padded with a bogus
      // <br>) stays as a <br> — visible in the editor, not collapsed to <p></p>.
      el.innerHTML = '<p>a</p><p><br data-mce-bogus="1"></p><p>b</p>'
      await flush()

      expect(rogue.render()).toBe('<p>a</p><p><br></p><p>b</p>')
    } finally {
      node.destroy()
      el.remove()
    }
  })

  it('sync: loading-time mutations are not absorbed (mode.set readonly/design)', async () => {
    const el = makeEditor()
    // TinyMCE's initial empty state, present *before* the engine attaches.
    el.innerHTML = '<p><br data-mce-bogus="1"></p>'
    const node = await createRogueNode({ element: el, serializeNode, omitNode, unwrapNode })
    const rogue = /** @type {any} */ (window).rogue
    try {
      expect(rogue.render()).toBe('') // CRDT starts empty

      // attachRogue: beginLoad, then mode.set('readonly') mutates body attrs.
      node.beginLoad()
      el.setAttribute('contenteditable', 'false')
      await flush()
      expect(rogue.render()).toBe('') // must not absorb the empty editor

      // onReady: endLoad (forceFullRender), then mode.set('design').
      node.endLoad()
      await flush()
      el.setAttribute('contenteditable', 'true')
      await flush()

      expect(rogue.render()).toBe('') // still empty — no chrome leaked
    } finally {
      node.destroy()
      el.remove()
    }
  })
})
