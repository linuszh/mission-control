import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { safeJsonParse, safeRequestJson, readFileSafe, readFileAsync, escapeLikeWildcards } from '../safe-utils'

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}', {})).toEqual({ a: 1 })
    expect(safeJsonParse('[1,2,3]', [])).toEqual([1, 2, 3])
    expect(safeJsonParse('"hello"', '')).toBe('hello')
  })

  it('returns fallback on invalid JSON', () => {
    expect(safeJsonParse('not json', {})).toEqual({})
    expect(safeJsonParse('', [])).toEqual([])
    expect(safeJsonParse('{broken', null)).toBeNull()
  })

  it('returns fallback on empty string', () => {
    expect(safeJsonParse('', 'default')).toBe('default')
  })
})

describe('safeRequestJson', () => {
  it('returns parsed JSON from valid request', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ test: true }),
    })
    expect(await safeRequestJson(req)).toEqual({ test: true })
  })

  it('returns null on malformed body', async () => {
    const req = new Request('http://localhost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(await safeRequestJson(req)).toBeNull()
  })
})

describe('readFileSafe', () => {
  const testPath = '/tmp/safe-utils-test.txt'

  beforeEach(() => {
    try { fs.unlinkSync(testPath) } catch { /* ignore */ }
  })
  afterEach(() => {
    try { fs.unlinkSync(testPath) } catch { /* ignore */ }
  })

  it('reads file within size limit', () => {
    fs.writeFileSync(testPath, 'hello world')
    expect(readFileSafe(testPath)).toBe('hello world')
  })

  it('returns null for file exceeding maxBytes', () => {
    fs.writeFileSync(testPath, 'x'.repeat(100))
    expect(readFileSafe(testPath, { maxBytes: 50 })).toBeNull()
  })

  it('returns null for non-existent file', () => {
    expect(readFileSafe('/tmp/does-not-exist-safe-utils.txt')).toBeNull()
  })
})

describe('readFileAsync', () => {
  const testPath = '/tmp/safe-utils-async-test.txt'

  beforeEach(() => {
    try { fs.unlinkSync(testPath) } catch { /* ignore */ }
  })
  afterEach(() => {
    try { fs.unlinkSync(testPath) } catch { /* ignore */ }
  })

  it('reads file within size limit', async () => {
    fs.writeFileSync(testPath, 'async hello')
    expect(await readFileAsync(testPath)).toBe('async hello')
  })

  it('returns null for file exceeding maxBytes', async () => {
    fs.writeFileSync(testPath, 'x'.repeat(100))
    expect(await readFileAsync(testPath, { maxBytes: 50 })).toBeNull()
  })

  it('returns null for non-existent file', async () => {
    expect(await readFileAsync('/tmp/does-not-exist-safe-utils-async.txt')).toBeNull()
  })
})

describe('escapeLikeWildcards', () => {
  it('escapes percent sign', () => {
    expect(escapeLikeWildcards('100%')).toBe('100\\%')
  })

  it('escapes underscore', () => {
    expect(escapeLikeWildcards('foo_bar')).toBe('foo\\_bar')
  })

  it('escapes backslash', () => {
    expect(escapeLikeWildcards('path\\file')).toBe('path\\\\file')
  })

  it('leaves normal text unchanged', () => {
    expect(escapeLikeWildcards('hello world')).toBe('hello world')
  })

  it('handles multiple wildcards', () => {
    expect(escapeLikeWildcards('%_test_%')).toBe('\\%\\_test\\_\\%')
  })
})
