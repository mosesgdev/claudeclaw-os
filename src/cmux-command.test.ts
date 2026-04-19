import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocks must be declared before importing the subject so the ESM hoist picks them up.
vi.mock('./config.js', () => ({
  CMUX_ENABLED: true,
  PROJECT_ROOT: '/tmp/fake-project',
}));
vi.mock('./cmux.js', () => ({
  ping: vi.fn(),
  listWorkspaces: vi.fn(),
  ensureWorkspace: vi.fn(),
  newWorkspace: vi.fn(),
  send: vi.fn(),
  sendKey: vi.fn(),
  readScreen: vi.fn(),
  findWorkspaceByTitle: vi.fn(),
}));

import * as cmux from './cmux.js';
import { runCmuxCommand, workspaceTitleFor, pollUntilStable } from './cmux-command.js';

const m = vi.mocked(cmux);

beforeEach(() => {
  vi.resetAllMocks();
  // Default: socket reachable.
  m.ping.mockResolvedValue(true);
});

describe('workspaceTitleFor', () => {
  it('slugs the agent and chat into a stable title', () => {
    expect(workspaceTitleFor('12345', 'main')).toBe('claudeclaw-main-12345');
  });

  it('sanitises unsafe characters', () => {
    expect(workspaceTitleFor('discord:channel:42', 'archi/sell')).toBe(
      'claudeclaw-archi-sell-discord-channel-42',
    );
  });
});

describe('runCmuxCommand', () => {
  it('status: reports no workspace when one does not exist', async () => {
    m.listWorkspaces.mockResolvedValue([]);
    const result = await runCmuxCommand({ chatId: '42', agentId: 'main', text: '' });
    expect(result.reply).toMatch(/cmux online/);
    expect(result.reply).toMatch(/no workspace yet/);
  });

  it('status: reports existing workspace when present', async () => {
    m.listWorkspaces.mockResolvedValue([
      { id: 'workspace:7', title: 'claudeclaw-main-42', selected: false },
    ]);
    const result = await runCmuxCommand({ chatId: '42', agentId: 'main', text: 'status' });
    expect(result.reply).toMatch(/workspace:7/);
    expect(result.reply).toMatch(/claudeclaw-main-42/);
  });

  it('ping failure: returns friendly error', async () => {
    m.ping.mockResolvedValue(false);
    const result = await runCmuxCommand({ chatId: '42', agentId: 'main', text: 'hi' });
    expect(result.reply).toMatch(/cmux socket not reachable/);
  });

  it('new: forces workspace creation and reports id', async () => {
    m.newWorkspace.mockResolvedValue('workspace:9');
    const result = await runCmuxCommand({ chatId: '42', agentId: 'main', text: 'new' });
    expect(m.newWorkspace).toHaveBeenCalledWith({
      name: 'claudeclaw-main-42',
      cwd: '/tmp/fake-project',
      command: 'claude',
    });
    expect(result.reply).toMatch(/Created workspace:9/);
  });

  it('read: returns current screen without sending a prompt', async () => {
    m.ensureWorkspace.mockResolvedValue('workspace:3');
    m.readScreen.mockResolvedValue('the screen');
    const result = await runCmuxCommand({ chatId: '42', agentId: 'main', text: 'read' });
    expect(m.send).not.toHaveBeenCalled();
    expect(result.hasScreen).toBe(true);
    expect(result.screen).toBe('the screen');
  });

  it('prompt: sends text, presses enter, polls for stable screen', async () => {
    m.ensureWorkspace.mockResolvedValue('workspace:3');
    // Simulate screen changing once then stabilising.
    m.readScreen
      .mockResolvedValueOnce('frame 1')
      .mockResolvedValueOnce('frame 2')
      .mockResolvedValue('frame 2');

    const result = await runCmuxCommand({
      chatId: '42',
      agentId: 'main',
      text: 'hello claude',
      // Use aggressive timings so the test finishes quickly.
      stabilityTimeoutMs: 100,
    });
    expect(m.send).toHaveBeenCalledWith('workspace:3', 'hello claude');
    expect(m.sendKey).toHaveBeenCalledWith('workspace:3', 'enter');
    expect(result.hasScreen).toBe(true);
    expect(result.screen).toContain('frame 2');
  });

  it('error: catches exceptions and returns them as reply text', async () => {
    m.ensureWorkspace.mockRejectedValue(new Error('socket died'));
    const result = await runCmuxCommand({ chatId: '42', agentId: 'main', text: 'hi' });
    expect(result.reply).toMatch(/cmux error: socket died/);
  });

  it('respects replyCap on long screens', async () => {
    m.ensureWorkspace.mockResolvedValue('workspace:3');
    const huge = 'x'.repeat(10_000);
    m.readScreen.mockResolvedValue(huge);
    const result = await runCmuxCommand({
      chatId: '42',
      agentId: 'main',
      text: 'read',
      replyCap: 100,
    });
    expect(result.screen!.length).toBe(100);
  });
});

describe('pollUntilStable', () => {
  it('returns early when two consecutive reads match', async () => {
    const readFn = vi
      .fn()
      .mockResolvedValueOnce('a')
      .mockResolvedValue('a');

    const out = await pollUntilStable('workspace:1', 5000, {
      readFn: readFn as unknown as typeof import('./cmux.js').readScreen,
      minIntervalMs: 5,
      firstReadDelayMs: 5,
    });
    expect(out).toBe('a');
    // Called at least twice (first read + confirmation).
    expect(readFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('returns the latest read when maxMs expires without stability', async () => {
    let counter = 0;
    const readFn = vi.fn().mockImplementation(async () => `frame-${counter++}`);
    const out = await pollUntilStable('workspace:1', 40, {
      readFn: readFn as unknown as typeof import('./cmux.js').readScreen,
      minIntervalMs: 5,
      firstReadDelayMs: 5,
    });
    expect(out).toMatch(/^frame-\d+$/);
  });
});

describe('CMUX_ENABLED=false', () => {
  it('short-circuits with a disabled message', async () => {
    vi.resetModules();
    vi.doMock('./config.js', () => ({
      CMUX_ENABLED: false,
      PROJECT_ROOT: '/tmp/fake-project',
    }));
    const { runCmuxCommand: runDisabled } = await import('./cmux-command.js');
    const result = await runDisabled({ chatId: '42', agentId: 'main', text: 'hi' });
    expect(result.reply).toMatch(/disabled/);
  });
});
