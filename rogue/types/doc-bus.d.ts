/**
 * @typedef {{
 *   docId: string,
 *   onOp: (payload: Uint8Array) => void,
 * }} DocBusOptions
 *
 * @typedef {{
 *   broadcastOp: (payload: Uint8Array) => void,
 *   destroy: () => void,
 * }} DocBus
 */
/**
 * @param {DocBusOptions} options
 * @returns {DocBus}
 */
export function createDocBus({ docId, onOp }: DocBusOptions): DocBus;
export type DocBusOptions = {
    docId: string;
    onOp: (payload: Uint8Array) => void;
};
export type DocBus = {
    broadcastOp: (payload: Uint8Array) => void;
    destroy: () => void;
};
