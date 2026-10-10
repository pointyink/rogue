/**
 * Identity. Provided for symmetry with the other codecs — encoders
 * produce the bytes that the outer wire frame will length-prefix.
 * @param {Uint8Array} jsonBytes
 * @returns {Uint8Array}
 */
export function encode(jsonBytes: Uint8Array): Uint8Array;
/**
 * Identity. The caller-supplied slice (already bounded by the outer
 * wire frame's length) is the payload.
 * @param {Uint8Array} buf
 * @returns {Uint8Array}
 */
export function decode(buf: Uint8Array): Uint8Array;
export const DISC: 5;
