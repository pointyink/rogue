// @ts-check
import { describe, it, expect } from 'vitest'
import { createHeadlessEditor, roundTripHtml, parse5ValidHtml } from './headless.js'
import { validHtml } from './sync.js'

describe('parse5ValidHtml', () => {
  // The headless replica swaps the native (jsdom) round-trip for parse5, which
  // jsdom is itself built on. These shapes must agree or the swap changes which
  // ops are accepted.
  const shapes = [
    '<p>hello</p>',
    '<p>hello</p><p>world</p>',
    '<p>a<b>c</b>d</p>',
    '<ul><li>one</li><li>two</li></ul>',
    '<table><tbody><tr><td>x</td><td>y</td></tr></tbody></table>',
    '<p>a&nbsp;b</p>',
    '<p>a&amp;b</p>',
    '<p>a&lt;b&gt;</p>',
    '<p><br></p>',
    '<h1>title</h1><p>body</p>',
    '<svg><path d="M0 0"/></svg>',
    '<div>',
    '</p>',
    '<p><div>h</div></p>',
    '<p><p>h</p></p>',
    '<p>h</p></p>',
    '<b>h</p>',
    '<td>x</td>', // invalid in a bare <div> context
  ]

  it('agrees with the native (jsdom) validHtml on editor-emitted shapes', () => {
    for (const html of shapes) {
      expect(parse5ValidHtml(html), html).toBe(validHtml(html))
    }
  })

  it('agrees in table contexts', () => {
    const tr = document.createElement('tr')
    const tbody = document.createElement('tbody')
    /** @type {[string, Element][]} */
    const cases = [
      ['<td>x</td>', tr],
      ['<td>x</td>', tbody],
      ['<tr><td>x</td></tr>', tbody],
    ]
    for (const [html, ctx] of cases) {
      expect(parse5ValidHtml(html, ctx), html).toBe(validHtml(html, ctx))
    }
  })

  it('agrees in foreign and integration-point contexts', () => {
    const SVG = 'http://www.w3.org/2000/svg'
    const MATHML = 'http://www.w3.org/1998/Math/MathML'
    const foreign = document.createElementNS(SVG, 'foreignObject')
    const ann = document.createElementNS(MATHML, 'annotation-xml')
    ann.setAttribute('encoding', 'text/html')
    /** @type {[string, Element][]} */
    const cases = [
      ['<td>x</td>', foreign],
      ['<annotation-xml><p>x</p></annotation-xml>', foreign],
      ['<p>x</p>', ann],
      ['<math><mi>x</mi></math>', ann],
    ]
    for (const [html, ctx] of cases) {
      expect(parse5ValidHtml(html, ctx), html).toBe(validHtml(html, ctx))
    }
  })

  it('agrees in raw-text contexts', () => {
    for (const tag of ['script', 'style', 'noscript']) {
      const ctx = document.createElement(tag)
      for (const html of ['<p>x</p>', 'a & b', '']) {
        expect(parse5ValidHtml(html, ctx), `${tag}:${html}`).toBe(validHtml(html, ctx))
      }
    }
  })
})

describe('headless editor', () => {
  it('appends validated HTML and stays consistent', async () => {
    const ed = await createHeadlessEditor({ replicaId: 1 })
    try {
      const res = await ed.appendHtml('<p>Hello, agent</p>')
      expect(res.ok).toBe(true)
      expect(ed.getHtml()).toBe('<p>Hello, agent</p>')
      expect(ed.assertConsistent()).toEqual({ ok: true, crdt: '<p>Hello, agent</p>', dom: '<p>Hello, agent</p>' })
    } finally {
      ed.destroy()
    }
  })

  it('rejects HTML that does not round-trip (block-in-p)', async () => {
    const ed = await createHeadlessEditor({ replicaId: 1 })
    try {
      // <div> inside <p> auto-closes the paragraph — the browser mangles this.
      const res = await ed.appendHtml('<p>bad<div>nested</div></p>')
      expect(res.ok).toBe(false)
      expect(ed.getHtml()).toBe('') // nothing was committed
    } finally {
      ed.destroy()
    }
  })

  it('roundTripHtml reports the normalized form', async () => {
    const ed = await createHeadlessEditor({ replicaId: 1 })
    try {
      // access the ambient jsdom via a throwaway — validate is exposed on the editor.
      const check = ed.validate('<p>a<div>b</div>c</p>')
      expect(check.ok).toBe(false)
      expect(check.cleaned).not.toBe('<p>a<div>b</div>c</p>')
    } finally {
      ed.destroy()
    }
  })

  it('syncs edits between two replicas', async () => {
    const a = await createHeadlessEditor({ replicaId: 1 })
    const b = await createHeadlessEditor({ replicaId: 2 })
    try {
      a.subscribe((/** @type {Uint8Array} */ p) => b.mergeOp(p))
      b.subscribe((/** @type {Uint8Array} */ p) => a.mergeOp(p))

      await a.appendHtml('<p>from A</p>')
      expect(b.getHtml()).toBe('<p>from A</p>')

      await b.appendHtml('<p>from B</p>')
      expect(a.getHtml()).toBe('<p>from A</p><p>from B</p>')
      expect(b.assertConsistent().ok).toBe(true)
      expect(a.assertConsistent().ok).toBe(true)
    } finally {
      a.destroy()
      b.destroy()
    }
  })

  it('undo steps back through appended edits', async () => {
    const ed = await createHeadlessEditor({ replicaId: 1 })
    try {
      await ed.appendHtml('<p>one</p>')
      await ed.appendHtml('<p>two</p>')
      ed.undo()
      expect(ed.getHtml()).toBe('<p>one</p>')
      ed.undo()
      expect(ed.getHtml()).toBe('')
    } finally {
      ed.destroy()
    }
  })
})

describe('roundTripHtml', () => {
  it('accepts clean HTML as-is', () => {
    // jsdom is set up inside createHeadlessEditor; for a pure check use a throwaway dom
    const { JSDOM } = require('jsdom')
    const dom = new JSDOM('<!doctype html><html><body></body></html>')
    const r = roundTripHtml('<p><b>bold</b> text</p>', dom.window.document)
    expect(r.ok).toBe(true)
  })
})
