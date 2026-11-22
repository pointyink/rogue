// @ts-check
//
// Shared harness for the no-lost-ops fault matrix (`sync.faults*.test.js`).
//
// No browser, no WASM, no real network:
//
//   • a fake hub that enforces the *server's* half of the contract (commit
//     before ack, stream `since`, drop pending on a crash) and can be told to
//     fail at specific points;
//   • a fake socket that speaks the same frames;
//   • a model `mergeOp` that parks an op whose predecessor is missing and
//     drains the park queue when it lands — the engine's real behaviour (it
//     parks, it does not throw);
//   • payload builders whose *dependency is encoded in the bytes*, so it
//     survives the IndexedDB round trip.

import * as ackV0 from '@pointyink/serde/ack_v0'

export const DISC_MULTI_OP = 3
export const DISC_ACK = 4
const DISC_JSON = 5

export const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms))

// ── payloads ────────────────────────────────────────────────────────────────

/**
 * A multi_op_v0-shaped payload: [replica u16][seq u32][parentReplica u16]
 * [parentSeq u32]. The parent is encoded IN THE BYTES so it survives the
 * IndexedDB round trip (an expando property would not, and a test that loses it
 * silently stops modelling parking). parentSeq = 0xffffffff means "no parent":
 * an independent op, i.e. a leaf nobody parks on.
 * @param {number} replica @param {number} seq @param {{ dependsOn?: string | null, tag?: string }} [o]
 */
export function op(replica, seq, o = {}) {
  const tag = new TextEncoder().encode((o.tag ?? '').slice(0, 8))
  const out = new Uint8Array(12 + tag.length)
  const view = new DataView(out.buffer)
  out.set(tag, 12)
  view.setUint16(0, replica, true)
  view.setUint32(2, seq, true)
  const dep = o.dependsOn === undefined ? (seq > 1 ? `${replica}:${seq - 1}` : null) : o.dependsOn
  if (dep) {
    const [pr, ps] = dep.split(':').map(Number)
    view.setUint16(6, pr, true)
    view.setUint32(8, ps, true)
  } else {
    view.setUint32(8, 0xffffffff, true)
  }
  return out
}

/**
 * @param {Uint8Array} a @param {Uint8Array} b
 * @returns {boolean}
 */
export function sameBytes(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** The parent key of a payload, or null. @param {Uint8Array} p */
export function parentOf(p) {
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength)
  const seq = view.getUint32(8, true)
  return seq === 0xffffffff ? null : `${view.getUint16(6, true)}:${seq}`
}

/** @param {Uint8Array} p */
export const keyOf = (p) => {
  const view = new DataView(p.buffer, p.byteOffset, p.byteLength)
  return `${view.getUint16(0, true)}:${view.getUint32(2, true)}`
}

/** @typedef {Uint8Array} Payload */

/** @param {number} disc @param {Uint8Array} payload */
export function frame(disc, payload) {
  const out = new Uint8Array(6 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint16(0, disc, true)
  view.setUint32(2, payload.length, true)
  out.set(payload, 6)
  return out.buffer
}

/** @param {string} json */
export const envelope = (json) => frame(DISC_JSON, new TextEncoder().encode(json))

// ── the server ──────────────────────────────────────────────────────────────

export class FakeHub {
  /**
   * @param {{ readOnly?: boolean }} [opts]
   */
  constructor(opts = {}) {
    /** @type {Map<string, Map<string, Payload>>} */
    this.docs = new Map()
    /** @type {Map<string, Map<string, Payload>>} ops received but NOT committed (lost on a crash) */
    this.pending = new Map()
    /** @type {string[]} replica:seq keys the PK discarded because different bytes were already stored */
    this.conflicts = []
    this.readOnly = opts.readOnly ?? false
    this.acksDropped = 0
    /** writes refused because the peer is read-only (the hub drops them silently) */
    this.refusals = 0
    /** @type {null | ((ops: Payload[]) => Payload[])} reorder/duplicate the bootstrap stream */
    this.streamTransform = null
    /** @type {Set<(ids: string[]) => void>} */
    this.listeners = new Set()
    /** @type {FakeSocket | null} */
    this.socket = null
  }

  /** @param {string} docId */
  doc(docId) {
    if (!this.docs.has(docId)) this.docs.set(docId, new Map())
    return /** @type {Map<string, Payload>} */ (this.docs.get(docId))
  }

  /** @param {string} docId */
  pendingFor(docId) {
    if (!this.pending.has(docId)) this.pending.set(docId, new Map())
    return /** @type {Map<string, Payload>} */ (this.pending.get(docId))
  }

  /**
   * Receive an op from a client. Returns the ack payload (or null when the op is
   * refused) and, as the real hub does, only acks once it is durable.
   * @param {string} docId @param {Payload} payload
   */
  receive(docId, payload) {
    if (this.readOnly) {
      // The hub drops ops from non-write peers, silently — no ack, no error.
      this.refusals += 1
      return null
    }
    const key = keyOf(payload)
    const existing = this.doc(docId).get(key)
    // The PK is (seq, replica). Two *different* ops at one key is a fork; the
    // insert is ON CONFLICT DO NOTHING, so the existing bytes win and the new
    // ones are discarded. The hub cannot tell — it never compares — which is
    // why this only records for the test's benefit.
    if (existing && !sameBytes(existing, payload)) this.conflicts.push(key)

    // Everything received joins the batch, conflicts included. That is the
    // load-bearing detail: `flush` acks every id in the batch, whether or not
    // its insert did anything.
    this.pendingFor(docId).set(key, payload)
    return null // not acked until the flush commits
  }

  /** Durably commit everything pending. @param {string} docId */
  flush(docId) {
    const pending = this.pendingFor(docId)
    const stored = this.doc(docId)
    const ids = []
    for (const [key, payload] of pending) {
      if (stored.has(key)) {
        // ON CONFLICT DO NOTHING — the stored bytes survive, the new ones are
        // dropped. Real hub: still acked (see the note in `receive`).
      } else {
        stored.set(key, payload)
      }
      ids.push(key)
    }
    pending.clear()
    if (ids.length) this.emitAck(ids)
    return ids
  }

  /** Crash: everything received but not flushed is gone. @param {string} docId */
  crash(docId) {
    this.pendingFor(docId).clear()
    this.socket?.emitClose()
  }

  /** @param {string[]} ids */
  emitAck(ids) {
    if (this.acksDropped > 0) {
      this.acksDropped -= 1
      return
    }
    const body = ackV0.encode(ids.map(parseKey))
    const msg = frame(DISC_ACK, body)
    this.socket?.emitMessage(msg)
  }

  /**
   * @param {string} docId
   * @param {Record<string, number>} since
   * @returns {Payload[]}
   */
  stream(docId, since) {
    const ops = [...this.doc(docId).values()].sort((a, b) => {
      const av = new DataView(a.buffer, a.byteOffset, a.byteLength)
      const bv = new DataView(b.buffer, b.byteOffset, b.byteLength)
      const aseq = av.getUint32(2, true)
      const bseq = bv.getUint32(2, true)
      return aseq - bseq || av.getUint16(0, true) - bv.getUint16(0, true)
    })
    return ops.filter((p) => {
      const view = new DataView(p.buffer, p.byteOffset, p.byteLength)
      const replica = String(view.getUint16(0, true))
      return view.getUint32(2, true) > (since[replica] ?? -1)
    })
  }
}

/** @param {string} key */
export function parseKey(key) {
  const [replica, sequence] = key.split(':').map(Number)
  return { replica_id: replica, sequence }
}

// ── the socket ──────────────────────────────────────────────────────────────

export class FakeSocket {
  /** @type {FakeSocket[]} */
  static instances = []

  /** @type {Record<string, ((e: any) => void)[]>} */
  listeners = {}

  /** @param {string} url @param {string[]} protocols @param {FakeHub} hub @param {string} docId */
  constructor(url, protocols, hub, docId) {
    FakeSocket.instances.push(this)
    this.url = url
    this.sentOps = 0
    this.protocols = protocols
    this.hub = hub
    this.docId = docId
    hub.socket = this
    queueMicrotask(() => {
      this.dispatch('open', {})
      // Bootstrap: size hint, the ops the client is missing, then sync_done.
      const sinceParam = new URL(url).searchParams.get('since')
      const since = sinceParam ? JSON.parse(sinceParam) : {}
      const streamed = hub.stream(docId, since)
      const ops = hub.streamTransform ? hub.streamTransform(streamed) : streamed
      this.emitMessage(envelope(JSON.stringify({ type: 'sync_start', bytes: ops.length * 10 })))
      for (const p of ops) this.emitMessage(frame(DISC_MULTI_OP, p))
      this.emitMessage(envelope('{"type":"sync_done"}'))
    })
  }

  /** @param {string} type @param {(e: any) => void} fn */
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }

  /** @param {any} data */
  send(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint16(0, true) !== DISC_MULTI_OP) return
    const len = view.getUint32(2, true)
    const payload = /** @type {Payload} */ (bytes.slice(6, 6 + len))
    this.sentOps += 1
    // Hand it to the server; any ack comes from `flush`, never from `receive`.
    this.hub.receive(this.docId, payload)
  }

  close() {
    queueMicrotask(() => this.dispatch('close', {}))
  }

  /** @param {string} type @param {any} event */
  dispatch(type, event) {
    for (const fn of this.listeners[type] || []) fn(event)
  }

  /** @param {any} data */
  emitMessage(data) {
    this.dispatch('message', { data })
  }

  emitClose() {
    this.dispatch('close', {})
  }
}

// ── the client under test ───────────────────────────────────────────────────

/**
 * A model of the engine's merge: it parks an op whose predecessor is not applied
 * and returns the outcome, exactly as `mergeOp` does after 0.3.6.
 */
export function makeModel() {
  return {
    /** @type {Set<string>} */
    applied: new Set(),
    /** @type {Set<string>} */
    parked: new Set(),
    /** @type {Map<string, Payload>} */
    queue: new Map(),
    /**
     * Apply the op, or park it if its parent is absent. Then drain anything the
     * new op unblocked — the real engine replays its park queue when a missing
     * parent lands (observability.test.js: stats().parked goes 1 -> 0). Without
     * the drain the model under-reports repair and every repaired-gap test
     * looks broken when it is not.
     * @param {Payload} payload
     * @returns {'applied' | 'parked'}
     */
    merge(payload) {
      const key = keyOf(payload)
      if (this.applied.has(key)) return 'applied'
      const dep = parentOf(payload)
      if (dep && !this.applied.has(dep)) {
        this.parked.add(key)
        this.queue.set(key, payload)
        return 'parked'
      }
      this.apply(key)
      let drained = true
      while (drained) {
        drained = false
        for (const [k, p] of [...this.queue]) {
          const d = parentOf(p)
          if (d && this.applied.has(d)) {
            this.parked.delete(k)
            this.queue.delete(k)
            this.apply(k)
            drained = true
          }
        }
      }
      return 'applied'
    },
    /** @param {string} key */
    apply(key) {
      this.applied.add(key)
    },
  }
}

/**
 * Point `globalThis.WebSocket` at the fake, bound to one hub and one doc.
 * @param {FakeHub} hub @param {() => string} getDocId
 * @returns {() => void} restore
 */
export function installWebSocket(hub, getDocId) {
  const prev = globalThis.WebSocket
  globalThis.WebSocket = /** @type {any} */ (
    class extends FakeSocket {
      /** @param {string} url @param {string[]} protocols */
      constructor(url, protocols) {
        super(url, protocols, hub, getDocId())
      }
    }
  )
  return () => {
    globalThis.WebSocket = prev
  }
}
