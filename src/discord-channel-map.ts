import { getDb } from './db.js';

// ── Types ────────────────────────────────────────────────────────────

export interface ChannelMapping {
  channelId: string;
  guildId: string;
  agentId: string;
  project?: string;
  categoryName?: string;
  channelName?: string;
  createdAt: number;
  updatedAt: number;
}

// ── Row shape returned by SQLite ─────────────────────────────────────

interface ChannelMappingRow {
  channel_id: string;
  guild_id: string;
  agent_id: string;
  project: string | null;
  category_name: string | null;
  channel_name: string | null;
  created_at: number;
  updated_at: number;
}

function rowToMapping(row: ChannelMappingRow): ChannelMapping {
  return {
    channelId: row.channel_id,
    guildId: row.guild_id,
    agentId: row.agent_id,
    project: row.project ?? undefined,
    categoryName: row.category_name ?? undefined,
    channelName: row.channel_name ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Insert or update a channel → agent mapping.
 * `createdAt` is preserved on conflict; only `agentId`, `project`,
 * `categoryName`, `channelName`, and `updatedAt` are updated.
 */
export function upsertMapping(
  m: Omit<ChannelMapping, 'createdAt' | 'updatedAt'>,
): void {
  const now = Math.floor(Date.now() / 1000);
  getDb()
    .prepare(
      `INSERT INTO discord_channel_agent_map
         (channel_id, guild_id, agent_id, project, category_name, channel_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(channel_id) DO UPDATE SET
         agent_id      = excluded.agent_id,
         guild_id      = excluded.guild_id,
         project       = excluded.project,
         category_name = excluded.category_name,
         channel_name  = excluded.channel_name,
         updated_at    = ?`,
    )
    .run(
      m.channelId,
      m.guildId,
      m.agentId,
      m.project ?? null,
      m.categoryName ?? null,
      m.channelName ?? null,
      now,
      now,
      // extra binding for the ON CONFLICT updated_at = ?
      now,
    );
}

/**
 * Return the `agent_id` registered for the given Discord channel,
 * or `null` if no mapping exists.
 */
export function lookupAgentForChannel(channelId: string): string | null {
  const row = getDb()
    .prepare('SELECT agent_id FROM discord_channel_agent_map WHERE channel_id = ?')
    .get(channelId) as { agent_id: string } | undefined;
  return row?.agent_id ?? null;
}

/**
 * Return all channel mappings in insertion order.
 */
export function listMappings(): ChannelMapping[] {
  const rows = getDb()
    .prepare('SELECT * FROM discord_channel_agent_map ORDER BY created_at ASC')
    .all() as ChannelMappingRow[];
  return rows.map(rowToMapping);
}

/**
 * Delete any mapping whose `agent_id` is not in `activeAgentIds`.
 * Returns the number of rows deleted.
 *
 * Pass an empty array to delete all mappings.
 */
export function clearStaleMappings(activeAgentIds: string[]): number {
  if (activeAgentIds.length === 0) {
    const result = getDb()
      .prepare('DELETE FROM discord_channel_agent_map')
      .run();
    return result.changes;
  }

  const placeholders = activeAgentIds.map(() => '?').join(', ');
  const result = getDb()
    .prepare(`DELETE FROM discord_channel_agent_map WHERE agent_id NOT IN (${placeholders})`)
    .run(...activeAgentIds);
  return result.changes;
}
