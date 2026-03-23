import { readdir, readFile, rename, stat } from 'node:fs/promises'
import path from 'node:path'

export interface OpenClawDoctorFixResult {
  archivedOrphans: number
  storesScanned: number
}

function formatArchiveTimestamp(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().replaceAll(':', '-')
}

function isPrimaryTranscriptFile(fileName: string): boolean {
  return fileName !== 'sessions.json' && fileName.endsWith('.jsonl')
}

function collectReferencedTranscriptNames(store: Record<string, unknown>): Set<string> {
  const referenced = new Set<string>()

  for (const entry of Object.values(store)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>

    if (typeof record.sessionId === 'string' && record.sessionId.trim()) {
      referenced.add(`${record.sessionId.trim()}.jsonl`)
    }

    if (typeof record.sessionFile === 'string' && record.sessionFile.trim()) {
      const sessionFileName = path.basename(record.sessionFile.trim())
      if (isPrimaryTranscriptFile(sessionFileName)) {
        referenced.add(sessionFileName)
      }
    }
  }

  return referenced
}

export async function archiveOrphanTranscriptsForStateDir(stateDir: string): Promise<OpenClawDoctorFixResult> {
  const agentsDir = path.join(stateDir, 'agents')
  const agentsDirExists = await stat(agentsDir).catch(() => null)
  if (!agentsDirExists) {
    return { archivedOrphans: 0, storesScanned: 0 }
  }

  let archivedOrphans = 0
  let storesScanned = 0

  for (const agentName of await readdir(agentsDir)) {
    const sessionsDir = path.join(agentsDir, agentName, 'sessions')
    const sessionsFile = path.join(sessionsDir, 'sessions.json')
    const sessionsFileExists = await stat(sessionsFile).catch(() => null)
    if (!sessionsFileExists) continue

    storesScanned += 1

    let store: Record<string, unknown>
    try {
      store = JSON.parse(await readFile(sessionsFile, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }

    const referenced = collectReferencedTranscriptNames(store)
    const archiveTimestamp = formatArchiveTimestamp()

    for (const entry of await readdir(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !isPrimaryTranscriptFile(entry.name)) continue
      if (referenced.has(entry.name)) continue

      const sourcePath = path.join(sessionsDir, entry.name)
      const archivePath = `${sourcePath}.deleted.${archiveTimestamp}`
      await rename(sourcePath, archivePath)
      archivedOrphans += 1
    }
  }

  return { archivedOrphans, storesScanned }
}
