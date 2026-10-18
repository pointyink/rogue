#!/usr/bin/env node
// @ts-check
//
// Fixture-driven conformance runner for the JS codecs. Mirrors the Go test
// runner: for every positive fixture, decode(bytes.bin) must field-match
// value.json AND encode(value.json) must produce bytes.bin verbatim. For
// every negative fixture, decode(bytes.bin) must throw.
//
// Run:  node serde/fixtures_test.js   (from the repo root)

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import * as nodeIdV0 from './node_id_v0.js'
import * as multiOpV0 from './multi_op_v0.js'
import * as insertV0 from './insert_v0.js'
import * as insertBytesV0 from './insert_bytes_v0.js'
import * as hideV0 from './hide_v0.js'
import * as showV0 from './show_v0.js'
import * as ackV0 from './ack_v0.js'
import * as jsonEnvelopeV0 from './json_envelope_v0.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const fixturesRoot = join(__dirname, 'fixtures')

let passed = 0
let failed = 0
/** @type {string[]} */
const failures = []

/**
 * @param {string} name
 * @param {() => void} fn
 */
function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failed++
    failures.push(`${name}\n  ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** @param {Uint8Array} a @param {Uint8Array} b */
function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/** @param {Uint8Array} b */
function toHex(b) {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}

/** @param {string} h @returns {Uint8Array} */
function fromHex(h) {
  const out = new Uint8Array(h.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16)
  return out
}

/** @param {string} dir */
function listSubdirs(dir) {
  return readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory())
}

// ---- positive: node_id_v0 ----

function runPositiveNodeIdV0() {
  const dir = join(fixturesRoot, 'positive', 'node_id_v0')
  for (const name of listSubdirs(dir)) {
    check(`positive/node_id_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const value = JSON.parse(readFileSync(join(caseDir, 'value.json'), 'utf8'))

      // decode → must match value.json
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      const got = nodeIdV0.decode(view, 0)
      if (got.replica_id !== value.replica_id) {
        throw new Error(`replica_id: got ${got.replica_id}, want ${value.replica_id}`)
      }
      if (got.sequence !== value.sequence) {
        throw new Error(`sequence: got ${got.sequence}, want ${value.sequence}`)
      }

      // encode → must match bytes.bin
      const out = new Uint8Array(nodeIdV0.SIZE)
      const outView = new DataView(out.buffer)
      nodeIdV0.encode({ replica_id: value.replica_id, sequence: value.sequence }, outView, 0)
      if (!bytesEqual(out, bytes)) {
        throw new Error(`encode mismatch:\n  got:  ${toHex(out)}\n  want: ${toHex(bytes)}`)
      }
    })
  }
}

// ---- positive: insert_v0 ----

function runPositiveInsertV0() {
  const dir = join(fixturesRoot, 'positive', 'insert_v0')
  for (const name of listSubdirs(dir)) {
    check(`positive/insert_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const value = JSON.parse(readFileSync(join(caseDir, 'value.json'), 'utf8'))

      // decode → field match
      const got = insertV0.decode(bytes)
      if (got.id.replica_id !== value.id.replica_id || got.id.sequence !== value.id.sequence) {
        throw new Error(`id: got {${got.id.replica_id},${got.id.sequence}}, want {${value.id.replica_id},${value.id.sequence}}`)
      }
      if (got.parent.replica_id !== value.parent.replica_id || got.parent.sequence !== value.parent.sequence) {
        throw new Error(`parent: got {${got.parent.replica_id},${got.parent.sequence}}, want {${value.parent.replica_id},${value.parent.sequence}}`)
      }
      if (insertV0.sideToString(got.side) !== value.side) {
        throw new Error(`side: got ${insertV0.sideToString(got.side)}, want ${value.side}`)
      }
      const wantCharBytes = fromHex(value.chars_hex)
      const gotCharBytes = new Uint8Array(got.chars.length * 2)
      for (let i = 0; i < got.chars.length; i++) {
        gotCharBytes[2 * i] = got.chars[i] & 0xff
        gotCharBytes[2 * i + 1] = (got.chars[i] >> 8) & 0xff
      }
      if (!bytesEqual(gotCharBytes, wantCharBytes)) {
        throw new Error(`chars:\n  got:  ${toHex(gotCharBytes)}\n  want: ${toHex(wantCharBytes)}`)
      }

      // encode → bytes match
      const chars = new Uint16Array(wantCharBytes.length / 2)
      for (let i = 0; i < chars.length; i++) {
        chars[i] = wantCharBytes[2 * i] | (wantCharBytes[2 * i + 1] << 8)
      }
      const enc = insertV0.encode(value.id, value.parent, insertV0.sideFromString(value.side), chars)
      if (!bytesEqual(enc, bytes)) {
        throw new Error(`encode mismatch:\n  got:  ${toHex(enc)}\n  want: ${toHex(bytes)}`)
      }
    })
  }
}

// ---- positive: insert_bytes_v0 ----

function runPositiveInsertBytesV0() {
  const dir = join(fixturesRoot, 'positive', 'insert_bytes_v0')
  for (const name of listSubdirs(dir)) {
    check(`positive/insert_bytes_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const value = JSON.parse(readFileSync(join(caseDir, 'value.json'), 'utf8'))

      const got = insertBytesV0.decode(bytes)
      if (got.id.replica_id !== value.id.replica_id || got.id.sequence !== value.id.sequence) {
        throw new Error(`id: got {${got.id.replica_id},${got.id.sequence}}, want {${value.id.replica_id},${value.id.sequence}}`)
      }
      if (got.parent.replica_id !== value.parent.replica_id || got.parent.sequence !== value.parent.sequence) {
        throw new Error(`parent: got {${got.parent.replica_id},${got.parent.sequence}}, want {${value.parent.replica_id},${value.parent.sequence}}`)
      }
      if (insertBytesV0.sideToString(got.side) !== value.side) {
        throw new Error(`side: got ${insertBytesV0.sideToString(got.side)}, want ${value.side}`)
      }
      const wantBytes = fromHex(value.bytes_hex)
      if (!bytesEqual(got.bytes, wantBytes)) {
        throw new Error(`bytes:\n  got:  ${toHex(got.bytes)}\n  want: ${toHex(wantBytes)}`)
      }

      const enc = insertBytesV0.encode(value.id, value.parent, insertBytesV0.sideFromString(value.side), wantBytes)
      if (!bytesEqual(enc, bytes)) {
        throw new Error(`encode mismatch:\n  got:  ${toHex(enc)}\n  want: ${toHex(bytes)}`)
      }
    })
  }
}

// ---- positive: hide_v0 / show_v0 ----
// Identical shape, identical test logic.

/**
 * @param {string} typeName  "hide_v0" | "show_v0"
 * @param {{ encode: any, decode: any, SIZE: number }} codec
 */
function runPositiveHideShow(typeName, codec) {
  const dir = join(fixturesRoot, 'positive', typeName)
  for (const name of listSubdirs(dir)) {
    check(`positive/${typeName}/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const value = JSON.parse(readFileSync(join(caseDir, 'value.json'), 'utf8'))

      const got = codec.decode(bytes)
      if (got.id.replica_id !== value.id.replica_id || got.id.sequence !== value.id.sequence) {
        throw new Error(`id mismatch`)
      }
      if (got.target.replica_id !== value.target.replica_id || got.target.sequence !== value.target.sequence) {
        throw new Error(`target mismatch`)
      }
      if (got.len !== value.len) {
        throw new Error(`len: got ${got.len}, want ${value.len}`)
      }

      const enc = codec.encode({ id: value.id, target: value.target, len: value.len })
      if (!bytesEqual(enc, bytes)) {
        throw new Error(`encode mismatch:\n  got:  ${toHex(enc)}\n  want: ${toHex(bytes)}`)
      }
    })
  }
}

// ---- positive: json_envelope_v0 ----

function runPositiveJsonEnvelopeV0() {
  const dir = join(fixturesRoot, 'positive', 'json_envelope_v0')
  for (const name of listSubdirs(dir)) {
    check(`positive/json_envelope_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const value = JSON.parse(readFileSync(join(caseDir, 'value.json'), 'utf8'))
      const wantPayload = fromHex(value.payload_hex)

      const dec = jsonEnvelopeV0.decode(bytes)
      if (!bytesEqual(dec, wantPayload)) {
        throw new Error(`decode mismatch:\n  got:  ${toHex(dec)}\n  want: ${toHex(wantPayload)}`)
      }
      const enc = jsonEnvelopeV0.encode(wantPayload)
      if (!bytesEqual(enc, bytes)) {
        throw new Error(`encode mismatch:\n  got:  ${toHex(enc)}\n  want: ${toHex(bytes)}`)
      }
    })
  }
}

// ---- positive: ack_v0 ----

function runPositiveAckV0() {
  const dir = join(fixturesRoot, 'positive', 'ack_v0')
  for (const name of listSubdirs(dir)) {
    check(`positive/ack_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const value = JSON.parse(readFileSync(join(caseDir, 'value.json'), 'utf8'))

      const got = ackV0.decode(bytes)
      if (got.group_ids.length !== value.group_ids.length) {
        throw new Error(`count: got ${got.group_ids.length}, want ${value.group_ids.length}`)
      }
      for (let i = 0; i < got.group_ids.length; i++) {
        if (got.group_ids[i].replica_id !== value.group_ids[i].replica_id ||
            got.group_ids[i].sequence !== value.group_ids[i].sequence) {
          throw new Error(`id[${i}] mismatch`)
        }
      }

      const enc = ackV0.encode(value.group_ids)
      if (!bytesEqual(enc, bytes)) {
        throw new Error(`encode mismatch:\n  got:  ${toHex(enc)}\n  want: ${toHex(bytes)}`)
      }
    })
  }
}

// ---- negative: ack_v0 ----

function runNegativeAckV0() {
  const dir = join(fixturesRoot, 'negative', 'ack_v0')
  for (const name of listSubdirs(dir)) {
    check(`negative/ack_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const expectedKind = readFileSync(join(caseDir, 'error.txt'), 'utf8').trim()
      const want = expectedKind.startsWith('truncated_') ? 'truncated' : expectedKind

      let threw = /** @type {Error | null} */ (null)
      try {
        ackV0.decode(bytes)
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err))
      }
      if (!threw) throw new Error(`expected ${want}, got no throw`)
      if (!threw.message.startsWith('ack_v0: truncated')) {
        throw new Error(`unexpected error: ${threw.message}`)
      }
    })
  }
}

// ---- positive: multi_op_v0 ----

function runPositiveMultiOpV0() {
  const dir = join(fixturesRoot, 'positive', 'multi_op_v0')
  for (const name of listSubdirs(dir)) {
    check(`positive/multi_op_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const value = JSON.parse(readFileSync(join(caseDir, 'value.json'), 'utf8'))

      // decode → field match
      const got = multiOpV0.decode(bytes)
      if (got.group_id.replica_id !== value.group_id.replica_id) {
        throw new Error(`group replica_id: got ${got.group_id.replica_id}, want ${value.group_id.replica_id}`)
      }
      if (got.group_id.sequence !== value.group_id.sequence) {
        throw new Error(`group sequence: got ${got.group_id.sequence}, want ${value.group_id.sequence}`)
      }
      if (got.ops.length !== value.ops.length) {
        throw new Error(`op count: got ${got.ops.length}, want ${value.ops.length}`)
      }
      for (let i = 0; i < got.ops.length; i++) {
        const gotOp = got.ops[i]
        const wantOp = value.ops[i]
        if (gotOp.disc !== wantOp.disc) {
          throw new Error(`op[${i}] disc: got ${gotOp.disc}, want ${wantOp.disc}`)
        }
        const wantPayload = fromHex(wantOp.payload_hex)
        if (!bytesEqual(gotOp.payload, wantPayload)) {
          throw new Error(`op[${i}] payload:\n  got:  ${toHex(gotOp.payload)}\n  want: ${toHex(wantPayload)}`)
        }
      }

      // encode → bytes match
      const ops = value.ops.map((/** @type {{disc:number,payload_hex:string}} */ op) => ({
        disc: op.disc,
        payload: fromHex(op.payload_hex),
      }))
      const enc = multiOpV0.encode(value.group_id, ops, value.ca ? fromHex(value.ca) : undefined)
      if (!bytesEqual(enc, bytes)) {
        throw new Error(`encode mismatch:\n  got:  ${toHex(enc)}\n  want: ${toHex(bytes)}`)
      }
    })
  }
}

// ---- negative: insert_v0 ----

function runNegativeInsertV0() {
  const dir = join(fixturesRoot, 'negative', 'insert_v0')
  for (const name of listSubdirs(dir)) {
    check(`negative/insert_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const expectedKind = readFileSync(join(caseDir, 'error.txt'), 'utf8').trim()

      let threw = /** @type {Error | null} */ (null)
      try {
        insertV0.decode(bytes)
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err))
      }
      if (!threw) {
        throw new Error(`expected error of kind ${expectedKind}, got no throw`)
      }
      const got = classifyInsertErr(threw)
      const want = expectedKind.startsWith('truncated_') ? 'truncated' : expectedKind
      if (got !== want) {
        throw new Error(`error kind: got ${got} (${threw.message}), want ${want}`)
      }
    })
  }
}

/** @param {Error} err */
function classifyInsertErr(err) {
  const m = err.message
  if (m.includes('invalid side')) return 'invalid_side'
  if (m.startsWith('insert_v0: truncated')) return 'truncated'
  return `unexpected:${m}`
}

// ---- negative: insert_bytes_v0 ----

function runNegativeInsertBytesV0() {
  const dir = join(fixturesRoot, 'negative', 'insert_bytes_v0')
  for (const name of listSubdirs(dir)) {
    check(`negative/insert_bytes_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const expectedKind = readFileSync(join(caseDir, 'error.txt'), 'utf8').trim()

      let threw = /** @type {Error | null} */ (null)
      try {
        insertBytesV0.decode(bytes)
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err))
      }
      if (!threw) {
        throw new Error(`expected error of kind ${expectedKind}, got no throw`)
      }
      const got = classifyInsertBytesErr(threw)
      const want = expectedKind.startsWith('truncated_') ? 'truncated' : expectedKind
      if (got !== want) {
        throw new Error(`error kind: got ${got} (${threw.message}), want ${want}`)
      }
    })
  }
}

/** @param {Error} err */
function classifyInsertBytesErr(err) {
  const m = err.message
  if (m.includes('invalid side')) return 'invalid_side'
  if (m.startsWith('insert_bytes_v0: truncated')) return 'truncated'
  return `unexpected:${m}`
}

// ---- negative: hide_v0 / show_v0 ----

/**
 * @param {string} typeName
 * @param {{ decode: any }} codec
 */
function runNegativeHideShow(typeName, codec) {
  const dir = join(fixturesRoot, 'negative', typeName)
  for (const name of listSubdirs(dir)) {
    check(`negative/${typeName}/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const expectedKind = readFileSync(join(caseDir, 'error.txt'), 'utf8').trim()
      const want = expectedKind.startsWith('truncated_') ? 'truncated' : expectedKind

      let threw = /** @type {Error | null} */ (null)
      try {
        codec.decode(bytes)
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err))
      }
      if (!threw) throw new Error(`expected ${want}, got no throw`)
      if (!threw.message.startsWith(`${typeName}: truncated`)) {
        throw new Error(`unexpected error message: ${threw.message}`)
      }
      if (want !== 'truncated') {
        throw new Error(`fixture expected non-truncated kind ${want} but codec only emits truncated`)
      }
    })
  }
}

// ---- negative: multi_op_v0 ----

function runNegativeMultiOpV0() {
  const dir = join(fixturesRoot, 'negative', 'multi_op_v0')
  for (const name of listSubdirs(dir)) {
    check(`negative/multi_op_v0/${name}`, () => {
      const caseDir = join(dir, name)
      const bytes = new Uint8Array(readFileSync(join(caseDir, 'bytes.bin')))
      const expectedKind = readFileSync(join(caseDir, 'error.txt'), 'utf8').trim()

      let threw = /** @type {Error | null} */ (null)
      try {
        multiOpV0.decode(bytes)
      } catch (err) {
        threw = err instanceof Error ? err : new Error(String(err))
      }
      if (!threw) {
        throw new Error(`expected error of kind ${expectedKind}, got no throw`)
      }
      const got = classifyMultiOpErr(threw)
      // Coalesce truncated_* into "truncated" for the JS classifier — same
      // strategy Go uses; the fixture name carries the precise sub-kind.
      const want = expectedKind.startsWith('truncated_') ? 'truncated' : expectedKind
      if (got !== want) {
        throw new Error(`error kind: got ${got} (${threw.message}), want ${want}`)
      }
    })
  }
}

/** @param {Error} err */
function classifyMultiOpErr(err) {
  const m = err.message
  if (m.includes('unknown inner disc')) return 'unknown_inner_disc'
  if (m.startsWith('multi_op_v0: truncated')) return 'truncated'
  return `unexpected:${m}`
}

// ---- main ----

runPositiveNodeIdV0()
runPositiveInsertV0()
runPositiveInsertBytesV0()
runPositiveHideShow('hide_v0', hideV0)
runPositiveHideShow('show_v0', showV0)
runPositiveAckV0()
runPositiveJsonEnvelopeV0()
runPositiveMultiOpV0()
runNegativeInsertV0()
runNegativeInsertBytesV0()
runNegativeHideShow('hide_v0', hideV0)
runNegativeHideShow('show_v0', showV0)
runNegativeAckV0()
runNegativeMultiOpV0()

if (failed > 0) {
  console.error(`\nFAIL: ${failed} failed, ${passed} passed`)
  for (const f of failures) console.error('\n' + f)
  process.exit(1)
}
console.log(`PASS: ${passed} fixtures`)
