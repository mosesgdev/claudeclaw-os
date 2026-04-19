import { getDb } from './db.js';

// ── Types ────────────────────────────────────────────────────────────

export type SubagentStatus = 'running' | 'completed' | 'aborted' | 'failed';

export interface SubagentSession {
  id: string;
  project: string;
  agentId: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  threadId: string;
  workspaceId: string;
  status: SubagentStatus;
  startedAt: number;
  endedAt: number | null;
}

// ── Row shape returned by SQLite ─────────────────────────────────────

interface SubagentSessionRow {
  id: string;
  project: string;
  agent_id: string;
  issue_number: number;
  issue_title: string;
  issue_url: string;
  thread_id: string;
  workspace_id: string;
  status: string;
  started_at: number;
  ended_at: number | null;
}

function rowToSession(row: SubagentSessionRow): SubagentSession {
  return {
    id: row.id,
    project: row.project,
    agentId: row.agent_id,
    issueNumber: row.issue_number,
    issueTitle: row.issue_title,
    issueUrl: row.issue_url,
    threadId: row.thread_id,
    workspaceId: row.workspace_id,
    status: row.status as SubagentStatus,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Insert a new subagent session row.
 * `endedAt` is always null on creation.
 */
export function createSession(s: Omit<SubagentSession, 'endedAt'>): void {
  getDb()
    .prepare(
      `INSERT INTO subagent_sessions
         (id, project, agent_id, issue_number, issue_title, issue_url,
          thread_id, workspace_id, status, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(
      s.id,
      s.project,
      s.agentId,
      s.issueNumber,
      s.issueTitle,
      s.issueUrl,
      s.threadId,
      s.workspaceId,
      s.status,
      s.startedAt,
    );
}

/**
 * Return the session associated with a Discord thread id, or null if not found.
 */
export function getByThreadId(threadId: string): SubagentSession | null {
  const row = getDb()
    .prepare('SELECT * FROM subagent_sessions WHERE thread_id = ?')
    .get(threadId) as SubagentSessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * Return the most-recent session for a project + issue number, or null.
 */
export function getByIssueNumber(project: string, issueNumber: number): SubagentSession | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM subagent_sessions WHERE project = ? AND issue_number = ? ORDER BY started_at DESC LIMIT 1',
    )
    .get(project, issueNumber) as SubagentSessionRow | undefined;
  return row ? rowToSession(row) : null;
}

/**
 * Return all sessions currently in status 'running'.
 */
export function listRunning(): SubagentSession[] {
  const rows = getDb()
    .prepare("SELECT * FROM subagent_sessions WHERE status = 'running' ORDER BY started_at ASC")
    .all() as SubagentSessionRow[];
  return rows.map(rowToSession);
}

/**
 * Update the status (and optionally endedAt) for a session by id.
 */
export function updateStatus(id: string, status: SubagentStatus, endedAt?: number): void {
  if (endedAt !== undefined) {
    getDb()
      .prepare('UPDATE subagent_sessions SET status = ?, ended_at = ? WHERE id = ?')
      .run(status, endedAt, id);
  } else {
    getDb()
      .prepare('UPDATE subagent_sessions SET status = ? WHERE id = ?')
      .run(status, id);
  }
}
