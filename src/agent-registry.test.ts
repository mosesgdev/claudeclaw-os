/**
 * Tests for agent-registry.ts
 *
 * Strategy: mock listAgentIds/loadAgentConfig/resolveAgentDir/resolveAgentClaudeMd
 * from agent-config, and scanProjectManifests from project-manifests, so the
 * tests run without any real filesystem agents or vault files.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
  initAgentRegistry,
  getRegistryEntries,
  getRegistryContext,
  getRegistryEntry,
  rebuildRegistry,
  _resetRegistryForTest,
} from './agent-registry.js';
import type { ProjectManifest } from './project-manifests.js';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('./agent-config.js', () => ({
  listAgentIds: vi.fn(() => []),
  loadAgentConfig: vi.fn(() => ({ name: 'Main', description: 'Main agent' })),
  resolveAgentDir: vi.fn((id: string) => `/agents/${id}`),
  resolveAgentClaudeMd: vi.fn(() => null),
}));

vi.mock('./project-manifests.js', () => ({
  scanProjectManifests: vi.fn(() => []),
}));

// agent-context imports PROJECT_ROOT from config; mock it to avoid side effects
vi.mock('./config.js', () => ({
  PROJECT_ROOT: '/project',
  PROJECT_AGENTS_ENABLED: false,
  VAULT_PROJECTS_ROOT: '/vault/04-projects',
  CLAUDECLAW_CONFIG: '/home/.claudeclaw',
}));

import { listAgentIds, loadAgentConfig, resolveAgentDir, resolveAgentClaudeMd } from './agent-config.js';
import { scanProjectManifests } from './project-manifests.js';

// ── Helpers ──────────────────────────────────────────────────────────

const baseManifest: ProjectManifest = {
  project: 'archisell',
  status: 'active',
  vaultRoot: '04-projects/archisell',
  memoryNamespace: 'archisell',
  discord: { category: 'archisell', primaryChannel: 'pm-archisell' },
  skills: ['gmail'],
  experts: [],
  hooks: [],
  systemPrompt: '# Archisell',
  sourcePath: '/vault/04-projects/archisell/context.md',
};

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  _resetRegistryForTest();
  vi.mocked(listAgentIds).mockReturnValue([]);
  vi.mocked(loadAgentConfig).mockReturnValue({ name: 'Main', description: 'Main agent' });
  vi.mocked(resolveAgentDir).mockImplementation((id: string) => `/agents/${id}`);
  vi.mocked(resolveAgentClaudeMd).mockReturnValue(null);
  vi.mocked(scanProjectManifests).mockReturnValue([]);
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('initAgentRegistry — yaml only (flag off)', () => {
  it('initialises with zero entries when no agents exist', () => {
    initAgentRegistry({ includeProjectAgents: false });
    expect(getRegistryEntries()).toHaveLength(0);
  });

  it('loads yaml agents and exposes them', () => {
    vi.mocked(listAgentIds).mockReturnValue(['main', 'research']);
    vi.mocked(loadAgentConfig).mockImplementation((id: string) => ({
      name: id === 'main' ? 'Main' : 'Research',
      description: `${id} agent`,
    }));

    initAgentRegistry({ includeProjectAgents: false });
    const entries = getRegistryEntries();

    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.id).sort()).toEqual(['main', 'research']);
    entries.forEach((e) => {
      expect(e.source).toBe('yaml');
    });
  });

  it('skips yaml agents that fail to load', () => {
    vi.mocked(listAgentIds).mockReturnValue(['main', 'broken']);
    vi.mocked(loadAgentConfig).mockImplementation((id: string) => {
      if (id === 'broken') throw new Error('missing token');
      return { name: 'Main', description: 'main agent' };
    });

    initAgentRegistry({ includeProjectAgents: false });
    expect(getRegistryEntries()).toHaveLength(1);
    expect(getRegistryEntries()[0].id).toBe('main');
  });

  it('does not scan manifests when includeProjectAgents is false', () => {
    vi.mocked(scanProjectManifests).mockReturnValue([baseManifest]);
    initAgentRegistry({ includeProjectAgents: false });

    // manifest agents should not appear
    expect(getRegistryEntries().filter((e) => e.source === 'manifest')).toHaveLength(0);
  });
});

describe('initAgentRegistry — yaml + manifest (flag on)', () => {
  it('loads both yaml and manifest agents', () => {
    vi.mocked(listAgentIds).mockReturnValue(['main']);
    vi.mocked(loadAgentConfig).mockReturnValue({ name: 'Main', description: 'main' });
    vi.mocked(scanProjectManifests).mockReturnValue([baseManifest]);

    initAgentRegistry({ includeProjectAgents: true });
    const entries = getRegistryEntries();

    expect(entries).toHaveLength(2);
    const yamlEntries = entries.filter((e) => e.source === 'yaml');
    const manifestEntries = entries.filter((e) => e.source === 'manifest');
    expect(yamlEntries).toHaveLength(1);
    expect(manifestEntries).toHaveLength(1);
    expect(manifestEntries[0].id).toBe('archisell');
    expect(manifestEntries[0].manifest).toBeDefined();
  });

  it('manifest wins on agentId conflict (with warn log)', () => {
    // Both yaml and manifest have id 'archisell'
    vi.mocked(listAgentIds).mockReturnValue(['archisell']);
    vi.mocked(loadAgentConfig).mockReturnValue({ name: 'Archisell YAML', description: 'yaml version' });
    vi.mocked(scanProjectManifests).mockReturnValue([baseManifest]);

    const warnSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    initAgentRegistry({ includeProjectAgents: true });
    warnSpy.mockRestore();

    const entries = getRegistryEntries();
    expect(entries).toHaveLength(1);
    // manifest wins
    expect(entries[0].source).toBe('manifest');
    expect(entries[0].name).toBe('archisell');
  });

  it('skips archived manifests (belt-and-braces, since scanProjectManifests already filters)', () => {
    vi.mocked(scanProjectManifests).mockReturnValue([
      { ...baseManifest, status: 'archived', project: 'old-project', memoryNamespace: 'old-project' },
    ]);

    initAgentRegistry({ includeProjectAgents: true });
    expect(getRegistryEntries()).toHaveLength(0);
  });
});

describe('getRegistryContext', () => {
  it('returns null for an unknown agentId', () => {
    initAgentRegistry({ includeProjectAgents: false });
    expect(getRegistryContext('no-such-agent')).toBeNull();
  });

  it('returns the context for a known agentId', () => {
    vi.mocked(listAgentIds).mockReturnValue(['main']);
    vi.mocked(loadAgentConfig).mockReturnValue({ name: 'Main', description: '' });
    initAgentRegistry({ includeProjectAgents: false });

    const ctx = getRegistryContext('main');
    expect(ctx).not.toBeNull();
    expect(ctx!.agentId).toBe('main');
    expect(ctx!.source).toBe('yaml');
  });
});

describe('getRegistryEntry', () => {
  it('returns null for unknown id', () => {
    initAgentRegistry({ includeProjectAgents: false });
    expect(getRegistryEntry('ghost')).toBeNull();
  });
});

describe('rebuildRegistry', () => {
  it('replaces the registry contents and allows re-init', () => {
    vi.mocked(listAgentIds).mockReturnValue(['main']);
    vi.mocked(loadAgentConfig).mockReturnValue({ name: 'Main', description: '' });

    initAgentRegistry({ includeProjectAgents: false });
    expect(getRegistryEntries()).toHaveLength(1);

    // Now change what listAgentIds returns and rebuild
    vi.mocked(listAgentIds).mockReturnValue(['main', 'research']);
    vi.mocked(loadAgentConfig).mockImplementation((id: string) => ({
      name: id,
      description: '',
    }));
    rebuildRegistry({ includeProjectAgents: false });

    expect(getRegistryEntries()).toHaveLength(2);
  });
});
