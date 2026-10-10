// @ts-check
//
// content_address_v0 — compact version vector codec.
//
// Wire format: count(u8) + count × (replica_id: u16 LE, sequence: u32 LE).
// An entry (r, s) means "all ops from replica r up to sequence s."
//
// Max 255 entries.

export const ENTRY_SIZE = 6

/**
 * @param {Array<{ replica_id: number, sequence: number }>} entries
 * @returns {number}
 */
export function encodedSize(entries) {
  return 1 + entries.length * ENTRY_SIZE
}

/**
 * Encode content address into a fresh Uint8Array.
 * @param {Array<{ replica_id: number, sequence: number }>} entries
 * @returns {Uint8Array}
 */
export function encode(entries) {
  const size = encodedSize(entries)
  const buf = new Uint8Array(size)
  const view = new DataView(buf.buffer)
  view.setUint8(0, entries.length)
  let off = 1
  for (const e of entries) {
    view.setUint16(off, e.replica_id, true)
    view.setUint32(off + 2, e.sequence, true)
    off += ENTRY_SIZE
  }
  return buf
}

/**
 * Decode a content address from binary bytes.
 * @param {Uint8Array} buf
 * @param {Array<{ replica_id: number, sequence: number }>} out pre-allocated output
 * @returns {Array<{ replica_id: number, sequence: number }>} slice of `out` that was filled
 */
export function decode(buf, out) {
  if (buf.byteLength < 1) return []
  const count = buf[0]
  if (buf.byteLength < 1 + count * ENTRY_SIZE) return []
  if (count === 0) return []
  if (out.length < count) return []
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let off = 1
  for (let i = 0; i < count; i++) {
    out[i] = {
      replica_id: view.getUint16(off, true),
      sequence: view.getUint32(off + 2, true),
    }
    off += ENTRY_SIZE
  }
  return out.slice(0, count)
}
