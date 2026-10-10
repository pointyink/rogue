// @ts-check
//
// insert_v0 — variable-shape CRDT insert op. See `insert_v0.md`.
// Payload: id(6) + parent(6) + side(1) + char_count(4) + chars(2*N).

import * as nodeIdV0 from './node_id_v0.js'

export const DISC = 0

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
  if (!(name in sideFromName)) throw new Error(`insert_v0: unknown side '${name}'`)
  return sideFromName[name]
}

/**
 * @param {number} disc
 * @returns {'left' | 'right' | 'root'}
 */
export function sideToString(disc) {
  if (!(disc in sideToName)) throw new Error(`insert_v0: invalid side byte ${disc}`)
  return sideToName[disc]
}

export const HEADER_SIZE = 17 // id(6) + parent(6) + side(1) + char_count(4)

/**
 * @param {number} charCount
 * @returns {number}
 */
export function encodedSize(charCount) {
  return HEADER_SIZE + 2 * charCount
}

/**
 * @typedef {{ replica_id: number, sequence: number }} NodeId
 * @typedef {{ id: NodeId, parent: NodeId, side: number, chars: Uint16Array }} Insert
 */

/**
 * Encode an insert payload. Returns a fresh Uint8Array.
 * @param {NodeId} id
 * @param {NodeId} parent
 * @param {number} side  one of `Side.Left`/`Right`/`Root`
 * @param {Uint16Array | number[]} chars
 * @returns {Uint8Array}
 */
export function encode(id, parent, side, chars) {
  const charCount = chars.length
  const buf = new Uint8Array(encodedSize(charCount))
  const view = new DataView(buf.buffer)
  let off = 0
  nodeIdV0.encode(id, view, off)
  off += nodeIdV0.SIZE
  nodeIdV0.encode(parent, view, off)
  off += nodeIdV0.SIZE
  buf[off++] = side
  view.setUint32(off, charCount, true)
  off += 4
  for (let i = 0; i < charCount; i++) {
    view.setUint16(off, chars[i], true)
    off += 2
  }
  return buf
}

/**
 * Decode an insert payload.
 * @param {Uint8Array} buf
 * @returns {Insert}
 */
export function decode(buf) {
  if (buf.byteLength < HEADER_SIZE) {
    throw new Error('insert_v0: truncated header')
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 0
  const id = nodeIdV0.decode(view, off)
  off += nodeIdV0.SIZE
  const parent = nodeIdV0.decode(view, off)
  off += nodeIdV0.SIZE
  const sideRaw = buf[off++]
  if (sideRaw !== Side.Left && sideRaw !== Side.Right && sideRaw !== Side.Root) {
    throw new Error(`insert_v0: invalid side byte ${sideRaw}`)
  }
  const charCount = view.getUint32(off, true)
  off += 4
  if (off + 2 * charCount > buf.byteLength) {
    throw new Error('insert_v0: truncated chars')
  }
  const chars = new Uint16Array(charCount)
  for (let i = 0; i < charCount; i++) {
    chars[i] = view.getUint16(off, true)
    off += 2
  }
  return { id, parent, side: sideRaw, chars }
}
