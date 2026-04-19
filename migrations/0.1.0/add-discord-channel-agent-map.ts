import { getDb, initDatabase } from '../../src/db.js';

export const description = 'Add discord_channel_agent_map table for routing Discord channels to agents';

export async function run(): Promise<void> {
  initDatabase();
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_channel_agent_map (
      channel_id TEXT PRIMARY KEY,
      guild_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      project TEXT,
      category_name TEXT,
      channel_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dcam_agent ON discord_channel_agent_map(agent_id);
  `);
}
