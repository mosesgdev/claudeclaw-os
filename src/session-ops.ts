/**
 * Thin helpers for slash-command session and memory operations.
 *
 * Uses exported db.ts functions where they exist; falls back to a direct
 * better-sqlite3 connection (WAL-safe) for the delete-by-id path that
 * db.ts does not currently export.
 */
import Database from 'better-sqlite3';
import path from 'path';

import { clearSession as dbClearSession, getRecentMemories } from './db.js';
import { STORE_DIR } from './config.js';

// ---------------------------------------------------------------------------
// Lazy second-connection — opened only when forgetMemory is first called.
// WAL journal_mode (set by initDatabase) allows concurrent readers/writers.
// ---------------------------------------------------------------------------
let _opsDb: Database.Database | null = null;

function getOpsDb(): Database.Database {
  if (!_opsDb) {
    _opsDb = new Database(path.join(STORE_DIR, 'claudeclaw.db'));
    _opsDb.pragma('journal_mode = WAL');
  }
  return _opsDb;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clear the Claude session for a given chatKey.
 * Discord sessions are keyed as "discord:<channelId>"; only the 'main' agent
 * is used by the Discord bot, so the default agentId covers the common case.
 */
export function clearSession(chatKey: string): void {
  dbClearSession(chatKey, 'main');
}

export interface MemoryRow {
  id: number;
  content: string; // alias for the `summary` column
}

/**
 * Return up to 20 recent memories for the given chatKey, ordered by
 * accessed_at DESC (most recently surfaced first).
 */
export function listMemories(chatKey: string): MemoryRow[] {
  const rows = getRecentMemories(chatKey, 20);
  return rows.map((m) => ({ id: m.id, content: m.summary }));
}

/**
 * Permanently delete a memory by its integer id. Returns true if a row was
 * deleted, false for non-numeric ids or ids that did not match any row.
 * Callers (e.g. the /forget slash command) use the return value to avoid
 * telling the user "done" when nothing actually changed.
 */
export function forgetMemory(id: string): boolean {
  const numId = parseInt(id, 10);
  if (isNaN(numId)) return false;
  const result = getOpsDb().prepare('DELETE FROM memories WHERE id = ?').run(numId);
  return result.changes > 0;
}
