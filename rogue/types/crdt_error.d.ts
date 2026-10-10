/**
 * @typedef {{ type: number, name: string, desc?: string }} CrdtError
 */
/**
 * Parse the structured error payload the WASM wrote into out_buf on a failed
 * call (`{"type":N,"name":"...","desc":"..."}`). Returns null if it can't be
 * parsed — treat that as an unknown error.
 * @param {string} payload
 * @returns {CrdtError | null}
 */
export function parseCrdtError(payload: string): CrdtError | null;
/** @type {{ readonly [name: string]: number }} */
export const CrdtErrorKind: {
    readonly [name: string]: number;
};
/** Reverse map: type int → human name, for logging. @type {Record<number, string>} */
export const CrdtErrorNames: Record<number, string>;
export type CrdtError = {
    type: number;
    name: string;
    desc?: string;
};
