// @ts-check
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { resolveReplicaId, syncBaseUrlFromWsUrl, persistedReplicaId } from './replica.js'

const DOC = 'doc-1'
const WS_URL = 'wss://sync.example.com/ws/doc-1'
const getToken = async () => 'token-123'

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('syncBaseUrlFromWsUrl', () => {
  it('maps wss → https and strips the path', () => {
    expect(syncBaseUrlFromWsUrl('wss://sync.example.com/ws/doc-1')).toBe('https://sync.example.com')
  })

  it('maps ws → http', () => {
    expect(syncBaseUrlFromWsUrl('ws://localhost:8080/ws/doc-1')).toBe('http://localhost:8080')
  })
})

describe('persistedReplicaId', () => {
  it('returns null when absent', () => {
    expect(persistedReplicaId(DOC)).toBeNull()
  })

  it('returns the stored number', () => {
    localStorage.setItem('rogue.replicaId.' + DOC, '42')
    expect(persistedReplicaId(DOC)).toBe(42)
  })

  it('ignores invalid values', () => {
    localStorage.setItem('rogue.replicaId.' + DOC, 'not-a-number')
    expect(persistedReplicaId(DOC)).toBeNull()
  })

  it('ignores out-of-range values', () => {
    localStorage.setItem('rogue.replicaId.' + DOC, '70000')
    expect(persistedReplicaId(DOC)).toBeNull()
  })
})

describe('resolveReplicaId', () => {
  it('returns the persisted id without a server round-trip', async () => {
    localStorage.setItem('rogue.replicaId.' + DOC, '7')
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const id = await resolveReplicaId({ docId: DOC, wsUrl: WS_URL, getToken })

    expect(id).toBe(7)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('claims replica 1 for a new doc, offline-friendly, no fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const id = await resolveReplicaId({ docId: DOC, wsUrl: WS_URL, getToken, isNewDoc: true })

    expect(id).toBe(1)
    expect(localStorage.getItem('rogue.replicaId.' + DOC)).toBe('1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('allocates from the server and persists the result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ replica_id: 5 }) })
    vi.stubGlobal('fetch', fetchMock)

    const id = await resolveReplicaId({ docId: DOC, wsUrl: WS_URL, getToken })

    expect(id).toBe(5)
    expect(fetchMock).toHaveBeenCalledWith('https://sync.example.com/docs/doc-1/replica', {
      method: 'POST',
      headers: { Authorization: 'Bearer token-123' },
    })
    expect(localStorage.getItem('rogue.replicaId.' + DOC)).toBe('5')
  })

  it('reuses a persisted id across calls (no re-allocation)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ replica_id: 9 }) })
    vi.stubGlobal('fetch', fetchMock)

    const first = await resolveReplicaId({ docId: DOC, wsUrl: WS_URL, getToken })
    const second = await resolveReplicaId({ docId: DOC, wsUrl: WS_URL, getToken })

    expect(first).toBe(9)
    expect(second).toBe(9)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws when allocation fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }))

    await expect(resolveReplicaId({ docId: DOC, wsUrl: WS_URL, getToken })).rejects.toThrow(
      'replica allocation failed: 500',
    )
  })

  it('read-only peer skips allocation entirely (no /replica 403)', async () => {
    const fetchMock = vi.fn()
    const getTokenMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const id = await resolveReplicaId({ docId: DOC, wsUrl: WS_URL, getToken: getTokenMock, readOnly: true })

    expect(id).toBeGreaterThanOrEqual(1)
    expect(id).toBeLessThanOrEqual(65534)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(getTokenMock).not.toHaveBeenCalled()
    expect(localStorage.getItem('rogue.replicaId.' + DOC)).toBeNull()
  })
})
