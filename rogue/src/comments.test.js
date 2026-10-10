// @ts-check
import { describe, it, expect } from 'vitest'
import { createRogueNode } from './sync.js'
import { createComments, resolveAnchor, anchorForRange } from './comments.js'

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Create a live node, then (optionally) type content into it.
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

/** @param {{ startNode: Node, startOffset: number, endNode: Node, endOffset: number }} range */
function textOf(range) {
  const r = document.createRange()
  r.setStart(range.startNode, range.startOffset)
  r.setEnd(range.endNode, range.endOffset)
  return r.toString()
}

describe('anchor resolution', () => {
  it('round-trips a node-id anchor to a DOM range and back', async () => {
    const { node } = await makeNode('hello world')
    const startId = node.crdt.idAtVisIx(0)
    const endId = node.crdt.idAtVisIx(4)
    if (!startId || !endId) throw new Error('expected ids')

    const range = resolveAnchor(node.crdt, node.rope, startId, endId)
    expect(range).not.toBeNull()
    if (!range) throw new Error('expected a range')
    expect(textOf(range)).toBe('hello')
    expect(anchorForRange(node.crdt, node.rope, range)).toEqual({ start_id: startId, end_id: endId })
  })

  it('resolves an anchor at the end of the document', async () => {
    const { node } = await makeNode('hello world')
    const startId = node.crdt.idAtVisIx(6)
    const endId = node.crdt.idAtVisIx(10) // "world"
    if (!startId || !endId) throw new Error('expected ids')
    const range = resolveAnchor(node.crdt, node.rope, startId, endId)
    expect(range).not.toBeNull()
    if (!range) throw new Error('expected a range')
    expect(textOf(range)).toBe('world')
  })

  it('returns null for a stale (deleted) anchor', async () => {
    const { el, node } = await makeNode('hello world')
    const startId = node.crdt.idAtVisIx(0)
    const endId = node.crdt.idAtVisIx(10)
    if (!startId || !endId) throw new Error('expected ids')
    el.innerHTML = ''
    await flush()
    expect(resolveAnchor(node.crdt, node.rope, startId, endId)).toBeNull()
  })

  it('returns null for an empty selection', async () => {
    const { node } = await makeNode('abc')
    const pos = node.rope.visIxToDomPos(0)
    if (!pos) throw new Error('expected a position')
    const collapsed = {
      startNode: pos.node,
      startOffset: pos.offset,
      endNode: pos.node,
      endOffset: pos.offset,
    }
    expect(anchorForRange(node.crdt, node.rope, collapsed)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// REST flow, exercised against an in-memory mock server.
// ---------------------------------------------------------------------------

const BASE_URL = '/api/docs/d1/comments'

/** @returns {{ fetchFn: import('./comments.js').CommentsFetcher, comments: any[], calls: any[] }} */
function mockServer() {
  /** @type {any[]} */
  let comments = []
  let next = 1
  /** @type {any[]} */
  const calls = []

  /** @param {any} data @param {number} [status] */
  const ok = (data, status = 200) => ({ ok: true, status, json: async () => data })

  /** @type {import('./comments.js').CommentsFetcher} */
  const fetchFn = async (url, init = {}) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, url, body })

    const path = String(url).slice(BASE_URL.length)
    const id = path.split('/')[1]

    if (method === 'GET' && path === '') return ok(comments)
    if (method === 'POST' && path === '') {
      const c = {
        id: String(next++), doc_id: 'd1', author_id: 'me',
        start_id: body.start_id, end_id: body.end_id, message: body.message,
        resolved: false, created_at: '', updated_at: '', replies: [],
      }
      comments.push(c)
      return ok(c, 201)
    }
    if (method === 'POST' && path.endsWith('/replies')) {
      const c = comments.find((x) => x.id === id)
      const r = { id: String(next++), author_id: 'me', message: body.message, created_at: '' }
      c.replies.push(r)
      return ok(r, 201)
    }
    if (method === 'PATCH') {
      const c = comments.find((x) => x.id === id)
      if (body.message !== undefined) c.message = body.message
      if (body.resolved !== undefined) c.resolved = body.resolved
      return ok(c)
    }
    if (method === 'DELETE') {
      comments = comments.filter((x) => x.id !== id)
      return ok(null, 204)
    }
    return ok({}, 404)
  }

  return { fetchFn, get comments() { return comments }, calls }
}

/** A fake annotation surface that always resolves (REST tests don't care about
 *  the real range positions). */
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

describe('createComments', () => {
  it('loads, creates, replies, updates, resolves and removes over REST', async () => {
    const server = mockServer()
    /** @type {any[]} */
    let rendered = []
    const { crdt, rope } = fakeSurface()
    const api = createComments({
      crdt, rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      getSelectionRange: () => ({ startNode: document.createElement('div'), startOffset: 0, endNode: document.createElement('div'), endOffset: 1 }),
      rerender: (t) => { rendered = t },
    })

    const threads = await api.load()
    expect(threads).toHaveLength(0)

    await api.create('first comment')
    expect(server.comments).toHaveLength(1)
    expect(rendered).toHaveLength(1)
    expect(rendered[0].message).toBe('first comment')

    const id = server.comments[0].id
    await api.reply(id, 'a reply')
    expect(server.comments[0].replies).toHaveLength(1)

    await api.update(id, { message: 'edited' })
    expect(server.comments[0].message).toBe('edited')

    await api.update(id, { resolved: true })
    expect(server.comments[0].resolved).toBe(true)

    await api.remove(id)
    expect(server.comments).toHaveLength(0)
    expect(rendered).toHaveLength(0)
  })

  it('create anchors the current selection', async () => {
    const server = mockServer()
    const { crdt, rope } = fakeSurface()
    const pos = document.createElement('div')
    const api = createComments({
      crdt, rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      getSelectionRange: () => ({ startNode: pos, startOffset: 0, endNode: pos, endOffset: 1 }),
    })

    await api.create('anchored')
    const create = server.calls.find((c) => c.method === 'POST' && !c.url.endsWith('/replies'))
    expect(create.body).toEqual({ start_id: '1:1', end_id: '1:1', message: 'anchored' })
  })

  it('create rejects when there is no selection', async () => {
    const server = mockServer()
    const { crdt, rope } = fakeSurface()
    const api = createComments({
      crdt, rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      getSelectionRange: () => null,
    })

    await expect(api.create('orphan')).rejects.toThrow(/no text selected/)
    expect(server.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('handleDocumentChange re-emits without refetching', async () => {
    const server = mockServer()
    let emissions = 0
    const { crdt, rope } = fakeSurface()
    const api = createComments({
      crdt, rope, baseUrl: BASE_URL, fetchFn: server.fetchFn,
      rerender: () => { emissions++ },
    })

    await api.load()
    expect(emissions).toBe(1)

    api.handleDocumentChange({ minIx: 0, maxIx: 3 })
    expect(emissions).toBe(2)
    // No extra GET — document changes only re-resolve existing anchors.
    expect(server.calls.filter((c) => c.method === 'GET')).toHaveLength(1)
  })
})
