// @ts-check
//
// insert_bytes_v0 — variable-shape byte-native CRDT insert op.
// See `insert_bytes_v0.md`.
// Payload: id(6) + parent(6) + side(1) + byte_count(4) + bytes(N).

import * as nodeIdV0 from './node_id_v0.js'

export const DISC = 6

/** @enum {number} */
export const Side = Object.freeze({
  Left: 0,
  Right: 1,
  Root: 2,
})

/** @type {Record<number, 'left' | 'right' | 'root'>} */
const sideToName = { 0: 'left', 1: 'right', 2: 'root' }

/** @type {Record<string, number>} */
const sideFromName = { left: 0, right: 1, root: 2 }

/**
 * @param {string} name
 * @returns {number}
 */
export function sideFromString(name) {
  if (!(name in sideFromName)) throw new Error(`insert_bytes_v0: unknown side '${name}'`)
  return sideFromName[name]
}

/**
 * @param {number} disc
 * @returns {'left' | 'right' | 'root'}
 */
export function sideToString(disc) {
  if (!(disc in sideToName)) throw new Error(`insert_bytes_v0: invalid side byte ${disc}`)
  return sideToName[disc]
}

export const HEADER_SIZE = 17 // id(6) + parent(6) + side(1) + byte_count(4)

/**
 * @param {number} byteCount
 * @returns {number}
 */
export function encodedSize(byteCount) {
  return HEADER_SIZE + byteCount
}

/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 * @typedef {{ id: NodeId, parent: NodeId, side: number, bytes: Uint8Array }} Insert
 */

/**
 * Encode an insert payload. Returns a fresh Uint8Array.
 * @param {NodeId} id
 * @param {NodeId} parent
 * @param {number} side  one of `Side.Left`/`Right`/`Root`
 * @param {Uint8Array | number[]} bytes
 * @returns {Uint8Array}
 */
export function encode(id, parent, side, bytes) {
  const byteCount = bytes.length
  const buf = new Uint8Array(encodedSize(byteCount))
  const view = new DataView(buf.buffer)
  let off = 0
  nodeIdV0.encode(id, view, off)
  off += nodeIdV0.SIZE
  nodeIdV0.encode(parent, view, off)
  off += nodeIdV0.SIZE
  buf[off++] = side
  view.setUint32(off, byteCount, true)
  off += 4
  buf.set(bytes, off)
  return buf
}

/**
 * Decode an insert payload.
 * @param {Uint8Array} buf
 * @returns {Insert}
 */
export function decode(buf) {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error('insert_bytes_v0: truncated header')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 0
  const id = nodeIdV0.decode(view, off)
  off += nodeIdV0.SIZE
  const parent = nodeIdV0.decode(view, off)
  off += nodeIdV0.SIZE
  const sideRaw = buf[off++]
  if (sideRaw !== Side.Left && sideRaw !== Side.Right && sideRaw !== Side.Root) {
    throw new Error(`insert_bytes_v0: invalid side byte ${sideRaw}`)
  }
  const byteCount = view.getUint32(off, true)
  off += 4
  if (off + byteCount > buf.byteLength) {
    throw new Error('insert_bytes_v0: truncated bytes')
  }
  const bytes = buf.slice(off, off + byteCount)
  return { id, parent, side: sideRaw, bytes }
}
