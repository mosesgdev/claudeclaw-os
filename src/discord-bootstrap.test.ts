/**
 * Unit tests for discord-bootstrap.ts
 *
 * These tests mock the Discord Client, guild, and channels collection to
 * verify the bootstrap logic without touching Discord's network layer.
 * The DB helper (upsertMapping / clearStaleMappings) is also mocked so no
 * real SQLite connection is needed.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelType } from 'discord.js';
import type { RegistryEntry } from './agent-registry.js';
import type { ProjectManifest } from './project-manifests.js';

// ── Module mocks ──────────────────────────────────────────────────────
// NOTE: vi.mock factories are hoisted — do NOT reference module-level vars inside.

vi.mock('./config.js', () => ({
  PROJECT_AGENTS_ENABLED: true,
  discordConfig: {
    guildId: 'guild-001',
    botToken: 'test-token',
    allowedChannelIds: [],
    maxLength: 2000,
    enabled: true,
  },
  VAULT_PROJECTS_ROOT: '/vault/04-projects',
  PROJECT_ROOT: '/project',
  CLAUDECLAW_CONFIG: '/home/.claudeclaw',
}));

vi.mock('./discord-channel-map.js', () => ({
  upsertMapping: vi.fn(),
  clearStaleMappings: vi.fn(() => 0),
  listMappings: vi.fn(() => []),
}));

vi.mock('./agent-registry.js', () => ({
  getRegistryEntries: vi.fn<() => RegistryEntry[]>(() => []),
  initAgentRegistry: vi.fn(),
}));

// Import mocked modules so we can spy/configure them in tests.
import { upsertMapping, clearStaleMappings, listMappings } from './discord-channel-map.js';
import { getRegistryEntries, initAgentRegistry } from './agent-registry.js';

import { bootstrapDiscordChannelMap } from './discord-bootstrap.js';

// ── Helpers ──────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<ProjectManifest> = {}): ProjectManifest {
  return {
    project: 'archisell',
    status: 'active',
    vaultRoot: '04-projects/archisell',
    memoryNamespace: 'archisell',
    discord: { category: 'archisell', primaryChannel: 'pm-archisell' },
    skills: [],
    experts: [],
    hooks: [],
    systemPrompt: '# Archisell',
    sourcePath: '/vault/04-projects/archisell/context.md',
    ...overrides,
  };
}

function makeRegistryEntry(manifest: ProjectManifest): RegistryEntry {
  return {
    id: manifest.memoryNamespace,
    name: manifest.project,
    description: `Project agent for ${manifest.project}`,
    source: 'manifest',
    context: {
      agentId: manifest.memoryNamespace,
      name: manifest.project,
      source: 'manifest',
      cwd: '/project',
    },
    manifest,
  };
}

function makeChannel(id: string, type: ChannelType, name: string, parentId?: string) {
  return { id, type, name, parentId: parentId ?? null };
}

function makeGuildAndClient(channelList: ReturnType<typeof makeChannel>[]) {
  const channelsCollection = new Map(channelList.map((c) => [c.id, c]));
  const guild = {
    id: 'guild-001',
    channels: { fetch: vi.fn(async () => channelsCollection) },
  };
  const client = {
    guilds: { fetch: vi.fn(async (_id: string) => guild) },
  };
  return { client, guild };
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listMappings).mockReturnValue([]);
  vi.mocked(clearStaleMappings).mockReturnValue(0);
  vi.mocked(getRegistryEntries).mockReturnValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('bootstrapDiscordChannelMap', () => {
  it('upserts a mapping when category and channel are found', async () => {
    const manifest = makeManifest();
    vi.mocked(getRegistryEntries).mockReturnValue([makeRegistryEntry(manifest)]);

    const categoryChannel = makeChannel('cat-001', ChannelType.GuildCategory, 'archisell');
    const textChannel = makeChannel('ch-001', ChannelType.GuildText, 'pm-archisell', 'cat-001');
    const { client } = makeGuildAndClient([categoryChannel, textChannel]);

    await bootstrapDiscordChannelMap(client as any);

    expect(upsertMapping).toHaveBeenCalledOnce();
    expect(upsertMapping).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: 'ch-001',
        guildId: 'guild-001',
        agentId: 'archisell',
        project: 'archisell',
        categoryName: 'archisell',
        channelName: 'pm-archisell',
      }),
    );
  });

  it('skips a manifest entry when the Discord category is not found', async () => {
    const manifest = makeManifest();
    vi.mocked(getRegistryEntries).mockReturnValue([makeRegistryEntry(manifest)]);

    // Only a text channel without a matching category name
    const textChannel = makeChannel('ch-001', ChannelType.GuildText, 'pm-archisell', 'cat-999');
    const { client } = makeGuildAndClient([textChannel]);

    await bootstrapDiscordChannelMap(client as any);

    expect(upsertMapping).not.toHaveBeenCalled();
  });

  it('skips a manifest entry when the text channel is not found under the category', async () => {
    const manifest = makeManifest();
    vi.mocked(getRegistryEntries).mockReturnValue([makeRegistryEntry(manifest)]);

    // Category exists but no matching text channel under it
    const categoryChannel = makeChannel('cat-001', ChannelType.GuildCategory, 'archisell');
    const { client } = makeGuildAndClient([categoryChannel]);

    await bootstrapDiscordChannelMap(client as any);

    expect(upsertMapping).not.toHaveBeenCalled();
  });

  it('calls clearStaleMappings with active agent ids', async () => {
    const manifest = makeManifest();
    vi.mocked(getRegistryEntries).mockReturnValue([makeRegistryEntry(manifest)]);

    const categoryChannel = makeChannel('cat-001', ChannelType.GuildCategory, 'archisell');
    const textChannel = makeChannel('ch-001', ChannelType.GuildText, 'pm-archisell', 'cat-001');
    const { client } = makeGuildAndClient([categoryChannel, textChannel]);

    await bootstrapDiscordChannelMap(client as any);

    expect(clearStaleMappings).toHaveBeenCalledOnce();
    expect(clearStaleMappings).toHaveBeenCalledWith(
      expect.arrayContaining(['archisell']),
    );
  });

  it('is a no-op (no upserts) when there are no manifest-sourced registry entries', async () => {
    const yamlEntry: RegistryEntry = {
      id: 'main',
      name: 'Main',
      description: '',
      source: 'yaml',
      context: { agentId: 'main', name: 'Main', source: 'yaml', cwd: '/project' },
    };
    vi.mocked(getRegistryEntries).mockReturnValue([yamlEntry]);

    const { client } = makeGuildAndClient([]);

    await bootstrapDiscordChannelMap(client as any);

    expect(upsertMapping).not.toHaveBeenCalled();
  });

  it('returns early when guild fetch fails', async () => {
    const manifest = makeManifest();
    vi.mocked(getRegistryEntries).mockReturnValue([makeRegistryEntry(manifest)]);

    const client = {
      guilds: {
        fetch: vi.fn(async () => { throw new Error('Unknown Guild'); }),
      },
    };

    await bootstrapDiscordChannelMap(client as any);

    expect(upsertMapping).not.toHaveBeenCalled();
  });

  it('calls initAgentRegistry before iterating entries', async () => {
    const { client } = makeGuildAndClient([]);
    await bootstrapDiscordChannelMap(client as any);
    expect(initAgentRegistry).toHaveBeenCalledOnce();
  });
});
