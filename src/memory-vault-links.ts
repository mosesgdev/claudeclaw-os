/**
 * memory-vault-links.ts
 *
 * Data-access layer for the `memory_vault_links` table.
 * Keeps a bidirectional index between a memory row (by id) and the vault-relative
 * path of the Obsidian note the bridge wrote for it.
 *
 * RFC 2a — no behaviour change; pure lookup tool consumed by memory-dedupe-cli.
 */

import { getDb } from './db.js';

// ── Types ─────────────────────────────────────────────────────────────

export interface MemoryVaultLink {
  memoryId: number;
  vaultPath: string;
  updatedAt: number;
}

// ── Write ─────────────────────────────────────────────────────────────

/**
 * Upsert a vault-path for the given memory id.
 * If a row already exists the vault_path is updated and updated_at is bumped.
 */
export function setVaultPath(memoryId: number, vaultPath: string): void {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT INTO memory_vault_links (memory_id, vault_path, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      vault_path = excluded.vault_path,
      updated_at = excluded.updated_at
  `).run(memoryId, vaultPath, now);
}

// ── Read ──────────────────────────────────────────────────────────────

/**
 * Return the vault-relative path for a given memory id, or null if not linked.
 */
export function getVaultPath(memoryId: number): string | null {
  const db = getDb();
  const row = db.prepare('SELECT vault_path FROM memory_vault_links WHERE memory_id = ?')
    .get(memoryId) as { vault_path: string } | undefined;
  return row?.vault_path ?? null;
}

/**
 * Return the full link row for a given vault path, or null if not found.
 */
export function getLinkByPath(vaultPath: string): MemoryVaultLink | null {
  const db = getDb();
  const row = db.prepare('SELECT memory_id, vault_path, updated_at FROM memory_vault_links WHERE vault_path = ?')
    .get(vaultPath) as { memory_id: number; vault_path: string; updated_at: number } | undefined;
  if (!row) return null;
  return { memoryId: row.memory_id, vaultPath: row.vault_path, updatedAt: row.updated_at };
}

/**
 * Return memories that have a vault link AND whose topics JSON array overlaps
 * with the given topics list.
 *
 * Joins memory_vault_links with memories on memory_id.
 * Ordered by memories.importance DESC, memories.accessed_at DESC.
 * Capped at `limit` rows.
 */
export function listLinksByTopics(
  topics: string[],
  limit = 10,
): Array<{
  memoryId: number;
  summary: string;
  importance: number;
  vaultPath: string;
  topics: string[];
}> {
  if (topics.length === 0) return [];

  const db = getDb();

  // Pull all linked memories and filter in JS — SQLite JSON1 overlap queries
  // are verbose and sqlite_version()-dependent; simpler to filter a bounded set.
  const rows = db.prepare(`
    SELECT m.id, m.summary, m.importance, m.topics, mvl.vault_path
    FROM memory_vault_links mvl
    JOIN memories m ON m.id = mvl.memory_id
    ORDER BY m.importance DESC, m.accessed_at DESC
    LIMIT ?
  `).all(limit * 10) as Array<{
    id: number;
    summary: string;
    importance: number;
    topics: string;
    vault_path: string;
  }>;

  const lowerTopics = topics.map((t) => t.toLowerCase());

  const matched: Array<{
    memoryId: number;
    summary: string;
    importance: number;
    vaultPath: string;
    topics: string[];
  }> = [];

  for (const row of rows) {
    let parsed: string[] = [];
    try { parsed = JSON.parse(row.topics) as string[]; } catch { /* ignore */ }
    const overlap = parsed.some((t) => lowerTopics.includes(t.toLowerCase()));
    if (overlap) {
      matched.push({
        memoryId: row.id,
        summary: row.summary,
        importance: row.importance,
        vaultPath: row.vault_path,
        topics: parsed,
      });
      if (matched.length >= limit) break;
    }
  }

  return matched;
}
