import { getDb, initDatabase } from '../../src/db.js';

export const description = 'Add subagent_sessions table for per-issue fresh-context subagents';

export async function run(): Promise<void> {
  initDatabase();
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS subagent_sessions (
      id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      issue_number INTEGER NOT NULL,
      issue_title TEXT NOT NULL,
      issue_url TEXT NOT NULL,
      thread_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_status ON subagent_sessions(status);
    CREATE INDEX IF NOT EXISTS idx_subagent_thread ON subagent_sessions(thread_id);
  `);
}
