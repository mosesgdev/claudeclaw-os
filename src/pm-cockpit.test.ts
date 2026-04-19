import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared before importing the subject so ESM hoist picks them up.
vi.mock('./config.js', () => ({
  CMUX_ENABLED: true,
  PROJECT_AGENTS_ENABLED: true,
  PROJECT_ROOT: '/tmp/fake-project',
}));

vi.mock('./cmux.js', () => ({
  ping: vi.fn(),
  ensureWorkspace: vi.fn(),
  send: vi.fn(),
  sendKey: vi.fn(),
  readScreen: vi.fn(),
  listWorkspaces: vi.fn(),
  newWorkspace: vi.fn(),
  findWorkspaceByTitle: vi.fn(),
}));

// pollUntilStable uses readScreen internally; we stub it at the cmux.js layer
// and also stub pollUntilStable itself via the cmux-command mock so tests run
// without real timing.
vi.mock('./cmux-command.js', () => ({
  pollUntilStable: vi.fn(),
  workspaceTitleFor: (chatId: string, agentId: string) =>
    `claudeclaw-${agentId}-${chatId}`,
}));

vi.mock('./logger.js', () => ({
  logger: {
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

import * as cmux from './cmux.js';
import * as cmuxCommand from './cmux-command.js';
import {
  _resetForTest,
  clearPmCockpits,
  dispatchToPmCockpit,
  ensurePmCockpit,
  formatCockpitReply,
  getPmCockpit,
  maybeRouteToPmCockpit,
  pmWorkspaceTitleFor,
  setPmCockpit,
  type PmCockpit,
} from './pm-cockpit.js';

const mc = vi.mocked(cmux);
const mp = vi.mocked(cmuxCommand);

beforeEach(() => {
  vi.resetAllMocks();
  _resetForTest();
  mc.ping.mockResolvedValue(true);
  mc.ensureWorkspace.mockResolvedValue('workspace:1');
});

// ── pmWorkspaceTitleFor ────────────────────────────────────────────────

describe('pmWorkspaceTitleFor', () => {
  it('produces a stable cockpit title distinct from per-chat titles', () => {
    expect(pmWorkspaceTitleFor('archisell')).toBe('claudeclaw-pm-archisell');
  });

  it('slugs unsafe characters', () => {
    expect(pmWorkspaceTitleFor('my/project:agent')).toBe('claudeclaw-pm-my-project-agent');
  });
});

// ── in-memory map ─────────────────────────────────────────────────────

describe('setPmCockpit / getPmCockpit / clearPmCockpits', () => {
  it('stores and retrieves a cockpit by agentId', () => {
    const c: PmCockpit = { agentId: 'archisell', workspaceId: 'workspace:5', workingDir: '/tmp/proj' };
    setPmCockpit(c);
    expect(getPmCockpit('archisell')).toEqual(c);
  });

  it('returns null for unknown agentId', () => {
    expect(getPmCockpit('unknown')).toBeNull();
  });

  it('clearPmCockpits removes all entries', () => {
    setPmCockpit({ agentId: 'a', workspaceId: 'workspace:1', workingDir: '/a' });
    setPmCockpit({ agentId: 'b', workspaceId: 'workspace:2', workingDir: '/b' });
    clearPmCockpits();
    expect(getPmCockpit('a')).toBeNull();
    expect(getPmCockpit('b')).toBeNull();
  });
});

// ── ensurePmCockpit ───────────────────────────────────────────────────

describe('ensurePmCockpit', () => {
  it('creates a workspace and stores the cockpit', async () => {
    mc.ensureWorkspace.mockResolvedValue('workspace:42');
    const cockpit = await ensurePmCockpit('archisell', '/tmp/archisell');

    expect(mc.ping).toHaveBeenCalled();
    expect(mc.ensureWorkspace).toHaveBeenCalledWith('claudeclaw-pm-archisell', {
      cwd: '/tmp/archisell',
      command: 'claude',
    });
    expect(cockpit).toEqual({
      agentId: 'archisell',
      workspaceId: 'workspace:42',
      workingDir: '/tmp/archisell',
    });
    // Also stored in the in-memory map
    expect(getPmCockpit('archisell')).toEqual(cockpit);
  });

  it('is idempotent — calling twice reuses the existing workspace', async () => {
    mc.ensureWorkspace.mockResolvedValue('workspace:42');
    await ensurePmCockpit('archisell', '/tmp/archisell');
    await ensurePmCockpit('archisell', '/tmp/archisell');

    // ensureWorkspace is called both times (idempotency is in cmux.ensureWorkspace,
    // not in our wrapper), but we get the same workspace id both times.
    expect(mc.ensureWorkspace).toHaveBeenCalledTimes(2);
    expect(getPmCockpit('archisell')?.workspaceId).toBe('workspace:42');
  });

  it('returns null when cmux.ping returns false', async () => {
    mc.ping.mockResolvedValue(false);
    const result = await ensurePmCockpit('archisell', '/tmp/archisell');
    expect(result).toBeNull();
    expect(mc.ensureWorkspace).not.toHaveBeenCalled();
  });

  it('returns null when cmux.ensureWorkspace throws', async () => {
    mc.ensureWorkspace.mockRejectedValue(new Error('socket dead'));
    const result = await ensurePmCockpit('archisell', '/tmp/archisell');
    expect(result).toBeNull();
  });
});

// ── dispatchToPmCockpit ───────────────────────────────────────────────

describe('dispatchToPmCockpit', () => {
  it('returns null for an unknown agentId', async () => {
    const result = await dispatchToPmCockpit('nonexistent', 'hello');
    expect(result).toBeNull();
  });

  it('sends prompt + enter and returns polled screen', async () => {
    setPmCockpit({ agentId: 'archisell', workspaceId: 'workspace:7', workingDir: '/tmp/a' });
    mp.pollUntilStable.mockResolvedValue('screen output here');

    const result = await dispatchToPmCockpit('archisell', 'what is the status?');

    expect(mc.send).toHaveBeenCalledWith('workspace:7', 'what is the status?');
    expect(mc.sendKey).toHaveBeenCalledWith('workspace:7', 'enter');
    expect(mp.pollUntilStable).toHaveBeenCalledWith('workspace:7', expect.any(Number));
    expect(result).toBe('screen output here');
  });

  it('applies replyCap to the returned screen', async () => {
    setPmCockpit({ agentId: 'archisell', workspaceId: 'workspace:7', workingDir: '/tmp/a' });
    mp.pollUntilStable.mockResolvedValue('x'.repeat(5000));

    const result = await dispatchToPmCockpit('archisell', 'prompt', { replyCap: 100 });
    expect(result).toHaveLength(100);
  });

  it('returns null when send throws', async () => {
    setPmCockpit({ agentId: 'archisell', workspaceId: 'workspace:7', workingDir: '/tmp/a' });
    mc.send.mockRejectedValue(new Error('cmux died'));

    const result = await dispatchToPmCockpit('archisell', 'prompt');
    expect(result).toBeNull();
  });
});

// ── maybeRouteToPmCockpit ─────────────────────────────────────────────

describe('maybeRouteToPmCockpit', () => {
  it('returns null when no cockpit exists (runAgent path unchanged)', async () => {
    const result = await maybeRouteToPmCockpit('no-such-agent', 'hi');
    expect(result).toBeNull();
  });

  it('returns the screen when a cockpit exists', async () => {
    setPmCockpit({ agentId: 'archisell', workspaceId: 'workspace:3', workingDir: '/tmp/a' });
    mp.pollUntilStable.mockResolvedValue('cockpit reply');

    const result = await maybeRouteToPmCockpit('archisell', 'build the feature');
    expect(result).toBe('cockpit reply');
  });
});

// ── formatCockpitReply ────────────────────────────────────────────────

describe('formatCockpitReply', () => {
  it('wraps in <pre> for telegram transport', () => {
    const fakeChannel = { transport: 'telegram' } as any;
    const out = formatCockpitReply(fakeChannel, '<hello>');
    expect(out).toBe('<pre>&lt;hello&gt;</pre>');
  });

  it('wraps in triple-backticks for discord transport', () => {
    const fakeChannel = { transport: 'discord' } as any;
    const out = formatCockpitReply(fakeChannel, 'hello world');
    expect(out).toContain('```');
    expect(out).toContain('hello world');
  });

  it('wraps in triple-backticks for unknown transport', () => {
    const fakeChannel = {} as any;
    const out = formatCockpitReply(fakeChannel, 'hi');
    expect(out).toMatch(/^```\n/);
  });

  it('caps telegram output at 3500 chars', () => {
    const fakeChannel = { transport: 'telegram' } as any;
    const big = 'a'.repeat(5000);
    const out = formatCockpitReply(fakeChannel, big);
    // <pre> wraps 3500 chars of content
    expect(out.includes('a'.repeat(3500))).toBe(true);
    expect(out.length).toBeLessThan(4000);
  });

  it('caps discord output at 1900 chars', () => {
    const fakeChannel = { transport: 'discord' } as any;
    const big = 'b'.repeat(3000);
    const out = formatCockpitReply(fakeChannel, big);
    expect(out.includes('b'.repeat(1900))).toBe(true);
    expect(out.length).toBeLessThan(2100);
  });
});
