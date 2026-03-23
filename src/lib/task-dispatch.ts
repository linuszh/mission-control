import { getDatabase, db_helpers } from './db'
import { runOpenClaw, runCommand } from './command'
import { callOpenClawGateway } from './openclaw-gateway'
import { eventBus } from './event-bus'
import { logger } from './logger'
import { config } from './config'
import { recordSpawnStart, recordSpawnFinish } from './spawn-history'

interface DispatchableTask {
  id: number
  title: string
  description: string | null
  status: string
  priority: string
  assigned_to: string
  workspace_id: number
  agent_name: string
  agent_id: number
  agent_config: string | null
  ticket_prefix: string | null
  project_ticket_no: number | null
  project_id: number | null
  tags?: string[]
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

/**
 * Classify a task's complexity and return the appropriate model ID to pass
 * to the OpenClaw gateway. Uses keyword signals on title + description.
 *
 * Tiers:
 *   ROUTINE  → cheap model (Haiku)   — file ops, status checks, formatting
 *   MODERATE → mid model  (Sonnet)   — code gen, summaries, analysis, drafts
 *   COMPLEX  → premium model (Opus)  — debugging, architecture, novel problems
 *
 * The caller may override this by setting agent.config.dispatchModel.
 */
function classifyTaskModel(task: DispatchableTask): string | null {
  // Allow per-agent config override
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) return cfg.dispatchModel
    } catch { /* ignore */ }
  }

  const text = `${task.title} ${task.description ?? ''}`.toLowerCase()
  const priority = task.priority?.toLowerCase() ?? ''

  // Complex signals → Opus
  const complexSignals = [
    'debug', 'diagnos', 'architect', 'design system', 'security audit',
    'root cause', 'investigate', 'incident', 'failure', 'broken', 'not working',
    'refactor', 'migration', 'performance optim', 'why is',
  ]
  if (priority === 'critical' || complexSignals.some(s => text.includes(s))) {
    return '9router/cc/claude-opus-4-6'
  }

  // Routine signals → Haiku
  const routineSignals = [
    'status check', 'health check', 'ping', 'list ', 'fetch ', 'format',
    'rename', 'move file', 'read file', 'update readme', 'bump version',
    'send message', 'post to', 'notify', 'summarize', 'translate',
    'quick ', 'simple ', 'routine ', 'minor ',
  ]
  if (priority === 'low' && routineSignals.some(s => text.includes(s))) {
    return '9router/cc/claude-haiku-4-5-20251001'
  }
  if (routineSignals.some(s => text.includes(s)) && priority !== 'high' && priority !== 'critical') {
    return '9router/cc/claude-haiku-4-5-20251001'
  }

  // Default: let the agent's own configured model handle it (no override)
  return null
}

/** Extract the gateway agent identifier from the agent's config JSON.
 *  Falls back to agent_name (display name) if openclawId is not set. */
function resolveGatewayAgentId(task: DispatchableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.agent_name
}

function buildTaskPrompt(task: DispatchableTask, rejectionFeedback?: string | null): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You have been assigned a task in Mission Control.',
    '',
    `**[${ticket}] ${task.title}**`,
    `Priority: ${task.priority}`,
  ]

  if (task.tags && task.tags.length > 0) {
    lines.push(`Tags: ${task.tags.join(', ')}`)
  }

  if (task.description) {
    lines.push('', task.description)
  }

  if (rejectionFeedback) {
    lines.push('', '## Previous Review Feedback', rejectionFeedback, '', 'Please address this feedback in your response.')
  }

  lines.push('', 'Complete this task and provide your response. Be concise and actionable.')
  return lines.join('\n')
}

/** Extract first valid JSON object from raw stdout (handles surrounding text/warnings). */
function parseGatewayJson(raw: string): any | null {
  const trimmed = String(raw || '').trim()
  if (!trimmed) return null
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

interface AgentResponseParsed {
  text: string | null
  sessionId: string | null
}

function parseAgentResponse(stdout: string): AgentResponseParsed {
  try {
    const parsed = JSON.parse(stdout)
    const sessionId: string | null = typeof parsed?.sessionId === 'string' ? parsed.sessionId
      : typeof parsed?.session_id === 'string' ? parsed.session_id
      : null

    // OpenClaw agent --json returns { payloads: [{ text: "..." }] }
    if (parsed?.payloads?.[0]?.text) {
      return { text: parsed.payloads[0].text, sessionId }
    }
    // Fallback: if there's a result or output field
    if (parsed?.result) return { text: String(parsed.result), sessionId }
    if (parsed?.output) return { text: String(parsed.output), sessionId }
    // Last resort: stringify the whole response
    return { text: JSON.stringify(parsed, null, 2), sessionId }
  } catch {
    // Not valid JSON — return raw stdout if non-empty
    return { text: stdout.trim() || null, sessionId: null }
  }
}

// ---------------------------------------------------------------------------
// Direct Claude API dispatch (gateway-free)
// ---------------------------------------------------------------------------

function getAnthropicApiKey(): string | null {
  return (process.env.ANTHROPIC_API_KEY || '').trim() || null
}

function isGatewayAvailable(): boolean {
  // Gateway is available if OpenClaw is installed OR a gateway is registered in the DB
  if (config.openclawHome) return true
  try {
    const db = getDatabase()
    const row = db.prepare('SELECT COUNT(*) as c FROM gateways').get() as { c: number } | undefined
    return (row?.c ?? 0) > 0
  } catch {
    return false
  }
}

function classifyDirectModel(task: DispatchableTask): string {
  // Check per-agent config override first
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.dispatchModel === 'string' && cfg.dispatchModel) {
        // Strip gateway prefixes like "9router/cc/" to get bare model ID
        return cfg.dispatchModel.replace(/^.*\//, '')
      }
    } catch { /* ignore */ }
  }

  const text = `${task.title} ${task.description ?? ''}`.toLowerCase()
  const priority = task.priority?.toLowerCase() ?? ''

  // Complex → Opus
  const complexSignals = [
    'debug', 'diagnos', 'architect', 'design system', 'security audit',
    'root cause', 'investigate', 'incident', 'refactor', 'migration',
  ]
  if (priority === 'critical' || complexSignals.some(s => text.includes(s))) {
    return 'claude-opus-4-6'
  }

  // Routine → Haiku
  const routineSignals = [
    'status check', 'health check', 'format', 'rename', 'summarize',
    'translate', 'quick ', 'simple ', 'routine ', 'minor ',
  ]
  if (routineSignals.some(s => text.includes(s)) && priority !== 'high' && priority !== 'critical') {
    return 'claude-haiku-4-5-20251001'
  }

  // Default → Sonnet
  return 'claude-sonnet-4-6'
}

function getAgentSoulContent(task: DispatchableTask): string | null {
  try {
    const db = getDatabase()
    const row = db.prepare(
      'SELECT soul_content FROM agents WHERE id = ? AND workspace_id = ?'
    ).get(task.agent_id, task.workspace_id) as { soul_content: string | null } | undefined
    return row?.soul_content || null
  } catch {
    return null
  }
}

async function callClaudeDirectly(
  task: DispatchableTask,
  prompt: string,
): Promise<AgentResponseParsed> {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set — cannot dispatch without gateway')

  const model = classifyDirectModel(task)
  const soul = getAgentSoulContent(task)

  const messages: Array<{ role: string; content: string }> = [
    { role: 'user', content: prompt },
  ]

  const body: Record<string, unknown> = {
    model,
    max_tokens: 4096,
    messages,
  }

  if (soul) {
    body.system = soul
  }

  logger.info({ taskId: task.id, model, agent: task.agent_name }, 'Dispatching task via direct Claude API')

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '')
    throw new Error(`Claude API ${res.status}: ${errorBody.substring(0, 500)}`)
  }

  const data = await res.json() as {
    content: Array<{ type: string; text?: string }>
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  const text = data.content
    ?.filter((b: { type: string }) => b.type === 'text')
    .map((b: { text?: string }) => b.text || '')
    .join('\n') || null

  // Record token usage
  if (data.usage) {
    try {
      const db = getDatabase()
      const now = Math.floor(Date.now() / 1000)
      db.prepare(`
        INSERT INTO token_usage (model, session_id, input_tokens, output_tokens, total_tokens, cost, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        model,
        `task-${task.id}`,
        data.usage.input_tokens || 0,
        data.usage.output_tokens || 0,
        (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0),
        0, // cost calculated separately
        now,
        task.workspace_id,
      )
    } catch { /* non-fatal */ }
  }

  return { text, sessionId: null }
}

interface ReviewableTask {
  id: number
  title: string
  description: string | null
  resolution: string | null
  assigned_to: string | null
  agent_config: string | null
  workspace_id: number
  ticket_prefix: string | null
  project_ticket_no: number | null
}

function resolveGatewayAgentIdForReview(task: ReviewableTask): string {
  if (task.agent_config) {
    try {
      const cfg = JSON.parse(task.agent_config)
      if (typeof cfg.openclawId === 'string' && cfg.openclawId) return cfg.openclawId
    } catch { /* ignore */ }
  }
  return task.assigned_to || 'jarv'
}

function buildReviewPrompt(task: ReviewableTask): string {
  const ticket = task.ticket_prefix && task.project_ticket_no
    ? `${task.ticket_prefix}-${String(task.project_ticket_no).padStart(3, '0')}`
    : `TASK-${task.id}`

  const lines = [
    'You are Aegis, the quality reviewer for Mission Control.',
    'Review the following completed task and its resolution.',
    '',
    `**[${ticket}] ${task.title}**`,
  ]

  if (task.description) {
    lines.push('', '## Task Description', task.description)
  }

  if (task.resolution) {
    lines.push('', '## Agent Resolution', task.resolution.substring(0, 6000))
  }

  lines.push(
    '',
    '## Instructions',
    'Evaluate whether the agent\'s response adequately addresses the task.',
    'Respond with EXACTLY one of these two formats:',
    '',
    'If the work is acceptable:',
    'VERDICT: APPROVED',
    'NOTES: <brief summary of why it passes>',
    '',
    'If the work needs improvement:',
    'VERDICT: REJECTED',
    'NOTES: <specific issues that need to be fixed>',
  )

  return lines.join('\n')
}

function parseReviewVerdict(text: string): { status: 'approved' | 'rejected'; notes: string } {
  const upper = text.toUpperCase()
  const status = upper.includes('VERDICT: APPROVED') ? 'approved' as const : 'rejected' as const
  const notesMatch = text.match(/NOTES:\s*([\s\S]+)/i)
  const notes = notesMatch?.[1]?.trim().substring(0, 4000) || (status === 'approved' ? 'Quality check passed' : 'Quality check failed')
  return { status, notes }
}

/**
 * Run Aegis quality reviews on tasks in 'review' status.
 * Uses an agent to evaluate the task resolution, then approves or rejects.
 */
export async function runAegisReviews(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.id, t.title, t.description, t.resolution, t.assigned_to, t.workspace_id,
           p.ticket_prefix, t.project_ticket_no, a.config as agent_config
    FROM tasks t
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'review'
    ORDER BY t.updated_at ASC
    LIMIT 3
  `).all() as ReviewableTask[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No tasks awaiting review' }
  }

  const results: Array<{ id: number; verdict: string; error?: string }> = []

  for (const task of tasks) {
    // Move to quality_review to prevent re-processing
    db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .run('quality_review', Math.floor(Date.now() / 1000), task.id)

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'quality_review',
      previous_status: 'review',
    })

    // Record Aegis spawn for runs dashboard
    const aegisSpawnId = recordSpawnStart({
      agentName: 'aegis',
      spawnType: 'claude-code',
      trigger: 'agent',
      workspaceId: task.workspace_id,
    })
    const aegisStartTime = Date.now()

    try {
      const prompt = buildReviewPrompt(task)

      // Use Claude Code CLI with a cheap model for quality reviews
      const aegisResult = await runCommand(config.claudeBin, [
        '-p', prompt,
        '--output-format', 'json',
        '--dangerously-skip-permissions',
        '--model', 'haiku',
      ], {
        timeoutMs: 120_000,
        env: { ...process.env, HOME: config.claudeHome, CLAUDE_CONFIG_DIR: config.claudeHome },
        input: '',
      })

      recordSpawnFinish(aegisSpawnId, { status: 'completed', durationMs: Date.now() - aegisStartTime })
      const agentResponse = parseAgentResponse(aegisResult.stdout)
      if (!agentResponse.text) {
        throw new Error('Aegis review returned empty response')
      }

      const verdict = parseReviewVerdict(agentResponse.text)

      // Insert quality review record
      db.prepare(`
        INSERT INTO quality_reviews (task_id, reviewer, status, notes, workspace_id)
        VALUES (?, 'aegis', ?, ?, ?)
      `).run(task.id, verdict.status, verdict.notes, task.workspace_id)

      if (verdict.status === 'approved') {
        db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
          .run('done', Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'done',
          previous_status: 'quality_review',
        })
      } else {
        // Rejected: check dispatch_attempts to decide next status
        const now = Math.floor(Date.now() / 1000)
        const currentAttempts = (db.prepare('SELECT dispatch_attempts FROM tasks WHERE id = ?').get(task.id) as { dispatch_attempts: number } | undefined)?.dispatch_attempts ?? 0
        const newAttempts = currentAttempts + 1
        const maxAegisRetries = 3

        if (newAttempts >= maxAegisRetries) {
          // Too many rejections — move to failed
          db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
            .run('failed', `Aegis rejected ${newAttempts} times. Last: ${verdict.notes}`, newAttempts, now, task.id)

          eventBus.broadcast('task.status_changed', {
            id: task.id,
            status: 'failed',
            previous_status: 'quality_review',
            error_message: `Aegis rejected ${newAttempts} times`,
            reason: 'max_aegis_retries_exceeded',
          })
        } else {
          // Requeue to assigned for re-dispatch with feedback
          db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
            .run('assigned', `Aegis rejected: ${verdict.notes}`, newAttempts, now, task.id)

          eventBus.broadcast('task.status_changed', {
            id: task.id,
            status: 'assigned',
            previous_status: 'quality_review',
            error_message: `Aegis rejected: ${verdict.notes}`,
            reason: 'aegis_rejection',
          })
        }

        // Add rejection as a comment so the agent sees it on next dispatch
        db.prepare(`
          INSERT INTO comments (task_id, author, content, created_at, workspace_id)
          VALUES (?, 'aegis', ?, ?, ?)
        `).run(task.id, `Quality Review Rejected (attempt ${newAttempts}/${maxAegisRetries}):\n${verdict.notes}`, now, task.workspace_id)
      }

      db_helpers.logActivity(
        'aegis_review',
        'task',
        task.id,
        'aegis',
        `Aegis ${verdict.status} task "${task.title}": ${verdict.notes.substring(0, 200)}`,
        { verdict: verdict.status, notes: verdict.notes },
        task.workspace_id
      )

      results.push({ id: task.id, verdict: verdict.status })
      logger.info({ taskId: task.id, verdict: verdict.status }, 'Aegis review completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, err }, 'Aegis review failed')
      try { recordSpawnFinish(aegisSpawnId, { status: 'failed', error: errorMsg, durationMs: Date.now() - aegisStartTime }) } catch { /* non-fatal */ }

      // Revert to review so it can be retried
      db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
        .run('review', Math.floor(Date.now() / 1000), task.id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'quality_review',
      })

      results.push({ id: task.id, verdict: 'error', error: errorMsg.substring(0, 100) })
    }
  }

  const approved = results.filter(r => r.verdict === 'approved').length
  const rejected = results.filter(r => r.verdict === 'rejected').length
  const errors = results.filter(r => r.verdict === 'error').length

  return {
    ok: errors === 0,
    message: `Reviewed ${tasks.length}: ${approved} approved, ${rejected} rejected${errors ? `, ${errors} error(s)` : ''}`,
  }
}

/**
 * Requeue stale tasks stuck in 'in_progress' whose assigned agent is offline.
 * Prevents tasks from being permanently stuck when agents crash or disconnect.
 */
export async function requeueStaleTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)
  const staleThreshold = now - 10 * 60 // 10 minutes
  const longRunningThreshold = now - 30 * 60 // 30 minutes — requeue regardless of agent status
  const maxDispatchRetries = 5

  const staleTasks = db.prepare(`
    SELECT t.id, t.title, t.assigned_to, t.dispatch_attempts, t.workspace_id,
           t.updated_at as task_updated_at,
           a.status as agent_status, a.last_seen as agent_last_seen
    FROM tasks t
    LEFT JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    WHERE t.status = 'in_progress'
      AND (t.updated_at < ? OR t.updated_at < ?)
  `).all(staleThreshold, longRunningThreshold) as Array<{
    id: number; title: string; assigned_to: string | null; dispatch_attempts: number
    workspace_id: number; task_updated_at: number; agent_status: string | null; agent_last_seen: number | null
  }>

  if (staleTasks.length === 0) {
    return { ok: true, message: 'No stale tasks found' }
  }

  let requeued = 0
  let failed = 0

  for (const task of staleTasks) {
    const agentOffline = !task.agent_status || task.agent_status === 'offline'
    const longRunning = task.task_updated_at < longRunningThreshold

    // Requeue if the agent is offline/unknown, or if the task has been in_progress
    // for more than 30 minutes (covers MC process crash where agent may still appear active)
    if (!agentOffline && !longRunning) continue

    const newAttempts = (task.dispatch_attempts ?? 0) + 1

    if (newAttempts >= maxDispatchRetries) {
      const reason = longRunning && !agentOffline
        ? `Task stuck in_progress for over 30 minutes (${newAttempts} attempts) — agent "${task.assigned_to}" may have been orphaned by an MC restart. Moved to failed.`
        : `Task stuck in_progress ${newAttempts} times — agent "${task.assigned_to}" offline. Moved to failed.`

      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
        .run('failed', reason, newAttempts, now, task.id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'failed',
        previous_status: 'in_progress',
        error_message: `Stale task — agent offline after ${newAttempts} attempts`,
        reason: 'stale_task_max_retries',
      })

      failed++
    } else {
      const comment = longRunning && !agentOffline
        ? `Task requeued (attempt ${newAttempts}/${maxDispatchRetries}): task was in_progress for over 30 minutes — possible MC restart orphaned the task while agent "${task.assigned_to}" was still active.`
        : `Task requeued (attempt ${newAttempts}/${maxDispatchRetries}): agent "${task.assigned_to}" went offline while task was in_progress.`

      db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
        .run('assigned', comment, newAttempts, now, task.id)

      // Add a comment explaining the requeue
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, 'scheduler', ?, ?, ?)
      `).run(task.id, comment, now, task.workspace_id)

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'assigned',
        previous_status: 'in_progress',
        error_message: longRunning && !agentOffline
          ? `Task orphaned after MC restart (in_progress > 30 min)`
          : `Agent "${task.assigned_to}" went offline`,
        reason: 'stale_task_requeue',
      })

      requeued++
    }
  }

  const total = requeued + failed
  return {
    ok: true,
    message: total === 0
      ? `Found ${staleTasks.length} stale task(s) but agents still online`
      : `Requeued ${requeued}, failed ${failed} of ${staleTasks.length} stale task(s)`,
  }
}

// ---------------------------------------------------------------------------
// Claude Code CLI dispatch
// ---------------------------------------------------------------------------

/** Resolve the dispatch mode from agent config. Defaults to 'auto'. */
function resolveDispatchMode(task: DispatchableTask): 'cli' | 'gateway' | 'auto' {
  if (!task.agent_config) return 'auto'
  try {
    const cfg = JSON.parse(task.agent_config)
    if (cfg.dispatchMode === 'cli' || cfg.dispatchMode === 'gateway') return cfg.dispatchMode
  } catch { /* ignore */ }
  return 'auto'
}

/** Resolve the Claude Code agent name from agent config. Returns null if not a CC agent. */
function resolveClaudeAgent(task: DispatchableTask): string | null {
  if (!task.agent_config) return null
  try {
    const cfg = JSON.parse(task.agent_config)
    if (typeof cfg.agentFile === 'string' && cfg.agentFile) {
      // agentFile is e.g. "dev.md" → agent name is "dev"
      return cfg.agentFile.replace(/\.md$/, '')
    }
  } catch { /* ignore */ }
  return null
}

/** Dispatch a task to a Claude Code CLI agent with spawn tracking. */
async function runClaudeCodeTask(
  task: DispatchableTask,
  prompt: string,
  agentName: string,
): Promise<AgentResponseParsed> {
  const db = getDatabase()
  const now = Math.floor(Date.now() / 1000)

  // Record spawn start → auto-creates AgentRun entry
  const spawnId = recordSpawnStart({
    agentName: task.agent_name,
    agentId: task.agent_id,
    spawnType: 'claude-code',
    trigger: 'agent',
    workspaceId: task.workspace_id,
  })

  // Mark agent as busy
  db.prepare('UPDATE agents SET status = ?, last_seen = ?, last_activity = ?, updated_at = ? WHERE id = ?')
    .run('busy', now, `Running task: ${task.title}`, now, task.agent_id)
  eventBus.broadcast('agent.status_changed', {
    id: task.agent_id,
    name: task.agent_name,
    status: 'busy',
    last_seen: now,
  })

  const startTime = Date.now()

  // Don't pass model override — Claude Code agents have their own model config.
  const args = [
    '-p', prompt,
    '--output-format', 'json',
    '--dangerously-skip-permissions',
    '--agent', agentName,
  ]

  logger.info({ taskId: task.id, agent: task.agent_name, claudeAgent: agentName }, 'Dispatching task via Claude Code CLI')

  try {
    const result = await runCommand(config.claudeBin, args, {
      timeoutMs: 1_800_000, // 30 minutes
      env: { ...process.env, HOME: config.claudeHome, CLAUDE_CONFIG_DIR: config.claudeHome },
      input: '', // prevent stdin warning
    })

    const durationMs = Date.now() - startTime
    recordSpawnFinish(spawnId, { status: 'completed', durationMs })

    // Mark agent as idle
    const afterNow = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE agents SET status = ?, last_seen = ?, last_activity = ?, updated_at = ? WHERE id = ?')
      .run('idle', afterNow, `Completed task: ${task.title}`, afterNow, task.agent_id)
    eventBus.broadcast('agent.status_changed', {
      id: task.agent_id,
      name: task.agent_name,
      status: 'idle',
      last_seen: afterNow,
    })

    return parseAgentResponse(result.stdout)
  } catch (err: any) {
    const durationMs = Date.now() - startTime
    recordSpawnFinish(spawnId, { status: 'failed', error: err.message, durationMs })

    // Mark agent as idle even on failure
    const afterNow = Math.floor(Date.now() / 1000)
    db.prepare('UPDATE agents SET status = ?, last_seen = ?, updated_at = ? WHERE id = ?')
      .run('idle', afterNow, afterNow, task.agent_id)
    eventBus.broadcast('agent.status_changed', {
      id: task.agent_id,
      name: task.agent_name,
      status: 'idle',
      last_seen: afterNow,
    })

    throw err
  }
}

export async function dispatchAssignedTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const tasks = db.prepare(`
    SELECT t.*, a.name as agent_name, a.id as agent_id, a.config as agent_config,
           p.ticket_prefix, t.project_ticket_no
    FROM tasks t
    JOIN agents a ON a.name = t.assigned_to AND a.workspace_id = t.workspace_id
    LEFT JOIN projects p ON p.id = t.project_id AND p.workspace_id = t.workspace_id
    WHERE t.status = 'assigned'
      AND t.assigned_to IS NOT NULL
    ORDER BY
      CASE t.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      t.created_at ASC
    LIMIT 3
  `).all() as (DispatchableTask & { tags?: string })[]

  if (tasks.length === 0) {
    return { ok: true, message: 'No assigned tasks to dispatch' }
  }

  // Parse JSON tags column
  for (const task of tasks) {
    if (typeof task.tags === 'string') {
      try { task.tags = JSON.parse(task.tags as string) } catch { task.tags = undefined }
    }
  }

  // Filter out tasks whose dependencies aren't done yet
  const readyTasks = tasks.filter(task => {
    try {
      const metaRow = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
      const meta = metaRow?.metadata ? JSON.parse(metaRow.metadata) : {}
      const rawDeps: number[] = Array.isArray(meta.depends_on) ? meta.depends_on : []
      const deps = rawDeps.filter(d => d !== task.id) // ignore self-references
      if (deps.length === 0) return true

      const placeholders = deps.map(() => '?').join(',')
      const doneCount = (db.prepare(
        `SELECT COUNT(*) as c FROM tasks WHERE id IN (${placeholders}) AND status = 'done'`
      ).get(...deps) as { c: number }).c

      if (doneCount < deps.length) {
        logger.info({ taskId: task.id, deps, doneCount, total: deps.length }, 'Task blocked by unfinished dependencies, skipping')
        return false
      }
      return true
    } catch { return true }
  })

  if (readyTasks.length === 0 && tasks.length > 0) {
    return { ok: true, message: `${tasks.length} assigned task(s) blocked by dependencies` }
  }

  const results: Array<{ id: number; success: boolean; error?: string }> = []
  const now = Math.floor(Date.now() / 1000)

  for (const task of readyTasks) {
    // Mark as in_progress immediately to prevent re-dispatch.
    // Use optimistic locking: only claim the task if it is still 'assigned'.
    // If another dispatcher already claimed it, changes will be 0 — skip.
    const claimResult = db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ? AND status = \'assigned\'')
      .run('in_progress', now, task.id)

    if (claimResult.changes === 0) {
      logger.info({ taskId: task.id }, 'Task already claimed by another dispatcher, skipping')
      continue
    }

    eventBus.broadcast('task.status_changed', {
      id: task.id,
      status: 'in_progress',
      previous_status: 'assigned',
    })

    db_helpers.logActivity(
      'task_dispatched',
      'task',
      task.id,
      'scheduler',
      `Dispatching task "${task.title}" to agent ${task.agent_name}`,
      { agent: task.agent_name, priority: task.priority },
      task.workspace_id
    )

    try {
      // Check for previous Aegis rejection feedback
      const rejectionRow = db.prepare(`
        SELECT content FROM comments
        WHERE task_id = ? AND author = 'aegis' AND content LIKE 'Quality Review Rejected:%'
        ORDER BY created_at DESC LIMIT 1
      `).get(task.id) as { content: string } | undefined
      const rejectionFeedback = rejectionRow?.content?.replace(/^Quality Review Rejected:\n?/, '') || null

      const prompt = buildTaskPrompt(task, rejectionFeedback)

      // Check if task has a target session specified in metadata
      const taskMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      const targetSession: string | null = typeof taskMeta?.target_session === 'string' && taskMeta.target_session
        ? taskMeta.target_session
        : null

      let agentResponse: AgentResponseParsed
      const dispatchMode = resolveDispatchMode(task)
      const claudeAgent = resolveClaudeAgent(task)
      const useCli = dispatchMode === 'cli' || (dispatchMode === 'auto' && claudeAgent)

      if (useCli && claudeAgent && !targetSession) {
        // Dispatch via Claude Code CLI agent
        agentResponse = await runClaudeCodeTask(task, prompt, claudeAgent)
      } else if (targetSession) {
        // Dispatch to a specific existing session via chat.send
        logger.info({ taskId: task.id, targetSession, agent: task.agent_name }, 'Dispatching task to targeted session')
        const sendResult = await callOpenClawGateway<any>(
          'chat.send',
          {
            sessionKey: targetSession,
            message: prompt,
            idempotencyKey: `task-dispatch-${task.id}-${Date.now()}`,
            deliver: false,
          },
          125_000,
        )
        const status = String(sendResult?.status || '').toLowerCase()
        if (status !== 'started' && status !== 'ok' && status !== 'in_flight') {
          throw new Error(`chat.send to session ${targetSession} returned status: ${status}`)
        }
        // chat.send is fire-and-forget; we record the session but won't get inline response text
        agentResponse = {
          text: `Task dispatched to existing session ${targetSession}. The agent will process it within that session context.`,
          sessionId: sendResult?.runId || targetSession,
        }
      } else {
        // Dispatch via OpenClaw gateway (new session)
        const gatewayAgentId = resolveGatewayAgentId(task)
        const dispatchModel = classifyTaskModel(task)
        const invokeParams: Record<string, unknown> = {
          message: prompt,
          agentId: gatewayAgentId,
          idempotencyKey: `task-dispatch-${task.id}-${Date.now()}`,
          deliver: false,
        }
        // Route to appropriate model tier based on task complexity.
        // null = no override, agent uses its own configured default model.
        if (dispatchModel) invokeParams.model = dispatchModel

        // Use --expect-final to block until the agent completes and returns the full
        // response payload (result.payloads[0].text). The two-step agent → agent.wait
        // pattern only returns lifecycle metadata and never includes the agent's text.
        const finalResult = await runOpenClaw(
          ['gateway', 'call', 'agent', '--expect-final', '--timeout', '120000', '--params', JSON.stringify(invokeParams), '--json'],
          { timeoutMs: 125_000 }
        )
        const finalPayload = parseGatewayJson(finalResult.stdout)
          ?? parseGatewayJson(String((finalResult as any)?.stderr || ''))

        agentResponse = parseAgentResponse(
          finalPayload?.result ? JSON.stringify(finalPayload.result) : finalResult.stdout
        )
        if (!agentResponse.sessionId && finalPayload?.result?.meta?.agentMeta?.sessionId) {
          agentResponse.sessionId = finalPayload.result.meta.agentMeta.sessionId
        }
      }

      if (!agentResponse.text) {
        throw new Error('Agent returned empty response')
      }

      const truncated = agentResponse.text.length > 10_000
        ? agentResponse.text.substring(0, 10_000) + '\n\n[Response truncated at 10,000 characters]'
        : agentResponse.text

      // Merge dispatch_session_id into existing metadata
      const existingMeta = (() => {
        try {
          const row = db.prepare('SELECT metadata FROM tasks WHERE id = ?').get(task.id) as { metadata: string } | undefined
          return row?.metadata ? JSON.parse(row.metadata) : {}
        } catch { return {} }
      })()
      if (agentResponse.sessionId) {
        existingMeta.dispatch_session_id = agentResponse.sessionId
      }

      // Update task: status → review, set outcome
      db.prepare(`
        UPDATE tasks SET status = ?, outcome = ?, resolution = ?, metadata = ?, updated_at = ? WHERE id = ?
      `).run('review', 'success', truncated, JSON.stringify(existingMeta), Math.floor(Date.now() / 1000), task.id)

      // Add a comment from the agent with the full response
      db.prepare(`
        INSERT INTO comments (task_id, author, content, created_at, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.agent_name,
        truncated,
        Math.floor(Date.now() / 1000),
        task.workspace_id
      )

      eventBus.broadcast('task.status_changed', {
        id: task.id,
        status: 'review',
        previous_status: 'in_progress',
      })

      eventBus.broadcast('task.updated', {
        id: task.id,
        status: 'review',
        outcome: 'success',
        assigned_to: task.assigned_to,
        dispatch_session_id: agentResponse.sessionId,
      })

      db_helpers.logActivity(
        'task_agent_completed',
        'task',
        task.id,
        task.agent_name,
        `Agent completed task "${task.title}" — awaiting review`,
        { response_length: agentResponse.text.length, dispatch_session_id: agentResponse.sessionId },
        task.workspace_id
      )

      results.push({ id: task.id, success: true })
      logger.info({ taskId: task.id, agent: task.agent_name }, 'Task dispatched and completed')
    } catch (err: any) {
      const errorMsg = err.message || 'Unknown error'
      logger.error({ taskId: task.id, agent: task.agent_name, err }, 'Task dispatch failed')

      // Increment dispatch_attempts and decide next status
      const currentAttempts = (db.prepare('SELECT dispatch_attempts FROM tasks WHERE id = ?').get(task.id) as { dispatch_attempts: number } | undefined)?.dispatch_attempts ?? 0
      const newAttempts = currentAttempts + 1
      const maxDispatchRetries = 5

      if (newAttempts >= maxDispatchRetries) {
        // Too many failures — move to failed
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
          .run('failed', `Dispatch failed ${newAttempts} times. Last: ${errorMsg.substring(0, 5000)}`, newAttempts, Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'failed',
          previous_status: 'in_progress',
          error_message: `Dispatch failed ${newAttempts} times`,
          reason: 'max_dispatch_retries_exceeded',
        })
      } else {
        // Revert to assigned so it can be retried on the next tick
        db.prepare('UPDATE tasks SET status = ?, error_message = ?, dispatch_attempts = ?, updated_at = ? WHERE id = ?')
          .run('assigned', errorMsg.substring(0, 5000), newAttempts, Math.floor(Date.now() / 1000), task.id)

        eventBus.broadcast('task.status_changed', {
          id: task.id,
          status: 'assigned',
          previous_status: 'in_progress',
          error_message: errorMsg.substring(0, 500),
          reason: 'dispatch_failed',
        })
      }

      db_helpers.logActivity(
        'task_dispatch_failed',
        'task',
        task.id,
        'scheduler',
        `Task dispatch failed for "${task.title}": ${errorMsg.substring(0, 200)}`,
        { error: errorMsg.substring(0, 1000) },
        task.workspace_id
      )

      results.push({ id: task.id, success: false, error: errorMsg.substring(0, 100) })
    }
  }

  const succeeded = results.filter(r => r.success).length
  const failed = results.filter(r => !r.success)
  const failSummary = failed.length > 0
    ? ` (${failed.length} failed: ${failed.map(f => f.error).join('; ')})`
    : ''

  return {
    ok: failed.length === 0,
    message: `Dispatched ${succeeded}/${tasks.length} tasks${failSummary}`,
  }
}

// ---------------------------------------------------------------------------
// Auto-routing: assign inbox tasks to available agents
// ---------------------------------------------------------------------------

/** Role affinity mapping — which task keywords match which agent roles. */
const ROLE_AFFINITY: Record<string, string[]> = {
  coder: ['code', 'implement', 'build', 'fix', 'bug', 'test', 'unit test', 'refactor', 'feature', 'api', 'endpoint', 'function', 'class', 'module', 'component', 'deploy', 'ci', 'pipeline'],
  researcher: ['research', 'investigate', 'analyze', 'compare', 'find', 'discover', 'audit', 'review', 'survey', 'benchmark', 'evaluate', 'assess', 'competitor', 'market', 'trend'],
  reviewer: ['review', 'audit', 'check', 'verify', 'validate', 'quality', 'security', 'compliance', 'approve'],
  tester: ['test', 'qa', 'e2e', 'integration test', 'regression', 'coverage', 'verify', 'validate'],
  devops: ['deploy', 'infrastructure', 'ci', 'cd', 'docker', 'kubernetes', 'monitoring', 'pipeline', 'server', 'nginx', 'ssl'],
  assistant: ['write', 'draft', 'summarize', 'translate', 'format', 'document', 'docs', 'readme', 'email', 'message', 'report'],
  agent: [], // generic fallback
}

function scoreAgentForTask(
  agent: { name: string; role: string; status: string; config: string | null },
  taskText: string,
): number {
  // Offline agents can't take work
  if (agent.status === 'offline' || agent.status === 'error' || agent.status === 'sleeping') return -1

  const text = taskText.toLowerCase()
  const keywords = ROLE_AFFINITY[agent.role] || []

  let score = 0
  // Role keyword match
  for (const kw of keywords) {
    if (text.includes(kw)) score += 10
  }

  // Idle agents get a bonus (prefer agents not currently busy)
  if (agent.status === 'idle') score += 5

  // Check agent capabilities from config
  if (agent.config) {
    try {
      const cfg = JSON.parse(agent.config)
      const caps = Array.isArray(cfg.capabilities) ? cfg.capabilities : []
      for (const cap of caps) {
        if (typeof cap === 'string' && text.includes(cap.toLowerCase())) score += 15
      }
    } catch { /* ignore */ }
  }

  // Any non-offline agent gets at least 1 (can be a fallback)
  return Math.max(score, 1)
}

/**
 * Auto-route inbox tasks to the best available agent.
 * Runs before dispatch — moves tasks from inbox → assigned.
 */
export async function autoRouteInboxTasks(): Promise<{ ok: boolean; message: string }> {
  const db = getDatabase()

  const inboxTasks = db.prepare(`
    SELECT id, title, description, priority, tags, workspace_id
    FROM tasks
    WHERE status = 'inbox' AND assigned_to IS NULL
    ORDER BY
      CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END ASC,
      created_at ASC
    LIMIT 5
  `).all() as Array<{ id: number; title: string; description: string | null; priority: string; tags: string | null; workspace_id: number }>

  if (inboxTasks.length === 0) {
    return { ok: true, message: 'No inbox tasks to route' }
  }

  // Get all non-hidden, non-offline agents
  const agents = db.prepare(`
    SELECT id, name, role, status, config
    FROM agents
    WHERE hidden = 0 AND status NOT IN ('offline', 'error')
    LIMIT 50
  `).all() as Array<{ id: number; name: string; role: string; status: string; config: string | null }>

  if (agents.length === 0) {
    return { ok: true, message: `${inboxTasks.length} inbox task(s) but no available agents` }
  }

  let routed = 0
  const now = Math.floor(Date.now() / 1000)

  for (const task of inboxTasks) {
    const taskText = `${task.title} ${task.description || ''}`
    let parsedTags: string[] = []
    if (task.tags) {
      try { parsedTags = JSON.parse(task.tags) } catch { /* ignore */ }
    }
    const fullText = `${taskText} ${parsedTags.join(' ')}`

    // Score each agent
    const scored = agents
      .map(a => ({ agent: a, score: scoreAgentForTask(a, fullText) }))
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)

    if (scored.length === 0) continue

    const best = scored[0].agent

    // Check capacity — skip agents with 3+ in-progress tasks
    const inProgressCount = (db.prepare(
      'SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND status = \'in_progress\' AND workspace_id = ?'
    ).get(best.name, task.workspace_id) as { c: number }).c

    if (inProgressCount >= 3) {
      // Try next best agent
      const alt = scored.find(s => {
        const c = (db.prepare(
          'SELECT COUNT(*) as c FROM tasks WHERE assigned_to = ? AND status = \'in_progress\' AND workspace_id = ?'
        ).get(s.agent.name, task.workspace_id) as { c: number }).c
        return c < 3
      })
      if (!alt) continue // all agents at capacity
      const altResult = db.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ? AND status = \'inbox\'')
        .run('assigned', alt.agent.name, now, task.id)

      if (altResult.changes === 0) continue // task was concurrently assigned elsewhere

      db_helpers.logActivity('task_auto_routed', 'task', task.id, 'scheduler',
        `Auto-assigned "${task.title}" to ${alt.agent.name} (${alt.agent.role}, score: ${alt.score})`,
        { agent: alt.agent.name, role: alt.agent.role, score: alt.score },
        task.workspace_id)

      eventBus.broadcast('task.status_changed', { id: task.id, status: 'assigned', previous_status: 'inbox', assigned_to: alt.agent.name })
      routed++
      continue
    }

    const bestResult = db.prepare('UPDATE tasks SET status = ?, assigned_to = ?, updated_at = ? WHERE id = ? AND status = \'inbox\'')
      .run('assigned', best.name, now, task.id)

    if (bestResult.changes === 0) continue // task was concurrently assigned elsewhere

    db_helpers.logActivity('task_auto_routed', 'task', task.id, 'scheduler',
      `Auto-assigned "${task.title}" to ${best.name} (${best.role}, score: ${scored[0].score})`,
      { agent: best.name, role: best.role, score: scored[0].score },
      task.workspace_id)

    eventBus.broadcast('task.status_changed', { id: task.id, status: 'assigned', previous_status: 'inbox', assigned_to: best.name })
    routed++
  }

  return {
    ok: true,
    message: routed > 0
      ? `Auto-routed ${routed}/${inboxTasks.length} inbox task(s)`
      : `${inboxTasks.length} inbox task(s), no suitable agents found`,
  }
}
