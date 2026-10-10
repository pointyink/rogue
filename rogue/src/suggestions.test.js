// @ts-check
import { describe, it, expect, vi } from 'vitest'
import { createSuggestions, resolveSuggestionAnchor } from './suggestions.js'
import { endOfDocPos } from './comments.js'
import { createRogueNode } from './sync.js'

const BASE_URL = '/api/docs/d1/suggestions'
const flush = () => new Promise((r) => setTimeout(r, 0))

/** @returns {{ fetchFn: import('./suggestions.js').SuggestionsOptions['fetchFn'], suggestions: any[], calls: any[] }} */
function mockServer() {
  /** @type {any[]} */
  let suggestions = []
  let next = 1
  /** @type {any[]} */
  const calls = []

  /** @param {any} data @param {number} [status] */
  const ok = (data, status = 200) => ({ ok: true, status, json: async () => data })

  /** @type {import('./suggestions.js').SuggestionsOptions['fetchFn']} */
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })

    const path = String(url).slice(BASE_URL.length)
    const id = path.split('/')[1]

    if (method === 'GET' && path === '') return ok(suggestions)
    if (method === 'POST' && path === '') {
      const sg = {
        id: String(next++), author_id: 'me',
        start_id: body.start_id, end_id: body.end_id, replacement: body.replacement,
        status: 'open', created_at: '', updated_at: '',
      }
      suggestions.push(sg)
      return ok(sg, 201)
    }
    if (method === 'POST' && path.endsWith('/accept')) {
      const sg = suggestions.find((x) => x.id === id)
      sg.status = 'accepted'
      return ok(sg)
    }
    if (method === 'DELETE') {
      suggestions = suggestions.filter((x) => x.id !== id)
      return ok(null, 204)
    }
    return ok({}, 404)
  }

  return { fetchFn, get suggestions() { return suggestions }, calls }
}

/** A fake annotation surface that always resolves. */
function fakeSurface() {
  return {
    crdt: {
      visIxOf: () => 0,
      idAtVisIx: () => '1:1',
      nextVisId: () => null,
      prevVisId: () => null,
      visLen: () => 5,
    },
    rope: {
      visIxToDomPos: () => ({ node: document.createElement('div'), offset: 0 }),
      domPosToVisIx: (/** @type {Node} */ _node, /** @type {number} */ offset) => offset,
      getAtVisIx: () => null,
    },
  }
}

/** Create a live node with the given HTML content.
 *  @param {string} [html] */
async function makeNode(html) {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  const node = await createRogueNode({ element: el })
  if (html) {
    el.innerHTML = html
    await flush()
  }
  return { el, node }
}

describe('createSuggestions', () => {
  it('creates, lists, and rejects over REST', async () => {
    const server = mockServer()
    const { crdt, rope } = fakeSurface()
    const pos = document.createElement('div')
    const api = createSuggestions({
      crdt, rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      getSelectionRange: () => ({ startNode: pos, startOffset: 0, endNode: pos, endOffset: 1 }),
    })

    expect(await api.load()).toHaveLength(0)

    await api.create('new text')
    expect(server.suggestions).toHaveLength(1)
    const create = server.calls.find((c) => c.method === 'POST' && !c.url.endsWith('/accept'))
    expect(create.body).toEqual({ start_id: '1:1', end_id: '1:1', replacement: 'new text' })

    const id = server.suggestions[0].id
    await api.reject(id)
    expect(server.suggestions).toHaveLength(0)
  })

  it('accept applies the replacement as a DOM edit, then posts accept', async () => {
    const { el, node } = await makeNode('hello world')
    const server = mockServer()
    const markUserEdit = vi.fn()

    // Anchor a suggestion to "hello" (vis 0..4) — create() reads it from the
    // (mocked) current selection.
    const startPos = node.rope.visIxToDomPos(0)
    const endPos = node.rope.visIxToDomPos(5)
    if (!startPos || !endPos) throw new Error('expected positions')
    const api = createSuggestions({
      crdt: node.crdt, rope: node.rope, baseUrl: BASE_URL, fetchFn: server.fetchFn, markUserEdit,
      getSelectionRange: () => ({ startNode: startPos.node, startOffset: startPos.offset, endNode: endPos.node, endOffset: endPos.offset }),
    })

    await api.create('goodbye')
    const id = server.suggestions[0].id

    await api.accept(id)
    await flush()
    expect(markUserEdit).toHaveBeenCalled()
    expect(el.textContent).toBe('goodbye world')
    expect(server.suggestions[0].status).toBe('accepted')
  })

  it('accept applies a boundary-crossing replacement via the browser', async () => {
    const { el, node } = await makeNode('<p>one <b>two</b> three</p>')
    const server = mockServer()

    // Anchor to "two three" (vis 10..22) spanning the </b> boundary.
    const startPos = node.rope.visIxToDomPos(10)
    const endPos = node.rope.visIxToDomPos(23)
    if (!startPos || !endPos) throw new Error('expected positions')
    const api = createSuggestions({
      crdt: node.crdt, rope: node.rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      getSelectionRange: () => ({ startNode: startPos.node, startOffset: startPos.offset, endNode: endPos.node, endOffset: endPos.offset }),
    })

    await api.create('xyz')
    const id = server.suggestions[0].id

    await api.accept(id)
    await flush()
    expect(el.textContent).toBe('one xyz')
    expect(server.suggestions[0].status).toBe('accepted')
  })

  it('accept aborts without posting when the span is stale', async () => {
    const server = mockServer()
    const { crdt, rope } = fakeSurface()
    const staleCrdt = {
      ...crdt,
      visIxOf: () => null,
      nextVisId: () => null,
      prevVisId: () => null,
    }
    const pos = document.createElement('div')
    const api = createSuggestions({
      crdt: staleCrdt, rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      getSelectionRange: () => ({ startNode: pos, startOffset: 0, endNode: pos, endOffset: 1 }),
    })

    await api.create('rewritten')
    const id = server.suggestions[0].id

    await expect(api.accept(id)).rejects.toThrow(/stale/)
    // No accept POST was made, and the suggestion stays open.
    expect(server.calls.filter((c) => c.url.endsWith('/accept'))).toHaveLength(0)
    expect(server.suggestions[0].status).toBe('open')
  })

  it('accept resets the undo frontier mid-undo-chain', async () => {
    const { el, node } = await makeNode()
    const type = async (/** @type {string} */ html) => { el.innerHTML = html; await flush() }

    await type('one')
    await type('one two')
    node.undo() // revert ' two' → 'one'; the undo cursor is now mid-chain
    expect(el.textContent).toBe('one')

    const server = mockServer()
    const startPos = node.rope.visIxToDomPos(0)
    const endPos = endOfDocPos(node.rope, node.crdt.visLen())
    if (!startPos || !endPos) throw new Error('expected positions')
    const api = createSuggestions({
      crdt: node.crdt, rope: node.rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      markUserEdit: () => node.markUserEdit(),
      getSelectionRange: () => ({ startNode: startPos.node, startOffset: startPos.offset, endNode: endPos.node, endOffset: endPos.offset }),
    })

    await api.create('three')
    const id = server.suggestions[0].id

    await api.accept(id)
    await flush()
    expect(el.textContent).toBe('three')

    // Undo must revert the accept — not re-revert the already-undone ' two'.
    node.undo()
    expect(el.textContent).toBe('one')

    // Redo re-applies the accept.
    node.redo()
    expect(el.textContent).toBe('three')
  })
})

describe('resolveSuggestionAnchor', () => {
  it('steps inward when a boundary id is hidden (fencepost)', () => {
    /** @type {import('./comments.js').CrdtSurface} */
    const crdt = {
      // start_id '1:1' hidden → nextVisId gives '1:2'; end_id '1:4' visible at 3.
      visIxOf: (id) => (id === '1:2' ? 1 : id === '1:4' ? 3 : null),
      idAtVisIx: () => '1:1',
      nextVisId: (id) => (id === '1:1' ? '1:2' : null),
      prevVisId: () => null,
      visLen: () => 5,
    }
    /** @type {import('./comments.js').RopeSurface} */
    const rope = {
      visIxToDomPos: (ix) => ({ node: document.createElement('div'), offset: ix }),
      domPosToVisIx: () => 0,
      getAtVisIx: () => null,
    }
    const range = resolveSuggestionAnchor(crdt, rope, '1:1', '1:4')
    if (!range) throw new Error('expected a range')
    expect(range.startOffset).toBe(1) // fell back to nextVisId('1:1')
    expect(range.endOffset).toBe(4) // end_id visible at 3 → e+1 = 4
  })
})
