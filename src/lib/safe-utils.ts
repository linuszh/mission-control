import fs from 'node:fs'
import { readFile, stat } from 'node:fs/promises'

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024 // 10 MB

/**
 * Wraps JSON.parse in a try/catch, returning `fallback` on parse failure.
 */
export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * Wraps `await request.json()` in a try/catch, returning null on malformed body.
 */
export async function safeRequestJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

/**
 * Reads a file synchronously with a size guard.
 * Returns null if the file doesn't exist, exceeds maxBytes, or read fails.
 */
export function readFileSafe(filePath: string, opts?: { maxBytes?: number }): string | null {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  try {
    const st = fs.statSync(filePath)
    if (st.size > maxBytes) return null
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Reads a file asynchronously with a size guard.
 * Returns null if the file doesn't exist, exceeds maxBytes, or read fails.
 */
export async function readFileAsync(filePath: string, opts?: { maxBytes?: number }): Promise<string | null> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES
  try {
    const st = await stat(filePath)
    if (st.size > maxBytes) return null
    return await readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * Escapes SQL LIKE wildcard characters (% and _) in user input.
 * Use with `ESCAPE '\\'` in the LIKE clause.
 */
export function escapeLikeWildcards(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}
