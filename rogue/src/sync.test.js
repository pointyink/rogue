// @ts-check
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createRogueNode, validHtml } from './sync.js'
import { buildRope } from './dom_rope.js'
import { mustBuildRope } from './test-helpers.js'
import * as multiOpV0 from '@pointyink/serde/multi_op_v0'
import * as insertV0 from '@pointyink/serde/insert_v0'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @returns {HTMLElement} */
function makeEditor() {
  const el = document.createElement('div')
  el.setAttribute('contenteditable', 'true')
  document.body.appendChild(el)
  return el
}

/** Let the engine's MutationObserver deliver + process pending mutations. */
const flush = () => new Promise((r) => setTimeout(r, 0))

/**
 * Simulate a user edit: mutate innerHTML, then let the observer sync.
 * @param {HTMLElement} el
 * @param {string} html
 */
async function type(el, html) {
  el.innerHTML = html
  await flush()
}

/**
 * IME: compositionstart → mutate innerHTML → compositionend, then flush. The
 * mid-composition mutation is deferred (observer bails while composing);
 * compositionend runs the sync.
 * @param {HTMLElement} el
 * @param {string} html
 */
async function compose(el, html) {
  el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
  el.innerHTML = html
  el.dispatchEvent(new Event('compositionend', { bubbles: true }))
  await flush()
}

/**
 * Fire a keydown event.
 * @param {HTMLElement} el
 * @param {string} key
 * @param {{ ctrlKey?: boolean, metaKey?: boolean, shiftKey?: boolean }} [mods]
 */
function keydown(el, key, mods = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', {
    key, bubbles: true, cancelable: true, ...mods,
  }))
}

/**
 * Fire a paste event with mock clipboard data.
 * @param {HTMLElement} el
 * @param {{ html?: string, plain?: string }} data
 */
function paste(el, { html = '', plain = '' }) {
  const clipboardData = { getData: vi.fn(type => type === 'text/html' ? html : plain) }
  const e = Object.assign(new Event('paste', { bubbles: true, cancelable: true }), {
    clipboardData,
    preventDefault: vi.fn(),
  })
  el.dispatchEvent(e)
  return e
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('validHtml', () => {
  it('accepts valid, balanced HTML', () => {
    expect(validHtml('<p>hello</p>')).toBe(true)
    expect(validHtml('<p>hello</p><p>world</p>')).toBe(true)
    expect(validHtml('<p>a<b>c</b>d</p>')).toBe(true)
  })

  it('rejects nested block tags (auto-closed by the browser)', () => {
    expect(validHtml('<p><p>h</p></p>')).toBe(false)
    expect(validHtml('<p><div>h</div></p>')).toBe(false)
  })

  it('rejects unbalanced / stray closing tags', () => {
    expect(validHtml('<p>h</p></p>')).toBe(false)
    expect(validHtml('<b>h</p>')).toBe(false)
  })

  it('drops table internals outside a table context (a bare <div> drops <td>/<tr>)', () => {
    expect(validHtml('<td>x</td>')).toBe(false)
    expect(validHtml('<tr><td>x</td></tr>')).toBe(false)
    expect(validHtml('<li>x</li>')).toBe(true) // <li> is valid in-body
  })

  it('keeps table internals in their real context', () => {
    const tr = document.createElement('tr')
    const tbody = document.createElement('tbody')
    expect(validHtml('<td>x</td>', tr)).toBe(true)
    expect(validHtml('<tr><td>x</td></tr>', tbody)).toBe(true)
  })

  it('accepts escaped text (nbsp / amp / lt / gt)', () => {
    expect(validHtml('<p>a&nbsp;b</p>')).toBe(true)
    expect(validHtml('<p>a&amp;b</p>')).toBe(true)
    expect(validHtml('<p>a&lt;b&gt;</p>')).toBe(true)
  })
})

describe('createRogueNode', () => {

  // -------------------------------------------------------------------------
  // Initial state
  // -------------------------------------------------------------------------

  describe('initial state', () => {
    it('renders empty HTML on creation', async () => {
      const el = makeEditor()
      await createRogueNode({ element: el })
      expect(el.innerHTML).toBe('')
    })
  })

  // -------------------------------------------------------------------------
  // maxOpBytes — oversized edits are rejected + reverted
  // -------------------------------------------------------------------------

  describe('maxOpBytes', () => {
    it('rejects an oversized edit, fires onOpTooLarge, and reverts the DOM', async () => {
      const el = makeEditor()
      /** @type {Array<[number, number]>} */
      const rejected = []
      const node = await createRogueNode({
        element: el,
        maxOpBytes: 100,
        onOpTooLarge: (bytes, limit) => rejected.push([bytes, limit]),
      })

      await type(el, '<p>ok</p>')
      expect(el.innerHTML).toBe('<p>ok</p>')

      await type(el, '<p>' + 'x'.repeat(200) + '</p>')
      expect(rejected).toHaveLength(1)
      expect(rejected[0][1]).toBe(100)
      expect(el.innerHTML).toBe('<p>ok</p>') // reverted to the committed CRDT
      expect(node.mergeOp).toBeTypeOf('function')
    })

    it('lets edits under the cap through', async () => {
      const el = makeEditor()
      /** @type {Array<[number, number]>} */
      const rejected = []
      await createRogueNode({
        element: el,
        maxOpBytes: 1000,
        onOpTooLarge: (bytes, limit) => rejected.push([bytes, limit]),
      })

      await type(el, '<p>' + 'x'.repeat(200) + '</p>')
      expect(rejected).toHaveLength(0)
      expect(el.innerHTML).toBe('<p>' + 'x'.repeat(200) + '</p>')
    })
  })

  // -------------------------------------------------------------------------
  // localSync — typing
  // -------------------------------------------------------------------------

  describe('typing (localSync)', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {import('./sync.js').RogueNode} */
    let node
    /** @type {Uint8Array[]} */
    let ops

    beforeEach(async () => {
      el = makeEditor()
      ops = []
      node = await createRogueNode({ element: el, onCommit(p) { ops.push(p) } })
    })

    it('plain text survives a sync round-trip', async () => {
      await type(el, 'hello')
      expect(el.innerHTML).toBe('hello')
    })

    it('onCommit fires after a content change', async () => {
      await type(el, 'hello')
      expect(ops).toHaveLength(1)
    })

    it('onCommit payload is multi_op_v0 binary (starts with non-zero group_id)', async () => {
      await type(el, 'hello')
      const payload = ops[0]
      expect(payload).toBeInstanceOf(Uint8Array)
      // multi_op_v0 layout: first 6 bytes = group_id (node_id_v0). The replica
      // is randomly assigned per node but always non-zero (see sync.js init).
      expect(payload.byteLength).toBeGreaterThanOrEqual(10)
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
      const replicaId = view.getUint16(0, true)
      expect(replicaId).toBeGreaterThan(0)
    })

    it('onCommit does not fire when content is unchanged', async () => {
      await type(el, 'hello')
      const before = ops.length
      await type(el, 'hello') // same content
      expect(ops.length).toBe(before)
    })

    it('multiple sequential edits each fire onCommit', async () => {
      await type(el, 'hello')
      await type(el, 'hello world')
      expect(ops).toHaveLength(2)
    })

    it('deletion syncs correctly', async () => {
      await type(el, 'hello world')
      await type(el, 'hello')
      expect(el.innerHTML).toBe('hello')
    })

    it('replacing all content syncs correctly', async () => {
      await type(el, 'foo')
      await type(el, 'bar')
      expect(el.innerHTML).toBe('bar')
    })

    it('clearing content syncs correctly', async () => {
      await type(el, 'something')
      await type(el, '')
      expect(el.innerHTML).toBe('')
    })

    // Regression: a scoped edit whose DOM text needs HTML-escaping (a trailing
    // space the browser serializes as &nbsp;, plus & and <). rangeOuterHtml must
    // escape text the same way the rope tokenizer does; a bare `.data` stored the
    // raw char and drifted the CRDT from the DOM (the "Hello&nbsp;" divergence).
    it('a scoped edit needing HTML-escaping (nbsp, &, <) stays consistent', async () => {
      const rogue = /** @type {any} */ (window).rogue
      node.setSyncDebug(true)
      await type(el, '<p>Hello</p>')
      // characterData edit on the existing text node — NOT a full innerHTML replace —
      // so it goes through the scoped diff (rangeOuterHtml), not the full-doc path.
      const t = /** @type {Text} */ (/** @type {HTMLElement} */ (el.querySelector('p')).firstChild)
      t.data = 'Hello & world <x> '
      await flush()
      expect(el.innerHTML).toBe('<p>Hello &amp; world &lt;x&gt;&nbsp;</p>')
      expect(rogue.render()).toBe(el.innerHTML)             // CRDT matches its DOM
      expect(rogue.rope().serialize()).toBe(el.innerHTML)   // rope matches its DOM
    })
  })

  describe('onChange', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {import('./sync.js').RogueNode} */
    let node
    /** @type {({ minIx: number, maxIx: number } | null)[]} */
    let changes

    beforeEach(async () => {
      el = makeEditor()
      changes = []
      node = await createRogueNode({ element: el, onChange(r) { changes.push(r) } })
    })

    it('fires with the affected range after a local edit', async () => {
      await type(el, 'hello')
      expect(changes).toHaveLength(1)
      expect(changes[0]).toEqual({ minIx: 0, maxIx: 5 })
    })

    it('does not fire when content is unchanged', async () => {
      await type(el, 'hello')
      const before = changes.length
      await type(el, 'hello')
      expect(changes.length).toBe(before)
    })

    it('fires after a remote op via mergeOp', async () => {
      const el2 = makeEditor()
      const onCommit = (/** @type {Uint8Array} */ p) => node.mergeOp(p)
      await createRogueNode({ element: el2, onCommit })
      await type(el2, 'hi')
      expect(changes.length).toBeGreaterThan(0)
      expect(changes[changes.length - 1]).not.toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // Observer scope (localRegion) — sync driven by *where* the DOM
  // changed, not the selection. This is what lets us catch host-engine
  // mutations (e.g. TinyMCE's delayed normalization) that fire no `input` and
  // leave the selection elsewhere — the reappearing-delete bug.
  // -------------------------------------------------------------------------

  describe('observer-scoped sync', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {Uint8Array[]} */
    let ops

    beforeEach(async () => {
      el = makeEditor()
      ops = []
      await createRogueNode({ element: el, onCommit(p) { ops.push(p) } })
    })

    /** @returns {string} CRDT truth (what a rerender would paint). */
    const render = () => /** @type {any} */ (window).rogue.render()

    it('a node removal with no input event and no selection change still syncs', async () => {
      await type(el, '<p>a</p><p>b</p><p>c</p>')
      // Collapse the selection somewhere unrelated to the edit (start of doc),
      // then remove the middle block the way a host engine would — directly,
      // without firing `input`. A selection-scoped sync would look at <p>a</p>
      // and miss this; the mutation records point us at the real region.
      const sel = window.getSelection()
      const r = document.createRange()
      r.selectNodeContents(el.firstChild ?? el)
      r.collapse(true)
      sel?.removeAllRanges()
      sel?.addRange(r)

      el.children[1].remove() // drop <p>b</p>
      await flush()

      expect(el.innerHTML).toBe('<p>a</p><p>c</p>')
      expect(render()).toBe(el.innerHTML) // CRDT converged — 'b' is gone for good
    })

    it('deleted content does not reappear after a delayed engine mutation', async () => {
      await type(el, '<p>keep</p><p>drop</p>')
      el.children[1].remove() // engine removes the paragraph, no input
      await flush()
      // A rerender from CRDT truth must not repaint the removed paragraph.
      expect(render()).toBe('<p>keep</p>')
      expect(el.innerHTML).toBe('<p>keep</p>')
    })

    it('an attribute change on existing content emits one scoped edit', async () => {
      await type(el, '<p>hi</p>')
      const before = ops.length
      // Real (non-internal) attribute edits still flow through: the clean DOM
      // now differs from the clean CRDT, so the observer picks it up.
      el.children[0].setAttribute('title', 'x')
      await flush()
      expect(el.innerHTML).toBe('<p title="x">hi</p>')
      expect(render()).toBe(el.innerHTML)
      expect(ops.length).toBe(before + 1)
    })
    it('formatting tags converge via a scoped diff (wrap-in-place)', async () => {
      await type(el, '<p>hello world</p>')
      const before = ops.length
      // Bold the word "hello" — the DOM now has <b> tags.
      await type(el, '<p><b>hello</b> world</p>')
      // CRDT must converge to the same HTML.
      expect(render()).toBe(el.innerHTML)
      expect(ops.length).toBe(before + 1)
    })

    it('text-only change inside tags uses a DMP diff', async () => {
      await type(el, '<p><b>hello</b> world</p>')
      const before = ops.length
      // Delete one 'l' — text change only, no tag structure change.
      await type(el, '<p><b>helo</b> world</p>')
      expect(render()).toBe(el.innerHTML)
      // Should still emit an op (DMP diff).
      expect(ops.length).toBe(before + 1)
    })

    it('adding bold inside existing text converges', async () => {
      await type(el, '<p>hello world</p>')
      const before = ops.length
      // Bold "world" — tag structure changes.
      await type(el, '<p>hello <b>world</b></p>')
      expect(render()).toBe(el.innerHTML)
      expect(ops.length).toBe(before + 1)
    })
  })

  // -------------------------------------------------------------------------
  // Clean-rope filter: a host serializeNode hook that strips its internal
  // attribute namespace means those attributes never reach the CRDT, and
  // toggling them produces zero ops (the observer's clean diff is empty).
  // -------------------------------------------------------------------------

  describe('clean serializeNode hook', () => {
    /** Strip a reserved internal namespace (like TinyMCE's data-mce-*). */
    const stripInternal = (/** @type {Node} */ node) => {
      const el = /** @type {Element} */ (node)
      if (el.nodeType === 1) {
        for (const name of el.getAttributeNames?.() ?? []) {
          if (name.startsWith('data-mce-')) el.removeAttribute(name)
        }
        for (const desc of el.querySelectorAll?.('*') ?? []) {
          for (const name of desc.getAttributeNames()) {
            if (name.startsWith('data-mce-')) desc.removeAttribute(name)
          }
        }
      }
      return el.nodeType === 1 ? el.outerHTML : /** @type {Text} */ (node).data
    }

    it('internal attributes never enter the CRDT', async () => {
      const el = makeEditor()
      const ops = /** @type {Uint8Array[]} */ ([])
      await createRogueNode({ element: el, serializeNode: stripInternal, onCommit(p) { ops.push(p) } })

      await type(el, '<p data-mce-bogus="1">hi</p>')
      expect(/** @type {any} */ (window).rogue.render()).toBe('<p>hi</p>')
    })

    it('toggling an internal attribute produces zero ops', async () => {
      const el = makeEditor()
      const ops = /** @type {Uint8Array[]} */ ([])
      await createRogueNode({ element: el, serializeNode: stripInternal, onCommit(p) { ops.push(p) } })

      await type(el, '<p>hi</p>')
      const before = ops.length
      el.children[0].setAttribute('data-mce-selected', '1') // pure engine noise
      await flush()
      expect(ops.length).toBe(before) // clean diff is empty → no op
    })
  })

  // -------------------------------------------------------------------------
  // Chrome strip: omitNode omits editing-chrome nodes, serializeNode cleans attrs
  // -------------------------------------------------------------------------

  describe('chrome strip (omitNode + serializeNode)', () => {
    // Mirrors the TinyMCE plugin's hooks.
    const omitNode = (/** @type {Node} */ node) =>
      node.nodeType === 1 &&
      /** @type {Element} */ (node).getAttribute('data-mce-bogus') === 'all'
    const serializeNode = (/** @type {Node} */ node) => {
      if (node.nodeType !== 1) return /** @type {Text} */ (node).data
      const el = /** @type {Element} */ (node)
      for (const b of el.querySelectorAll('[data-mce-bogus="all"]')) b.remove()
      const strip = (/** @type {Element} */ e) => {
        for (const name of e.getAttributeNames()) {
          if (name.startsWith('data-mce-')) e.removeAttribute(name)
        }
      }
      strip(el)
      for (const d of el.querySelectorAll('*')) strip(d)
      return el.outerHTML
    }

    it('omits top-level chrome nodes and strips data-mce attributes', async () => {
      const el = makeEditor()
      await createRogueNode({ element: el, serializeNode, omitNode })
      await type(el, '<p data-mce-selected="1">hi</p><div data-mce-bogus="all" class="mce-resizehandle" style="left:5px"></div>')
      expect(/** @type {any} */ (window).rogue.render()).toBe('<p>hi</p>')
    })

    it('drops a nested bogus chrome node (fake caret) too', async () => {
      const el = makeEditor()
      await createRogueNode({ element: el, serializeNode, omitNode })
      await type(el, '<p>a<span data-mce-bogus="all">​</span>b</p>')
      expect(/** @type {any} */ (window).rogue.render()).toBe('<p>ab</p>')
    })

    it('a chrome node appearing/moving after load produces no op', async () => {
      const el = makeEditor()
      const ops = /** @type {Uint8Array[]} */ ([])
      await createRogueNode({ element: el, serializeNode, omitNode, onCommit(p) { ops.push(p) } })
      await type(el, '<p>content</p>')
      const before = ops.length
      // TinyMCE appends a resize handle, then repositions it.
      const handle = document.createElement('div')
      handle.setAttribute('data-mce-bogus', 'all')
      handle.className = 'mce-resizehandle'
      el.appendChild(handle)
      await flush()
      handle.setAttribute('style', 'left: 9px')
      await flush()
      expect(ops.length).toBe(before) // chrome is invisible to the CRDT
      expect(/** @type {any} */ (window).rogue.render()).toBe('<p>content</p>')
    })
  })

  // -------------------------------------------------------------------------
  // Scoped-range alignment at the trailing edge
  // -------------------------------------------------------------------------

  describe('trailing-edge scoped sync', () => {
    it('does not duplicate trailing content when a null-endEl range resolves', async () => {
      const el = makeEditor()
      await createRogueNode({ element: el })
      const rogue = /** @type {any} */ (window).rogue

      // Baseline: a block + a trailing sibling, both tracked in rope + CRDT.
      await type(el, '<p>a</p><p>x</p>')
      expect(rogue.render()).toBe('<p>a</p><p>x</p>')

      // Churn: replace the trailing block with a fresh-identity node of identical
      // content. The full-doc sync early-returns (content unchanged) without
      // rebuilding the rope, so the new node is untracked while the CRDT still
      // holds the trailing block — the exact state TinyMCE's resize chrome creates.
      const fresh = document.createElement('p')
      fresh.textContent = 'x'
      el.children[1].replaceWith(fresh)
      await flush()

      // Edit the *first* block. Its now-untracked next sibling makes findRange
      // resolve a null endEl; the scoped diff must reconcile against the true CRDT
      // edge, not re-insert the already-present trailing block.
      const text = /** @type {Text} */ (el.children[0].firstChild)
      text.data = 'ab'
      await flush()

      expect(rogue.render()).toBe('<p>ab</p><p>x</p>')
    })
  })

  // -------------------------------------------------------------------------
  // mergeOp — remote updates
  // -------------------------------------------------------------------------

  describe('mergeOp', () => {
    /** @type {HTMLElement} */
    let el1
    /** @type {HTMLElement} */
    let el2
    /** @type {import('./sync.js').RogueNode} */
    let node1
    /** @type {import('./sync.js').RogueNode} */
    let node2

    beforeEach(async () => {
      el1 = makeEditor()
      el2 = makeEditor()
      let pendingOp = /** @type {Uint8Array | null} */ (null)
      node1 = await createRogueNode({ element: el1, onCommit(p) { pendingOp = p } })
      node2 = await createRogueNode({ element: el2 })
      // wire node1 → node2 for convenience in each test
      node1 = await (async () => {
        const ops = /** @type {Uint8Array[]} */ ([])
        node1 = await createRogueNode({
          element: el1,
          onCommit(p) { ops.push(p); node2.mergeOp(p) },
        })
        return node1
      })()
    })

    // Regression: opSync renders the pre-op *inner* ids, so on a scoped
    // op the receiver's CRDT/rope can drift from its DOM even when the DOM looks
    // right (the rope≠dom seen on reload). So we check the receiver's render +
    // rope against its DOM, not just el2 === el1.
    it('replaying a middle insert keeps the receiver rope + CRDT consistent', async () => {
      el1 = makeEditor()
      el2 = makeEditor()
      node2 = await createRogueNode({ element: el2 })
      const rogue2 = /** @type {any} */ (window).rogue // node2's debug API (before node1 overwrites it)
      node2.setSyncDebug(true)
      node1 = await createRogueNode({ element: el1, onCommit(p) { node2.mergeOp(p) } })

      await type(el1, '<p>hello world!</p><table><tbody><tr><td>x</td><td>y</td></tr></tbody></table><p>end</p>')
      const td = /** @type {HTMLElement} */ (el1.querySelector('td'))
      for (const s of ['t', 'th', 'thi', 'this', 'this ', 'this is', 'this is a']) {
        td.textContent = s
        await flush()
      }

      expect(el2.innerHTML).toBe(el1.innerHTML)             // DOM converged
      expect(rogue2.render()).toBe(el2.innerHTML)           // receiver CRDT matches its DOM
      expect(rogue2.rope().serialize()).toBe(el2.innerHTML) // receiver rope matches its DOM
    })

    it('two nodes converge: type on node1, node2 receives the update', async () => {
      el1 = makeEditor()
      el2 = makeEditor()
      node2 = await createRogueNode({ element: el2 })
      node1 = await createRogueNode({
        element: el1,
        onCommit(p) { node2.mergeOp(p) },
      })

      await type(el1, 'hello from node1')
      expect(el2.innerHTML).toBe(el1.innerHTML)
    })

    it('mergeOp updates innerHTML', async () => {
      el1 = makeEditor()
      el2 = makeEditor()
      let op = /** @type {Uint8Array} */ (new Uint8Array())
      node1 = await createRogueNode({ element: el1, onCommit(p) { op = p } })
      node2 = await createRogueNode({ element: el2 })

      await type(el1, 'synced text')
      node2.mergeOp(op)

      expect(el2.innerHTML).toBe('synced text')
    })

    it('multiple ops sync in sequence', async () => {
      el1 = makeEditor()
      el2 = makeEditor()
      const pendingOps = /** @type {Uint8Array[]} */ ([])
      node1 = await createRogueNode({ element: el1, onCommit(p) { pendingOps.push(p) } })
      node2 = await createRogueNode({ element: el2 })

      await type(el1, 'first')
      await type(el1, 'first second')
      for (const op of pendingOps) node2.mergeOp(op)

      expect(el2.innerHTML).toBe(el1.innerHTML)
    })
  })

  // -------------------------------------------------------------------------
  // Structural round-trip rejection — an incoming op that inserts/hides/shows
  // tag chars is round-trip-checked (scoped to its block) and rejected if the
  // browser would mangle it.
  // -------------------------------------------------------------------------

  describe('structural round-trip rejection', () => {
    /** Build a single-insert multi_op_v0 payload.
     *  @param {number} replica @param {number} seq @param {number} side @param {number[]} chars */
    function insertPayload(replica, seq, side, chars) {
      const ins = insertV0.encode(
        { replica_id: replica, sequence: seq },
        { replica_id: 0, sequence: 0 },
        side,
        chars,
      )
      return multiOpV0.encode(
        { replica_id: replica, sequence: seq },
        [{ disc: insertV0.DISC, payload: ins }],
      )
    }

    it('rejects a structural op that breaks the DOM round-trip (unbalanced </p>)', async () => {
      const el = makeEditor()
      const node = await createRogueNode({ element: el })
      await type(el, '<p>h</p>')
      expect(el.innerHTML).toBe('<p>h</p>')

      // A lone "</p>" at the root renders "<p>h</p></p>"; the browser drops the
      // stray close, so the render round-trips to "<p>h</p>" → rejected.
      node.mergeOp(insertPayload(2, 100, insertV0.Side.Root, [0x3c, 0x2f, 0x70, 0x3e]))
      expect(el.innerHTML).toBe('<p>h</p>')
    })

    it('accepts a structural op that round-trips (complete inline <b>)', async () => {
      const el = makeEditor()
      const node = await createRogueNode({ element: el })
      await type(el, '<p>h</p>')

      // "<b>X</b>" is a balanced fragment — round-trips, so it's kept.
      node.mergeOp(insertPayload(2, 100, insertV0.Side.Root, [0x3c, 0x62, 0x3e, 0x58, 0x3c, 0x2f, 0x62, 0x3e]))
      expect(el.innerHTML).toBe('<p>h</p><b>X</b>')
    })
  })

  // -------------------------------------------------------------------------
  // Bootstrap buffering — during initial sync ops merge into the CRDT but don't
  // render; endLoad collapses them into a single innerHTML set.
  // -------------------------------------------------------------------------

  describe('bootstrap buffering', () => {
    it('defers DOM updates until endLoad, then renders once', async () => {
      const el1 = makeEditor()
      const el2 = makeEditor()
      const ops = /** @type {Uint8Array[]} */ ([])
      const node1 = await createRogueNode({ element: el1, onCommit: (p) => ops.push(p) })
      const node2 = await createRogueNode({ element: el2 })

      // Generate a multi-op history on node1 to replay as a bootstrap sync.
      await type(el1, 'alpha')
      await type(el1, 'alpha beta')
      await type(el1, '<p>alpha beta</p><p>gamma</p>')
      expect(ops.length).toBeGreaterThan(1)

      node2.beginLoad()
      for (const op of ops) node2.mergeOp(op)

      // No per-op render: the receiver's DOM is untouched during bootstrap.
      expect(el2.innerHTML).toBe('')

      node2.endLoad()

      // Single render at the end, converged with the source.
      expect(el2.innerHTML).toBe(el1.innerHTML)
    })

    it('renders ops immediately once bootstrap has ended', async () => {
      const el1 = makeEditor()
      const el2 = makeEditor()
      const ops = /** @type {Uint8Array[]} */ ([])
      const node1 = await createRogueNode({ element: el1, onCommit: (p) => ops.push(p) })
      const node2 = await createRogueNode({ element: el2 })

      await type(el1, 'first')
      node2.beginLoad()
      node2.mergeOp(ops[0])
      node2.endLoad()
      expect(el2.innerHTML).toBe('first')

      // A live op after endLoad renders right away, not buffered.
      await type(el1, 'first second')
      node2.mergeOp(ops[1])
      expect(el2.innerHTML).toBe('first second')
    })

    it('endLoad before beginLoad is a no-op', async () => {
      const el = makeEditor()
      const node = await createRogueNode({ element: el })
      node.endLoad()
      expect(el.innerHTML).toBe('')
    })

    // --- bootstrap load: validate once, walk back on failure -----------------
    //
    // The bootstrap merge validates nothing per op: endLoad renders once and, if
    // invalid, walks back to the last valid prefix, drops the boundary op, and
    // replays the tail through applyOp. A *persistently* bad op is therefore still
    // rejected exactly like streaming delivery (the walk-back finds it). An op that
    // is only invalid at its own prefix but valid in the final render is accepted —
    // the deliberate semantic documented in docs/plan-load-walkback.md.

    /** @param {string} html @returns {number[]} */
    const bytes = (html) => Array.from(new TextEncoder().encode(html))

    /** A root insert of raw HTML text, used to slip malformed ops into a log.
     *  @param {number} replica @param {number} seq @param {number[]} chars
     *  @returns {Uint8Array} */
    function rootInsert(replica, seq, chars) {
      const ins = insertV0.encode(
        { replica_id: replica, sequence: seq },
        { replica_id: 0, sequence: 0 },
        insertV0.Side.Root,
        chars,
      )
      return multiOpV0.encode(
        { replica_id: replica, sequence: seq },
        [{ disc: insertV0.DISC, payload: ins }],
      )
    }

    /** Build a single-replica op log from HTML snippets. Each insert consumes
     *  `len` sequence numbers, so they must be spaced or node ids collide.
     *  @param {string[]} htmls @returns {Uint8Array[]} */
    function makeLog(htmls) {
      let seq = 1
      return htmls.map((html) => {
        const chars = bytes(html)
        const p = rootInsert(2, seq, chars)
        seq += chars.length
        return p
      })
    }

    /** Merge `payloads` on a fresh node — buffered as a bootstrap load, or
     *  streamed one op at a time (live delivery).
     *  @param {Uint8Array[]} payloads @param {boolean} bootstrap
     *  @param {boolean} [reverse] @param {number} [replicaId] */
    async function renderLog(payloads, bootstrap, reverse = false, replicaId = 1) {
      const el = makeEditor()
      const node = await createRogueNode({ element: el, replicaId })
      const delivered = reverse ? [...payloads].reverse() : payloads
      if (bootstrap) {
        node.beginLoad()
        for (const p of delivered) node.mergeOp(p)
        node.endLoad()
      } else {
        for (const p of delivered) node.mergeOp(p)
      }
      return { el, node }
    }

    /** Assert a bootstrap load and a streamed delivery of the same log produce the
     *  same document; returns the resulting HTML.
     *  @param {string[]} htmls @param {boolean} [reverse] @returns {Promise<string>} */
    async function expectBootstrapMatchesStreamed(htmls, reverse = false) {
      const payloads = makeLog(htmls)
      const { el } = await renderLog(payloads, true, reverse)
      const { el: streamedEl } = await renderLog(payloads, false, reverse)
      expect(el.innerHTML).toBe(streamedEl.innerHTML)
      return el.innerHTML
    }

    it('matches streaming for a malformed op at each position', async () => {
      for (const badIndex of [0, 1, 2]) {
        const htmls = [0, 1, 2].map((i) => (i === badIndex ? '</p>' : `<p>${i + 1}</p>`))
        const html = await expectBootstrapMatchesStreamed(htmls)
        expect(validHtml(html)).toBe(true)
        expect(html).not.toContain('</p></p>')
        for (const i of [0, 1, 2].filter((i) => i !== badIndex)) {
          expect(html).toContain(`<p>${i + 1}</p>`)
        }
      }
    })

    it('matches streaming for a lone malformed op', async () => {
      expect(await expectBootstrapMatchesStreamed(['</p>'])).toBe('')
    })

    it('matches streaming for multiple malformed ops', async () => {
      const html = await expectBootstrapMatchesStreamed([
        '<p>1</p>', '</p>', '<p>3</p>', '</p>', '<p>5</p>',
      ])
      expect(validHtml(html)).toBe(true)
      for (const n of [1, 3, 5]) expect(html).toContain(`<p>${n}</p>`)
    })

    it('keeps a split-tag log whose full render is valid (documented semantic)', async () => {
      // <div> and </div> are invalid alone but valid together. Under the load
      // walk-back semantic (full render valid => accept) bootstrap keeps them;
      // live per-op delivery rejects both. Deliberate divergence — pinned here.
      const { el } = await renderLog(makeLog(['<div>', '</div>']), true)
      expect(el.innerHTML).toBe('<div></div>')
      expect(validHtml(el.innerHTML)).toBe(true)

      const { el: streamedEl } = await renderLog(makeLog(['<div>', '</div>']), false)
      expect(streamedEl.innerHTML).toBe('')
    })

    it('keeps a balanced inline fragment split across ops (documented semantic)', async () => {
      const { el } = await renderLog(makeLog(['<p>a</p>', '<b>', 'x', '</b>']), true)
      expect(el.innerHTML).toBe('<p>a</p><b>x</b>')
      expect(validHtml(el.innerHTML)).toBe(true)
    })

    it('walks back only the op that leaves the final render invalid', async () => {
      const { el } = await renderLog(
        makeLog(['<div>', '</div>', '<p>x', '</p>', '</p>']),
        true,
      )
      // The full render is invalid (stray </p>); walk back past it and keep the
      // aggregate-valid prefix.
      expect(el.innerHTML).toBe('<div></div><p>x</p>')
      expect(validHtml(el.innerHTML)).toBe(true)
    })

    it('converges when the buffered log arrives out of order', async () => {
      const htmls = ['<p>1</p>', '</p>', '<p>3</p>', '<p>4</p>']
      const forward = await expectBootstrapMatchesStreamed(htmls, false)
      const reverse = await expectBootstrapMatchesStreamed(htmls, true)
      expect(reverse).toBe(forward)
    })

    it('keeps applying live ops after a bootstrap that rejected a malformed op', async () => {
      const { el, node } = await renderLog(makeLog(['<p>1</p>', '</p>', '<p>3</p>']), true)
      expect(validHtml(el.innerHTML)).toBe(true)

      // A later live op (fresh replica, no seq collision) must merge + render.
      node.mergeOp(rootInsert(3, 1, bytes('<p>live</p>')))
      expect(el.innerHTML).toContain('<p>live</p>')
      expect(validHtml(el.innerHTML)).toBe(true)
    })

    it('renders a clean multi-op bootstrap and ignores an already-applied redelivery', async () => {
      const payloads = makeLog(['<p>a</p>', '<p>b</p>', '<p>c</p>'])
      const { el, node } = await renderLog(payloads, true)
      expect(el.innerHTML).toBe('<p>a</p><p>b</p><p>c</p>')
      node.mergeOp(payloads[0]) // already applied: no-op
      expect(el.innerHTML).toBe('<p>a</p><p>b</p><p>c</p>')
    })

    it('re-delivering an op the walk-back rejected is a no-op', async () => {
      const payloads = makeLog(['<p>1</p>', '</p>', '<p>3</p>'])
      const { el, node } = await renderLog(payloads, true)
      const afterLoad = el.innerHTML
      expect(validHtml(afterLoad)).toBe(true)
      // payloads[1] is the malformed op the recovery dropped.
      node.mergeOp(payloads[1])
      expect(el.innerHTML).toBe(afterLoad)
    })

    it('drains a parked op below the head after a clean load', async () => {
      /** @param {number} replica @param {number} seq @param {number|null} parentRep @param {number} parentSeq @param {string} html */
      const insert = (replica, seq, parentRep, parentSeq, html) => {
        const ins = insertV0.encode(
          { replica_id: replica, sequence: seq },
          parentRep === null
            ? { replica_id: 0, sequence: 0 }
            : { replica_id: parentRep, sequence: parentSeq },
          parentRep === null ? insertV0.Side.Root : insertV0.Side.Right,
          bytes(html),
        )
        return multiOpV0.encode(
          { replica_id: replica, sequence: seq },
          [{ disc: insertV0.DISC, payload: ins }],
        )
      }
      // Valid causality: P's seq (200) is above its parent Q's (100), and R/S
      // push the head past P so the drain has to insert it below the head.
      const Q = insert(1, 100, null, 0, '<p>q</p>') // "q" at seq 103
      const P = insert(2, 200, 1, 103, '<b>p</b>') // child of Q's "q"
      const R = insert(3, 500, null, 0, '<p>r</p>')
      const S = insert(4, 600, null, 0, '<p>s</p>') // live at-head op that drains P

      const el = makeEditor()
      const node = await createRogueNode({ element: el, replicaId: 9 })
      node.beginLoad()
      node.mergeOp(P) // parent Q absent -> parks
      node.mergeOp(Q) // at-head (the loading-time drain is gated)
      node.mergeOp(R) // at-head
      node.endLoad()
      // P is still parked after the load (endLoad does not drain).
      expect(el.innerHTML).toBe('<p>q</p><p>r</p>')
      node.mergeOp(S) // at-head; drains P below the head (P 200 < 600)
      expect(el.innerHTML).toContain('<b>p</b>')
      expect(validHtml(el.innerHTML)).toBe(true)
      expect(node.rope.serialize()).toBe(el.innerHTML)
    })

    it('applies a drained parked op in sorted order (a later out-of-order op keeps it)', async () => {
      /** @param {number} replica @param {number} seq @param {number|null} parentRep @param {number} parentSeq @param {string} html */
      const insert = (replica, seq, parentRep, parentSeq, html) => {
        const ins = insertV0.encode(
          { replica_id: replica, sequence: seq },
          parentRep === null
            ? { replica_id: 0, sequence: 0 }
            : { replica_id: parentRep, sequence: parentSeq },
          parentRep === null ? insertV0.Side.Root : insertV0.Side.Right,
          bytes(html),
        )
        return multiOpV0.encode(
          { replica_id: replica, sequence: seq },
          [{ disc: insertV0.DISC, payload: ins }],
        )
      }
      const Q = insert(1, 100, null, 0, '<p>q</p>') // "q" at 103
      const P = insert(2, 200, 1, 103, '<b>p</b>') // child of Q's "q"
      const R = insert(3, 500, null, 0, '<p>r</p>')
      const S = insert(4, 600, null, 0, '<p>s</p>') // drains P
      const F = insert(2, 300, null, 0, '<p>f</p>') // out-of-order again

      const el = makeEditor()
      const node = await createRogueNode({ element: el, replicaId: 9 })
      node.beginLoad()
      node.mergeOp(P) // parks
      node.mergeOp(R)
      node.mergeOp(Q)
      node.endLoad()
      node.mergeOp(S) // drains P below the head
      node.mergeOp(F) // F(300) < head(600) -> out-of-order; must not lose P
      expect(el.innerHTML).toContain('<b>p</b>')
      expect(validHtml(el.innerHTML)).toBe(true)
      expect(node.rope.serialize()).toBe(el.innerHTML)
    })

    it('does not drain during the recovery replay (parked op waits for the tail)', async () => {
      /** @param {number} replica @param {number} seq @param {number|null} parentRep @param {number} parentSeq @param {string} html */
      const insert = (replica, seq, parentRep, parentSeq, html) => {
        const ins = insertV0.encode(
          { replica_id: replica, sequence: seq },
          parentRep === null
            ? { replica_id: 0, sequence: 0 }
            : { replica_id: parentRep, sequence: parentSeq },
          parentRep === null ? insertV0.Side.Root : insertV0.Side.Right,
          bytes(html),
        )
        return multiOpV0.encode(
          { replica_id: replica, sequence: seq },
          [{ disc: insertV0.DISC, payload: ins }],
        )
      }
      const Q = insert(1, 100, null, 0, '<p>q</p>') // "q" at 103
      const P = insert(2, 1000, 1, 103, '<b>p</b>') // high seq, child of Q
      const DIRTY = insert(6, 200, null, 0, '</p>') // forces recovery
      const T1 = insert(3, 300, null, 0, '<p>t1</p>')
      const T2 = insert(4, 400, null, 0, '<p>t2</p>')
      const L = insert(5, 500, null, 0, '<p>l</p>')

      const el = makeEditor()
      const node = await createRogueNode({ element: el, replicaId: 9 })
      node.beginLoad()
      node.mergeOp(P) // parks
      node.mergeOp(Q)
      node.mergeOp(DIRTY) // unvalidated during load
      node.mergeOp(T1)
      node.mergeOp(T2)
      node.endLoad() // recovery drops DIRTY, then drains P after the tail
      node.mergeOp(L) // out-of-order; must not lose the recovered content
      for (const frag of ['<b>p</b>', '<p>t1</p>', '<p>t2</p>', '<p>l</p>']) {
        expect(el.innerHTML).toContain(frag)
      }
      expect(el.innerHTML).toContain('<p>q')
      expect(validHtml(el.innerHTML)).toBe(true)
      expect(node.rope.serialize()).toBe(el.innerHTML)
    })
  })

  // -------------------------------------------------------------------------
  // Remote ops during IME composition
  // While the IME owns the DOM (compositionstart → compositionend), the preedit
  // text isn't in the CRDT yet (input is suppressed). A remote op applied then
  // would re-render over the preedit and lose it, so remote ops are deferred and
  // drained when the composition releases. For normal keyboard typing there's
  // no such window — DOM mutation and `input` dispatch are one synchronous task.
  // -------------------------------------------------------------------------

  describe('remote ops during IME composition', () => {
    it('defers a remote op during composition and applies it after compositionend', async () => {
      const el1 = makeEditor()
      const el2 = makeEditor()
      let remoteOp = /** @type {any} */ (null)
      await createRogueNode({ element: el1, onCommit(p) { remoteOp = p } })

      const node2ops = /** @type {any[]} */ ([])
      const node2 = await createRogueNode({ element: el2, onCommit(p) { node2ops.push(p) } })

      // node1 makes an edit we'll deliver to node2 as a remote op.
      await type(el1, 'A')
      expect(remoteOp).not.toBeNull()

      // node2's user starts an IME composition: the preedit sits in the DOM but
      // is not yet synced into the CRDT (input suppressed while composing).
      el2.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el2.innerHTML = 'X'
      el2.dispatchEvent(new Event('input', { bubbles: true })) // suppressed

      // A remote op arrives mid-composition: it must be deferred, not applied.
      node2.mergeOp(remoteOp)
      expect(el2.innerHTML).toBe('X')   // preedit untouched
      expect(node2ops).toHaveLength(0)  // nothing captured/applied yet

      // Composition ends: 'X' is captured into the CRDT, then the deferred
      // remote op is applied on top. Both survive and converge.
      el2.dispatchEvent(new Event('compositionend', { bubbles: true }))
      expect(node2ops.length).toBeGreaterThan(0) // 'X' captured (emitted an op)
      expect(el2.innerHTML).toContain('X')       // local preedit preserved
      expect(el2.innerHTML).toContain('A')       // deferred remote op applied
    })

    it('releases a composition abandoned by blur (focusout) and drains deferred ops', async () => {
      const el1 = makeEditor()
      const el2 = makeEditor()
      let remoteOp = /** @type {any} */ (null)
      await createRogueNode({ element: el1, onCommit(p) { remoteOp = p } })
      const node2 = await createRogueNode({ element: el2 })

      await type(el1, 'A')

      el2.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el2.innerHTML = 'X'
      node2.mergeOp(remoteOp)
      expect(el2.innerHTML).toBe('X') // deferred, preedit intact

      // Editor loses focus mid-composition without a compositionend (browsers
      // do this). focusout must release the lock and drain the deferred op.
      el2.dispatchEvent(new Event('focusout', { bubbles: true }))
      expect(el2.innerHTML).toContain('X')
      expect(el2.innerHTML).toContain('A')
    })
  })

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  describe('undo', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {import('./sync.js').RogueNode} */
    let node
    /** @type {Uint8Array[]} */
    let ops

    beforeEach(async () => {
      el = makeEditor()
      ops = []
      node = await createRogueNode({ element: el, onCommit(p) { ops.push(p) } })
    })

    it('undo reverts the last change', async () => {
      await type(el, 'hello')
      node.undo()
      expect(el.innerHTML).toBe('')
    })

    it('undo fires onCommit', async () => {
      await type(el, 'hello')
      const before = ops.length
      node.undo()
      expect(ops.length).toBeGreaterThan(before)
    })

    it('undo is a no-op when there is nothing to undo', async () => {
      const before = ops.length
      node.undo()
      expect(ops.length).toBe(before)
      expect(el.innerHTML).toBe('')
    })

    it('Ctrl+Z triggers undo', async () => {
      await type(el, 'hello')
      keydown(el, 'z', { ctrlKey: true })
      expect(el.innerHTML).toBe('')
    })

    it('Meta+Z triggers undo', async () => {
      await type(el, 'hello')
      keydown(el, 'z', { metaKey: true })
      expect(el.innerHTML).toBe('')
    })

    it('other keys do not trigger undo', async () => {
      await type(el, 'hello')
      keydown(el, 'a', { ctrlKey: true })
      expect(el.innerHTML).toBe('hello')
    })

    it('undo after two edits reverts to the previous state', async () => {
      await type(el, 'first')
      await type(el, 'second')
      node.undo()
      expect(el.innerHTML).toBe('first')
    })
  })

  // -------------------------------------------------------------------------
  // redo
  // -------------------------------------------------------------------------
  // Redo — re-applies the most recently undone insert (walks the content
  // address forward through insert groups only, skipping undo's hide inverses),
  // halting when every insert is re-included.
  // -------------------------------------------------------------------------

  describe('redo', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {import('./sync.js').RogueNode} */
    let node
    /** @type {Uint8Array[]} */
    let ops

    beforeEach(async () => {
      el = makeEditor()
      ops = []
      node = await createRogueNode({ element: el, onCommit(p) { ops.push(p) } })
    })

    it('re-applies the last undo', async () => {
      await type(el, 'hello')
      node.undo()
      expect(el.innerHTML).toBe('')
      node.redo()
      expect(el.innerHTML).toBe('hello')
    })

    it('is a no-op when nothing was undone', async () => {
      await type(el, 'hello')
      const before = ops.length
      node.redo()
      expect(ops.length).toBe(before)
      expect(el.innerHTML).toBe('hello')
    })

    it('undo twice then redo twice steps forward', async () => {
      await type(el, 'first')
      await type(el, 'first second')
      node.undo()
      node.undo()
      expect(el.innerHTML).toBe('')
      node.redo()
      expect(el.innerHTML).toBe('first')
      node.redo()
      expect(el.innerHTML).toBe('first second')
    })

    it('redo halts once everything is re-applied', async () => {
      await type(el, 'hello')
      node.undo()
      node.redo()
      expect(el.innerHTML).toBe('hello')
      const before = ops.length
      node.redo()
      expect(ops.length).toBe(before)
      expect(el.innerHTML).toBe('hello')
    })

    it('redo re-does a delete', async () => {
      // "ab" → delete to "a" → undo (back to "ab") → redo (delete re-applied → "a").
      await type(el, 'ab')
      await type(el, 'a')
      expect(el.innerHTML).toBe('a')
      node.undo()
      expect(el.innerHTML).toBe('ab')
      node.redo()
      expect(el.innerHTML).toBe('a')
    })

    it('fires onCommit', async () => {
      await type(el, 'hello')
      node.undo()
      const before = ops.length
      node.redo()
      expect(ops.length).toBeGreaterThan(before)
    })

    it('Ctrl+Shift+Z triggers redo', async () => {
      await type(el, 'hello')
      node.undo()
      keydown(el, 'z', { ctrlKey: true, shiftKey: true })
      expect(el.innerHTML).toBe('hello')
    })

    it('Ctrl+Y triggers redo', async () => {
      await type(el, 'hello')
      node.undo()
      keydown(el, 'y', { ctrlKey: true })
      expect(el.innerHTML).toBe('hello')
    })

    it('redo re-applies a mixed hide+insert group (&nbsp; → space)', async () => {
      await type(el, 'Hello&nbsp;')
      // Replacing the trailing &nbsp; with " w" is a hide(6 chars) + insert(2 chars)
      // in one commit — the same shape TinyMCE produces when a trailing space
      // stops being trailing.
      await type(el, 'Hello w')
      expect(el.innerHTML).toBe('Hello w')
      node.undo()
      expect(el.innerHTML).toBe('Hello&nbsp;')
      node.redo()
      expect(el.innerHTML).toBe('Hello w')
    })
  })

  // -------------------------------------------------------------------------
  // Composition (IME)
  // -------------------------------------------------------------------------

  describe('composition (IME)', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {import('./sync.js').RogueNode} */
    let node
    /** @type {Uint8Array[]} */
    let ops

    beforeEach(async () => {
      el = makeEditor()
      ops = []
      node = await createRogueNode({ element: el, onCommit(p) { ops.push(p) } })
    })

    it('input events during composition are suppressed', async () => {
      el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el.innerHTML = 'intermediate'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      expect(ops).toHaveLength(0)
      el.dispatchEvent(new Event('compositionend', { bubbles: true }))
    })

    it('compositionend flushes the accumulated input', async () => {
      await compose(el, 'こんにちは')
      expect(ops).toHaveLength(1)
      expect(el.innerHTML).toBe('こんにちは')
    })

    it('content after composition matches what was committed', async () => {
      await compose(el, 'typed via IME')
      expect(el.innerHTML).toBe('typed via IME')
    })
  })

  // -------------------------------------------------------------------------
  // Paste
  // -------------------------------------------------------------------------

  describe('paste', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {ReturnType<typeof vi.fn>} */
    let execCommandMock

    beforeEach(async () => {
      el = makeEditor()
      await createRogueNode({ element: el })
      // jsdom does not implement execCommand — stub it manually
      execCommandMock = vi.fn().mockReturnValue(true)
      Object.defineProperty(document, 'execCommand', {
        value: execCommandMock, writable: true, configurable: true,
      })
    })

    it('plain text paste calls execCommand with escaped HTML', async () => {
      paste(el, { plain: 'a & b < c > d' })
      expect(execCommandMock).toHaveBeenCalledWith(
        'insertHTML', false, 'a &amp; b &lt; c &gt; d',
      )
    })

    it('plain text paste converts newlines to <br>', async () => {
      paste(el, { plain: 'line1\nline2' })
      expect(execCommandMock).toHaveBeenCalledWith(
        'insertHTML', false, 'line1<br>line2',
      )
    })

    it('HTML paste is used when available', async () => {
      paste(el, { html: '<b>bold</b>', plain: 'bold' })
      const [, , content] = execCommandMock.mock.calls[0]
      expect(content).toContain('bold')
    })

    it('HTML paste strips dangerous tags (script)', async () => {
      paste(el, { html: '<script>alert(1)</script><b>safe</b>' })
      const [, , content] = execCommandMock.mock.calls[0]
      expect(content).not.toContain('<script>')
      expect(content).toContain('safe')
    })

    it('paste preventDefault is called', async () => {
      const e = paste(el, { plain: 'hi' })
      expect(e.preventDefault).toHaveBeenCalled()
    })
  })

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  describe('destroy', () => {
    /** @type {HTMLElement} */
    let el
    /** @type {import('./sync.js').RogueNode} */
    let node
    /** @type {Uint8Array[]} */
    let ops

    beforeEach(async () => {
      el = makeEditor()
      ops = []
      node = await createRogueNode({ element: el, onCommit(p) { ops.push(p) } })
    })

    it('input events after destroy do not sync', async () => {
      node.destroy()
      await type(el, 'should not sync')
      expect(ops).toHaveLength(0)
    })

    it('keyboard undo after destroy does nothing', async () => {
      await type(el, 'hello')
      node.destroy()
      keydown(el, 'z', { ctrlKey: true })
      expect(el.innerHTML).toBe('hello')
    })

    it('compositionend after destroy does not sync', async () => {
      node.destroy()
      el.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      el.innerHTML = 'post-destroy'
      el.dispatchEvent(new Event('compositionend', { bubbles: true }))
      expect(ops).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // dom-rope interplay
  // Verify that a DomRope built from the editor element correctly models
  // whatever HTML the CRDT produces.
  // -------------------------------------------------------------------------

  describe('dom-rope interplay', () => {
    /** @type {HTMLElement} */
    let el

    beforeEach(async () => {
      el = makeEditor()
      await createRogueNode({ element: el })
    })

    it('rope.serialize() matches element.innerHTML after typing', async () => {
      await type(el, 'hello world')
      const rope = mustBuildRope(el)
      expect(rope.serialize()).toBe(el.innerHTML)
    })

    it('rope weight equals serialized length', async () => {
      await type(el, 'some content here')
      const rope = mustBuildRope(el)
      expect(rope.length).toBe(rope.serialize().length)
    })

    it('getAtVisIx on every character is consistent with serialized HTML', async () => {
      await type(el, 'abc')
      const rope = mustBuildRope(el)
      const html = rope.serialize()
      for (let i = 0; i < html.length; i++) {
        const r = rope.getAtVisIx(i)
        expect(r).not.toBeNull()
        expect(r?.node.text[r.offset]).toBe(html[i])
      }
    })

    it('getRange for the editor element returns null (not in rope)', async () => {
      await type(el, 'test')
      const rope = mustBuildRope(el)
      const range = rope.getRange(el)
      expect(range).toBeNull()
    })

    it('getRange for a text node returns the right slice', async () => {
      await type(el, 'hello')
      const textNode = /** @type {Text} */ (el.firstChild)
      expect(textNode?.nodeType).toBe(3)
      const rope = mustBuildRope(el)
      const html = rope.serialize()
      const range = rope.getRange(/** @type {Text} */ (textNode))
      expect(range).not.toBeNull()
      if (range) {
        expect(html.slice(range[0], range[1] + 1)).toBe('hello')
      }
    })

    it('rope is correct after a sync cycle (type → rerender → rope)', async () => {
      const el1 = makeEditor()
      const el2 = makeEditor()
      let op = /** @type {Uint8Array} */ (new Uint8Array())
      await createRogueNode({ element: el1, onCommit(p) { op = p } })
      const node2 = await createRogueNode({ element: el2 })

      await type(el1, 'synced content')
      node2.mergeOp(op)

      // el2 now has CRDT-rendered content; build a rope and verify it
      const rope = mustBuildRope(el2)
      expect(rope.serialize()).toBe(el2.innerHTML)
      expect(rope.length).toBe(rope.serialize().length)

      const html = rope.serialize()
      for (let i = 0; i < html.length; i++) {
        const r = rope.getAtVisIx(i)
        expect(r?.node.text[r.offset]).toBe(html[i])
      }
    })

    it('treap invariants hold on rope built from CRDT HTML', async () => {
      await type(el, 'paragraph of text')

      const rope = mustBuildRope(el)
      /** @param {import('./dom_rope.js').RopeNode | null} node */
      function check(node) {
        if (!node) return
        if (node.left)  expect(node.priority).toBeGreaterThanOrEqual(node.left.priority)
        if (node.right) expect(node.priority).toBeGreaterThanOrEqual(node.right.priority)
        const w = (node.left?.weight ?? 0) + node.text.length + (node.right?.weight ?? 0)
        expect(node.weight).toBe(w)
        check(node.left)
        check(node.right)
      }
      check(rope.root)
    })
  })

})
