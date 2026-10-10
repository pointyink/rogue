/**
 * @param {Array<{ replica_id: number, sequence: number }>} entries
 * @returns {number}
 */
export function encodedSize(entries: Array<{
    replica_id: number;
    sequence: number;
}>): number;
/**
 * Encode content address into a fresh Uint8Array.
 * @param {Array<{ replica_id: number, sequence: number }>} entries
 * @returns {Uint8Array}
 */
export function encode(entries: Array<{
    replica_id: number;
    sequence: number;
}>): Uint8Array;
/**
 * Decode a content address from binary bytes.
 * @param {Uint8Array} buf
 * @param {Array<{ replica_id: number, sequence: number }>} out pre-allocated output
 * @returns {Array<{ replica_id: number, sequence: number }>} slice of `out` that was filled
 */
export function decode(buf: Uint8Array, out: Array<{
    replica_id: number;
    sequence: number;
}>): Array<{
    replica_id: number;
    sequence: number;
}>;
export const ENTRY_SIZE: 6;
