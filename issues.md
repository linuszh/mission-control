# Mission Control — Known Issues

Audit date: 2026-03-23

## Critical (server hangs / crashes)

### 1. `readCodexTranscript` sync recursive scan
**File:** `src/app/api/sessions/transcript/route.ts`
Same bug as the Claude transcript (already fixed): sync recursive walk of `~/.codex/sessions/` scanning up to 300 files with `readdirSync`/`statSync`/`readFileSync`. Blocks event loop.
**Fix:** Direct file lookup like the Claude transcript fix.

### 2. `readClaudeTranscript` no file size guard
**File:** `src/app/api/sessions/transcript/route.ts`
Our fix reads 1 file instead of 866, but still uses `readFileSync` on files that can be 10-50MB. No size guard. Blocks event loop on large sessions.
**Fix:** Add size check (skip files >10MB or use async streaming like `claude-sessions.ts`).

### 3. `runCommand` stdout/stderr buffers grow without limit
**File:** `src/lib/command.ts`, lines 29-45
`stdout += data.toString()` accumulates without bound during 30-min CLI dispatches. Can OOM the process.
**Fix:** Cap buffers at ~10MB, truncate beyond that.

### 4. Manual `triggerTask` bypasses scheduler re-entrance guard
**File:** `src/lib/task-dispatch.ts` (dispatchAssignedTasks) and `src/lib/scheduler.ts` (triggerTask)
The scheduler's `task.running` flag prevents concurrent ticks, but `triggerTask` from the API has no such guard. Two simultaneous dispatches for the same task can occur.
**Fix:** Optimistic locking: `UPDATE tasks SET status = 'in_progress' WHERE id = ? AND status = 'assigned'` and check `changes > 0`.

## High (degraded perf / subtle bugs)

### 5. Aggregate transcript route fans out sync reads
**File:** `src/app/api/sessions/transcript/aggregate/route.ts`
Iterates ALL gateway sessions, calls `readSessionJsonl` (sync `readFileSync`) for each. No file size check.
**Fix:** Add size guard, consider async reads.

### 6. Gateway transcript route sync reads
**File:** `src/app/api/sessions/transcript/gateway/route.ts`
Reads `sessions.json` and JSONL transcript with `readFileSync` in API handler. No size limit.
**Fix:** Add size guard.

### 7. `codex-sessions.ts` recursive walk with no depth limit
**File:** `src/lib/codex-sessions.ts`, lines 49-86
Recursive directory walk has no depth limit. Symlink loop or deep nesting can run forever. Also reads files sync with no size guard. Runs every 60s in scheduler.
**Fix:** Add max depth, file size guard.

### 8. Task stuck in `in_progress` if process crashes mid-dispatch
**File:** `src/lib/task-dispatch.ts`
Task marked `in_progress` before dispatch (up to 30 min). If process crashes, task stays stuck. `requeueStaleTasks` only requeues if agent is offline — if agent shows online, task stuck forever.
**Fix:** Also requeue in_progress tasks older than dispatch timeout regardless of agent status.

### 9. `autoRouteInboxTasks` no optimistic locking
**File:** `src/lib/task-dispatch.ts`
Auto-routing reads inbox tasks, scores agents, assigns. But the UPDATE doesn't check `AND status = 'inbox'`, so concurrent manual assignment gets overwritten.
**Fix:** Add `AND status = 'inbox'` to the UPDATE WHERE clause.

## Medium

### 10. `local-agent-sync.ts` many sync file reads
**File:** `src/lib/local-agent-sync.ts`
Reads `soul.md`, `identity.md`, `config.json` etc. with `readFileSync` for each agent. Runs every 60s. With many agents, accumulates blocking I/O.

### 11. `skill-sync.ts` sync reads in scheduler
**File:** `src/lib/skill-sync.ts`
Reads SKILL.md files with `readFileSync` for each skill across 6+ directories. Runs every 60s.

### 12. `security-scan.ts` uses `execSync`
**File:** `src/lib/security-scan.ts`, lines 125-131
`execSync` blocks event loop for up to 5s per command. Multiple calls in series. Cached for 60s but first call blocks.

### 13. Aegis review TOCTOU race
**File:** `src/lib/task-dispatch.ts` (runAegisReviews)
Queries `status = 'review'` then updates to `quality_review`. Concurrent manual trigger can pick up same task.

### 14. Agent status blindly toggled
**File:** `src/lib/task-dispatch.ts` (runClaudeCodeTask)
Sets agent to `busy` then `idle` without checking if agent was already busy from another task. Could incorrectly show `idle` while another task is still running.

### 15. `export/route.ts` allows 50K row export
**File:** `src/app/api/export/route.ts`
`SELECT *` with up to 50,000 rows including large text columns. Can produce hundreds of MB response, exhaust memory.

### 16. `sessions.ts` reads all gateway sessions on cache miss
**File:** `src/lib/sessions.ts`
`getAllGatewaySessions` iterates all agent dirs with `readdirSync` + `statSync`, reads every session JSON. 30s TTL cache mitigates but first call expensive.

### 17. Unbounded queries: agents, skills, settings
**Files:** `src/lib/agent-sync.ts` (line 314), `src/app/api/skills/route.ts` (line 187), `src/app/api/settings/route.ts` (line 68)
`SELECT` without LIMIT on agents, skills, settings tables.

### 18. `github-sync-poller.ts` interval not cleaned up
**File:** `src/lib/github-sync-poller.ts`
`setInterval` not unref'd, no shutdown hook. Prevents clean process exit.

### 19. `command.ts` sync spawn throw not caught
**File:** `src/lib/command.ts`, lines 47-49
If `spawn` throws synchronously (invalid command), error is unhandled — outside the event listeners.

### 20. Signal handlers don't call `process.exit()`
**File:** `src/lib/db.ts`, lines 591-593
SIGINT/SIGTERM handlers close DB but don't exit. In standalone mode, process may not terminate.

## Low

### 21. `openclaw-doctor-fix.ts` sync FS operations (admin-only)
### 22. Scheduler backup pruning uses sync I/O (daily at 3AM)
### 23. Non-atomic read-filter-write of token JSON in cleanup
### 24. LIKE wildcard injection in search endpoint
### 25. Stream cleanup edge case in `claude-sessions.ts`
