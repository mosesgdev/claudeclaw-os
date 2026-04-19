import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('./logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
  },
}));

vi.mock('./gh-issue.js', () => ({
  fetchIssue: vi.fn(),
}));

vi.mock('./cmux.js', () => ({
  newWorkspace: vi.fn(),
  send: vi.fn(),
  sendKey: vi.fn(),
}));

vi.mock('./cmux-command.js', () => ({
  pollUntilStable: vi.fn(),
}));

vi.mock('./subagent-sessions.js', () => ({
  createSession: vi.fn(),
  updateStatus: vi.fn(),
}));

vi.mock('./subagent-briefing.js', () => ({
  buildBriefingPrompt: vi.fn().mockReturnValue('BRIEFING PROMPT'),
}));

vi.mock('./db.js', () => ({
  _initTestDatabase: vi.fn(),
  getDb: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn().mockReturnValue('# Project context'),
  },
}));

import { fetchIssue } from './gh-issue.js';
import * as cmuxMod from './cmux.js';
import { pollUntilStable } from './cmux-command.js';
import { createSession } from './subagent-sessions.js';
import { spawnSubagent } from './subagent-spawn.js';
import type { SpawnOptions } from './subagent-spawn.js';

const mockFetchIssue = vi.mocked(fetchIssue);
const mockNewWorkspace = vi.mocked(cmuxMod.newWorkspace);
const mockSend = vi.mocked(cmuxMod.send);
const mockSendKey = vi.mocked(cmuxMod.sendKey);
const mockPollUntilStable = vi.mocked(pollUntilStable);
const mockCreateSession = vi.mocked(createSession);

// ── Discord client mock ───────────────────────────────────────────────

function makeThread(overrides: Partial<{ id: string; guildId: string; setArchived: ReturnType<typeof vi.fn> }> = {}) {
  return {
    id: 'thread-001',
    guildId: 'guild-001',
    setArchived: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeClient(thread = makeThread()) {
  const setArchived = thread.setArchived;
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue({
        threads: {
          create: vi.fn().mockResolvedValue(thread),
        },
      }),
    },
    _thread: thread,
    _setArchived: setArchived,
  };
}

const BASE_ISSUE = {
  number: 42,
  title: 'Add OAuth support',
  body: 'We need Google OAuth.',
  url: 'https://github.com/moses/archisell/issues/42',
  state: 'open' as const,
  labels: ['feat'],
  author: 'mosesgdev',
};

function makeOpts(client: ReturnType<typeof makeClient>, overrides: Partial<SpawnOptions> = {}): SpawnOptions {
  return {
    project: 'archisell',
    agentId: 'archisell',
    issueNumber: 42,
    client: client as unknown as import('discord.js').Client,
    pmChannelId: 'channel-001',
    repo: 'moses/archisell',
    workingDir: '/Users/moses/Projects/archisell',
    vaultProjectContextPath: '/vault/archisell/context.md',
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchIssue.mockResolvedValue(BASE_ISSUE);
  mockNewWorkspace.mockResolvedValue('workspace:99');
  mockSend.mockResolvedValue(undefined);
  mockSendKey.mockResolvedValue(undefined);
  mockPollUntilStable.mockResolvedValue('ready');
  mockCreateSession.mockReturnValue(undefined);
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('spawnSubagent', () => {
  it('happy path: returns session + thread info and calls createSession', async () => {
    const client = makeClient();
    const result = await spawnSubagent(makeOpts(client));

    expect(result.session.project).toBe('archisell');
    expect(result.session.issueNumber).toBe(42);
    expect(result.session.issueTitle).toBe('Add OAuth support');
    expect(result.session.status).toBe('running');
    expect(result.session.workspaceId).toBe('workspace:99');
    expect(result.session.threadId).toBe('thread-001');
    expect(result.thread.id).toBe('thread-001');
    expect(result.thread.url).toContain('thread-001');

    expect(mockCreateSession).toHaveBeenCalledOnce();
    expect(mockCreateSession).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'running',
        project: 'archisell',
        issueNumber: 42,
        workspaceId: 'workspace:99',
        threadId: 'thread-001',
      }),
    );
  });

  it('throws and creates no thread/workspace when gh fetch fails', async () => {
    mockFetchIssue.mockRejectedValue(new Error('repository not found'));
    const client = makeClient();

    await expect(spawnSubagent(makeOpts(client))).rejects.toThrow(
      'failed to fetch issue #42',
    );

    // No thread or workspace should have been created
    expect(client.channels.fetch).not.toHaveBeenCalled();
    expect(mockNewWorkspace).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('throws when thread creation fails and does not create a workspace', async () => {
    const client = makeClient();
    const threadCreate = (client.channels.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      threads: {
        create: vi.fn().mockRejectedValue(new Error('Missing Permissions')),
      },
    });
    void threadCreate;

    await expect(spawnSubagent(makeOpts(client))).rejects.toThrow(
      'failed to create Discord thread',
    );

    expect(mockNewWorkspace).not.toHaveBeenCalled();
    expect(mockCreateSession).not.toHaveBeenCalled();
  });

  it('archives the thread and throws when workspace creation fails', async () => {
    const thread = makeThread();
    const client = makeClient(thread);
    mockNewWorkspace.mockRejectedValue(new Error('cmux: new-workspace failed'));

    await expect(spawnSubagent(makeOpts(client))).rejects.toThrow(
      'failed to create cmux workspace',
    );

    expect(thread.setArchived).toHaveBeenCalledWith(true);
    expect(mockCreateSession).not.toHaveBeenCalled();
  });
});
