// @ts-check
//
// json_envelope_v0 — pass-through wrapper for a UTF-8 JSON payload.
// See `json_envelope_v0.md`. The codec performs no parsing — bytes in,
// bytes out. Routing happens via a `"type"` field inside the JSON,
// interpreted by the application.

export const DISC = 5

/**
 * Identity. Provided for symmetry with the other codecs — encoders
 * produce the bytes that the outer wire frame will length-prefix.
 * @param {Uint8Array} jsonBytes
 * @returns {Uint8Array}
 */
export function encode(jsonBytes) {
  return jsonBytes
}

/**
 * Identity. The caller-supplied slice (already bounded by the outer
 * wire frame's length) is the payload.
 * @param {Uint8Array} buf
 * @returns {Uint8Array}
 */
export function decode(buf) {
  return buf
}
