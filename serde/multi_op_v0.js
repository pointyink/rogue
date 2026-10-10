// @ts-check
//
// multi_op_v0 — framing layer for an atomic batch of CRDT ops.
// See `multi_op_v0.md`. This codec emits/walks `{disc, payload}` tuples;
// parsing inner payloads is the caller's job.

import * as nodeIdV0 from './node_id_v0.js'

export const DISC = 3
export const DISC_SIZE = 2

/**
 * Fixed payload size for `disc`, or `null` if that op is variable
 * (length-prefixed). Must agree with `discriminators.md` and peer
 * implementations.
 * @param {number} disc
 * @returns {number | null}
 */
export function fixedOpSize(disc) {
  switch (disc) {
    case 1: // hide_v0 — id(6) + target(6) + len(4)
    case 2: // show_v0 — same shape
      return 16
    default:
      return null
  }
}

/**
 * @typedef {{ disc: number, payload: Uint8Array }} InnerOp
 */

/**
 * @param {InnerOp} op
 * @returns {number}
 */
function framedSize(op) {
  return fixedOpSize(op.disc) !== null ? DISC_SIZE + op.payload.byteLength : DISC_SIZE + 4 + op.payload.byteLength
}

/**
 * Byte size of the multi_op payload (excluding the outer transport frame).
 * @param {InnerOp[]} ops
 * @param {number} [caLen] optional trailing content-address byte length
 * @returns {number}
 */
export function encodedSize(ops, caLen) {
  let n = 6 + 4 // group_id + op_count
  for (const op of ops) n += framedSize(op)
  if (caLen != null) n += caLen
  return n
}

/**
 * Encode a multi_op payload. Returns a fresh Uint8Array.
 * @param {{ replica_id: number, sequence: number }} groupId
 * @param {InnerOp[]} ops
 * @param {Uint8Array} [ca] optional trailing content-address bytes
 * @returns {Uint8Array}
 */
export function encode(groupId, ops, ca) {
  const size = encodedSize(ops, ca ? ca.byteLength : undefined)
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)
  let off = 0

  nodeIdV0.encode(groupId, view, off)
  off += nodeIdV0.SIZE

  view.setUint32(off, ops.length, true)
  off += 4

  for (const op of ops) {
    view.setUint16(off, op.disc, true)
    off += DISC_SIZE
    const fixed = fixedOpSize(op.disc)
    if (fixed !== null) {
      if (op.payload.byteLength !== fixed) {
        throw new Error(`multi_op_v0: disc=${op.disc} expected ${fixed} bytes, got ${op.payload.byteLength}`)
      }
      buf.set(op.payload, off)
      off += op.payload.byteLength
    } else {
      view.setUint32(off, op.payload.byteLength, true)
      off += 4
      buf.set(op.payload, off)
      off += op.payload.byteLength
    }
  }
  if (ca) {
    buf.set(ca, off)
    off += ca.byteLength
  }
  return buf
}

/**
 * @typedef {{ group_id: { replica_id: number, sequence: number }, ops: InnerOp[], ca: (Uint8Array|null) }} Decoded
 */

/**
 * Decode a multi_op payload. Inner-op `payload` slices alias `buf` — no copy.
 * @param {Uint8Array} buf
 * @returns {Decoded}
 */
export function decode(buf) {
  if (buf.byteLength < nodeIdV0.SIZE + 4) {
    throw new Error('multi_op_v0: truncated header')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 0

  const group_id = nodeIdV0.decode(view, off)
  off += nodeIdV0.SIZE

  const count = view.getUint32(off, true)
  off += 4

  /** @type {InnerOp[]} */
  const ops = new Array(count)
  for (let i = 0; i < count; i++) {
    if (off + DISC_SIZE > buf.byteLength) throw new Error('multi_op_v0: truncated at op disc')
    const disc = view.getUint16(off, true)
    off += DISC_SIZE
    const fixed = fixedOpSize(disc)
    if (fixed !== null) {
      if (off + fixed > buf.byteLength) throw new Error('multi_op_v0: truncated fixed op payload')
      ops[i] = { disc, payload: buf.subarray(off, off + fixed) }
      off += fixed
    } else if (disc === 0) {
      // insert_v0 — variable, length-prefixed
      if (off + 4 > buf.byteLength) throw new Error('multi_op_v0: truncated at op len')
      const len = view.getUint32(off, true)
      off += 4
      if (off + len > buf.byteLength) throw new Error('multi_op_v0: truncated variable op payload')
      ops[i] = { disc, payload: buf.subarray(off, off + len) }
      off += len
    } else {
      throw new Error(`multi_op_v0: unknown inner disc ${disc}`)
    }
  }
  /** @type {Uint8Array|null} */
  let ca = null
  if (off < buf.byteLength) {
    ca = buf.subarray(off)
  }
  return { group_id, ops, ca }
}
