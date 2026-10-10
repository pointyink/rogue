/**
 * Fixed payload size for `disc`, or `null` if that op is variable
 * (length-prefixed). Must agree with `discriminators.md` and peer
 * implementations.
 * @param {number} disc
 * @returns {number | null}
 */
export function fixedOpSize(disc: number): number | null;
/**
 * Byte size of the multi_op payload (excluding the outer transport frame).
 * @param {InnerOp[]} ops
 * @param {number} [caLen] optional trailing content-address byte length
 * @returns {number}
 */
export function encodedSize(ops: InnerOp[], caLen?: number): number;
/**
 * Encode a multi_op payload. Returns a fresh Uint8Array.
 * @param {{ replica_id: number, sequence: number }} groupId
 * @param {InnerOp[]} ops
 * @param {Uint8Array} [ca] optional trailing content-address bytes
 * @returns {Uint8Array}
 */
export function encode(groupId: {
    replica_id: number;
    sequence: number;
}, ops: InnerOp[], ca?: Uint8Array): Uint8Array;
/**
 * @typedef {{ group_id: { replica_id: number, sequence: number }, ops: InnerOp[], ca: (Uint8Array|null) }} Decoded
 */
/**
 * Decode a multi_op payload. Inner-op `payload` slices alias `buf` — no copy.
 * @param {Uint8Array} buf
 * @returns {Decoded}
 */
export function decode(buf: Uint8Array): Decoded;
export const DISC: 3;
export const DISC_SIZE: 2;
export type InnerOp = {
    disc: number;
    payload: Uint8Array;
};
export type Decoded = {
    group_id: {
        replica_id: number;
        sequence: number;
    };
    ops: InnerOp[];
    ca: (Uint8Array | null);
};
