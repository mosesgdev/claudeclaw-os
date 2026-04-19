import { getDb, initDatabase } from '../../src/db.js';

export const description = 'Add memory_vault_links table for bridging memories to vault file paths';

export async function run(): Promise<void> {
  initDatabase();
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_vault_links (
      memory_id  INTEGER PRIMARY KEY,
      vault_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mvl_path ON memory_vault_links(vault_path);
  `);
}
