// @ts-check
import { describe, it, expect } from 'vitest'
import { createHeadlessEditor, roundTripHtml } from './headless.js'

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
