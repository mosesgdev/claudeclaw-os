import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  upsertMapping,
  lookupAgentForChannel,
  listMappings,
  clearStaleMappings,
} from './discord-channel-map.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeMapping(overrides: Partial<Parameters<typeof upsertMapping>[0]> = {}) {
  return {
    channelId: 'ch-001',
    guildId: 'guild-001',
    agentId: 'main',
    project: 'archisell',
    categoryName: 'archisell',
    channelName: 'pm-archisell',
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  _initTestDatabase();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('upsertMapping + lookupAgentForChannel', () => {
  it('inserts a new mapping and lookupAgentForChannel returns the agent', () => {
    upsertMapping(makeMapping({ channelId: 'ch-001', agentId: 'main' }));
    expect(lookupAgentForChannel('ch-001')).toBe('main');
  });

  it('returns null for an unknown channel', () => {
    expect(lookupAgentForChannel('no-such-channel')).toBeNull();
  });

  it('updates agent_id and updated_at on conflict but preserves created_at', async () => {
    upsertMapping(makeMapping({ channelId: 'ch-001', agentId: 'main' }));

    const before = listMappings().find((m) => m.channelId === 'ch-001')!;
    expect(before.agentId).toBe('main');

    // Wait 1 s so updated_at will differ from created_at
    await new Promise((r) => setTimeout(r, 1100));

    upsertMapping(makeMapping({ channelId: 'ch-001', agentId: 'archisell' }));

    const after = listMappings().find((m) => m.channelId === 'ch-001')!;
    expect(after.agentId).toBe('archisell');
    expect(after.createdAt).toBe(before.createdAt);
    expect(after.updatedAt).toBeGreaterThan(before.updatedAt);
  });
});

describe('listMappings', () => {
  it('returns all inserted rows', () => {
    upsertMapping(makeMapping({ channelId: 'ch-001', agentId: 'main' }));
    upsertMapping(makeMapping({ channelId: 'ch-002', agentId: 'research' }));
    upsertMapping(makeMapping({ channelId: 'ch-003', agentId: 'archisell' }));

    const mappings = listMappings();
    expect(mappings).toHaveLength(3);

    const ids = mappings.map((m) => m.channelId);
    expect(ids).toContain('ch-001');
    expect(ids).toContain('ch-002');
    expect(ids).toContain('ch-003');
  });

  it('returns empty array when table is empty', () => {
    expect(listMappings()).toEqual([]);
  });
});

describe('clearStaleMappings', () => {
  beforeEach(() => {
    upsertMapping(makeMapping({ channelId: 'ch-001', agentId: 'main' }));
    upsertMapping(makeMapping({ channelId: 'ch-002', agentId: 'research' }));
    upsertMapping(makeMapping({ channelId: 'ch-003', agentId: 'archisell' }));
  });

  it('deletes mappings whose agent_id is not in activeAgentIds', () => {
    const deleted = clearStaleMappings(['main']);
    expect(deleted).toBe(2);

    const remaining = listMappings();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].agentId).toBe('main');
  });

  it('returns 0 when all agents are active', () => {
    const deleted = clearStaleMappings(['main', 'research', 'archisell']);
    expect(deleted).toBe(0);
    expect(listMappings()).toHaveLength(3);
  });

  it('deletes all mappings when activeAgentIds is empty', () => {
    const deleted = clearStaleMappings([]);
    expect(deleted).toBe(3);
    expect(listMappings()).toHaveLength(0);
  });
});
