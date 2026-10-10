// @ts-check
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { CrdtErrorKind, CrdtErrorNames, parseCrdtError } from './crdt_error.js'

// The single source of truth for the WASM↔JS error contract — the Zig side
// asserts against the same file in rogue.zig (`error kinds match the shared
// fixture`), so a drift on either side fails CI.
const here = dirname(fileURLToPath(import.meta.url))
/** @type {{ name: string, code: number }[]} */
const fixture = JSON.parse(readFileSync(resolve(here, '../crdt/error_kinds.json'), 'utf8'))

describe('CrdtErrorKind conformance', () => {
  it('matches the shared error_kinds.json fixture', () => {
    const entries = Object.entries(CrdtErrorKind)
    expect(entries).toHaveLength(fixture.length)
    for (const { name, code } of fixture) {
      expect(CrdtErrorKind[name]).toBe(code)
      expect(CrdtErrorNames[code]).toBe(name)
    }
    for (const [name, code] of entries) {
      expect(fixture.some((e) => e.name === name && e.code === code)).toBe(true)
    }
  })

  it('parses a structured error payload', () => {
    expect(parseCrdtError('{"type":1,"name":"out_of_memory"}')).toEqual({
      type: 1,
      name: 'out_of_memory',
      desc: undefined,
    })
    expect(parseCrdtError('{"type":5,"name":"render_overflow","desc":"big"}')).toEqual({
      type: 5,
      name: 'render_overflow',
      desc: 'big',
    })
    expect(parseCrdtError('garbage')).toBeNull()
    expect(parseCrdtError('{"type":"x"}')).toBeNull()
  })
})
