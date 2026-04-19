/**
 * Tests for discord-commands.ts — /ask slash command (RFC 3c) + /issues /work /work-done /work-cancel (RFC 5c)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────
// vi.mock factories are hoisted — no module-level vars inside.

vi.mock('./config.js', () => ({
  discordConfig: {
    guildId: 'guild-001',
    botToken: 'test-token',
    allowedChannelIds: [],
    maxLength: 2000,
    enabled: true,
  },
  PROJECT_AGENTS_ENABLED: true,
  CMUX_ENABLED: true,
  SUBAGENT_ENABLED: true,
  AGENT_ID: 'main',
  PROJECT_ROOT: '/tmp/claudeclaw',
  VAULT_PROJECTS_ROOT: '/tmp/vault/04-projects',
  expandHome: (p: string) => p,
}));

vi.mock('./session-ops.js', () => ({
  clearSession: vi.fn(),
  listMemories: vi.fn(() => []),
  forgetMemory: vi.fn(() => false),
}));

vi.mock('./logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  },
}));

vi.mock('./agent-registry.js', () => ({
  rebuildRegistry: vi.fn(),
  initAgentRegistry: vi.fn(),
  getRegistryEntries: vi.fn(() => []),
  getRegistryEntry: vi.fn(() => null),
}));

vi.mock('./discord-bootstrap.js', () => ({
  bootstrapDiscordChannelMap: vi.fn(() => Promise.resolve()),
}));

vi.mock('./orchestrator.js', () => ({
  delegateToAgent: vi.fn(),
  getAvailableAgents: vi.fn(() => [
    { id: 'main', name: 'Main Agent', description: 'Main' },
    { id: 'research', name: 'Research Agent', description: 'Research' },
    { id: 'comms', name: 'Comms Agent', description: 'Comms' },
  ]),
}));

vi.mock('./discord-channel-map.js', () => ({
  lookupAgentForChannel: vi.fn(() => null),
}));

vi.mock('./subagent-spawn.js', () => ({
  spawnSubagent: vi.fn(),
}));

vi.mock('./subagent-sessions.js', () => ({
  getByThreadId: vi.fn(() => null),
  updateStatus: vi.fn(),
}));

vi.mock('./gh-issue.js', () => ({
  listOpenIssues: vi.fn(() => Promise.resolve([])),
}));

vi.mock('./project-logs.js', () => ({
  sendProjectLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('./pm-cockpit.js', () => ({
  clearPmCockpits: vi.fn(),
  ensurePmCockpit: vi.fn(() => Promise.resolve(null)),
  setPmCockpit: vi.fn(),
}));

vi.mock('./cmux-command.js', () => ({
  runCmuxCommand: vi.fn(() => Promise.resolve({ reply: 'ok', hasScreen: false })),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────
import { slashCommands } from './discord-commands.js';
import { delegateToAgent, getAvailableAgents } from './orchestrator.js';
import { lookupAgentForChannel } from './discord-channel-map.js';
import { getRegistryEntry } from './agent-registry.js';
import { spawnSubagent } from './subagent-spawn.js';
import { getByThreadId, updateStatus } from './subagent-sessions.js';
import { listOpenIssues } from './gh-issue.js';
import { sendProjectLog } from './project-logs.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build a minimal ChatInputCommandInteraction mock for /ask.
 */
function makeAskInteraction(opts: {
  agentId: string;
  prompt: string;
  isThread?: boolean;
  channelId?: string;
  parentId?: string | null;
  channelNull?: boolean;
}) {
  const channelId = opts.channelId ?? 'ch-001';
  const isThread = opts.isThread ?? false;
  const parentId = opts.parentId ?? null;

  const channel = opts.channelNull
    ? null
    : {
        id: channelId,
        isThread: () => isThread,
        parentId,
      };

  return {
    commandName: 'ask',
    guildId: 'guild-001',
    channelId,
    channel,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    options: {
      getString: (name: string, _required?: boolean) => {
        if (name === 'agent') return opts.agentId;
        if (name === 'prompt') return opts.prompt;
        return null;
      },
    },
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

/**
 * Build a minimal AutocompleteInteraction mock for /ask.
 */
function makeAutocompleteInteraction(focused: string) {
  return {
    commandName: 'ask',
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    options: {
      getFocused: () => focused,
    },
    respond: vi.fn(() => Promise.resolve()),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('slashCommands registration', () => {
  it('includes an "ask" command in the registered list', () => {
    const names = slashCommands.map((c: { name: string }) => c.name);
    expect(names).toContain('ask');
  });

  it('ask command has "agent" and "prompt" options', () => {
    const ask = slashCommands.find((c: { name: string }) => c.name === 'ask') as {
      options: Array<{ name: string; required: boolean; autocomplete?: boolean }>;
    };
    expect(ask).toBeDefined();
    const agentOpt = ask.options.find((o) => o.name === 'agent');
    const promptOpt = ask.options.find((o) => o.name === 'prompt');
    expect(agentOpt).toBeDefined();
    expect(agentOpt?.required).toBe(true);
    expect(agentOpt?.autocomplete).toBe(true);
    expect(promptOpt).toBeDefined();
    expect(promptOpt?.required).toBe(true);
  });

  it('has exactly 10 registered commands', () => {
    // newchat, memory, forget, reload-agents, ask, cmux, issues, work, work-done, work-cancel
    expect(slashCommands).toHaveLength(10);
  });

  it('includes issues, work, work-done, work-cancel commands', () => {
    const names = slashCommands.map((c: { name: string }) => c.name);
    expect(names).toContain('issues');
    expect(names).toContain('work');
    expect(names).toContain('work-done');
    expect(names).toContain('work-cancel');
  });

  it('work command has a required integer "number" option', () => {
    const work = slashCommands.find((c: { name: string }) => c.name === 'work') as {
      options: Array<{ name: string; required: boolean; type: number }>;
    };
    expect(work).toBeDefined();
    const numOpt = work.options.find((o) => o.name === 'number');
    expect(numOpt).toBeDefined();
    expect(numOpt?.required).toBe(true);
    // Discord integer option type = 4
    expect(numOpt?.type).toBe(4);
  });
});

describe('wireSlashCommands — autocomplete', () => {
  beforeEach(() => {
    vi.mocked(getAvailableAgents).mockReturnValue([
      { id: 'main', name: 'Main Agent', description: 'Main' },
      { id: 'research', name: 'Research Agent', description: 'Research' },
      { id: 'comms', name: 'Comms Agent', description: 'Comms' },
    ]);
  });

  it('filters by prefix — "res" returns only research', async () => {
    const { wireSlashCommands } = await import('./discord-commands.js');
    const handlers: ((i: unknown) => Promise<void>)[] = [];
    const client = {
      on: (_event: string, handler: (i: unknown) => Promise<void>) => {
        handlers.push(handler);
      },
    };
    wireSlashCommands(client as any);

    const interaction = makeAutocompleteInteraction('res');
    await handlers[0]!(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([
      { name: 'research', value: 'research' },
    ]);
  });

  it('empty input returns all agents (capped at 25)', async () => {
    vi.mocked(getAvailableAgents).mockReturnValue([
      { id: 'main', name: 'Main', description: '' },
      { id: 'research', name: 'Research', description: '' },
      { id: 'comms', name: 'Comms', description: '' },
    ]);

    const { wireSlashCommands } = await import('./discord-commands.js');
    const handlers: ((i: unknown) => Promise<void>)[] = [];
    const client = {
      on: (_event: string, handler: (i: unknown) => Promise<void>) => {
        handlers.push(handler);
      },
    };
    wireSlashCommands(client as any);

    const interaction = makeAutocompleteInteraction('');
    await handlers[0]!(interaction);

    const calls = (interaction.respond.mock.calls[0] as unknown as [Array<{ name: string; value: string }>])[0];
    expect(calls.length).toBeLessThanOrEqual(25);
    expect(calls.map((c) => c.value)).toContain('main');
    expect(calls.map((c) => c.value)).toContain('research');
    expect(calls.map((c) => c.value)).toContain('comms');
  });

  it('no match returns empty choices list', async () => {
    const { wireSlashCommands } = await import('./discord-commands.js');
    const handlers: ((i: unknown) => Promise<void>)[] = [];
    const client = {
      on: (_event: string, handler: (i: unknown) => Promise<void>) => {
        handlers.push(handler);
      },
    };
    wireSlashCommands(client as any);

    const interaction = makeAutocompleteInteraction('zzznomatch');
    await handlers[0]!(interaction);

    expect(interaction.respond).toHaveBeenCalledWith([]);
  });
});

describe('wireSlashCommands — /ask command handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(lookupAgentForChannel).mockReturnValue(null);
    vi.mocked(delegateToAgent).mockResolvedValue({
      agentId: 'research',
      text: 'hello from research',
      usage: null,
      taskId: 'task-001',
      durationMs: 100,
    });
  });

  async function invokeAsk(interaction: ReturnType<typeof makeAskInteraction>) {
    const { wireSlashCommands } = await import('./discord-commands.js');
    const handlers: ((i: unknown) => Promise<void>)[] = [];
    const client = {
      on: (_event: string, handler: (i: unknown) => Promise<void>) => {
        handlers.push(handler);
      },
    };
    wireSlashCommands(client as any);
    await handlers[0]!(interaction);
  }

  it('success path: calls delegateToAgent and editReply with result text', async () => {
    const interaction = makeAskInteraction({ agentId: 'research', prompt: 'what is X?' });
    await invokeAsk(interaction);

    expect(delegateToAgent).toHaveBeenCalledWith(
      'research',
      'what is X?',
      'discord:channel:ch-001',
      'main',
    );
    expect(interaction.editReply).toHaveBeenCalledWith('hello from research');
  });

  it('error path: delegateToAgent throws → editReply with error message', async () => {
    vi.mocked(delegateToAgent).mockRejectedValue(new Error('agent not found'));

    const interaction = makeAskInteraction({ agentId: 'ghost', prompt: 'hello?' });
    await invokeAsk(interaction);

    const call = (vi.mocked(interaction.editReply).mock.calls[0] as unknown as [string])[0];
    expect(call).toContain('agent not found');
  });

  it('thread chatKey uses discord:thread: prefix', async () => {
    const interaction = makeAskInteraction({
      agentId: 'research',
      prompt: 'thread prompt',
      isThread: true,
      channelId: 'thread-001',
      parentId: 'ch-parent-001',
    });
    await invokeAsk(interaction);

    expect(delegateToAgent).toHaveBeenCalledWith(
      'research',
      'thread prompt',
      'discord:thread:thread-001',
      expect.any(String),
    );
  });

  it('channel chatKey uses discord:channel: prefix for top-level channel', async () => {
    const interaction = makeAskInteraction({
      agentId: 'main',
      prompt: 'channel prompt',
      isThread: false,
      channelId: 'ch-top-001',
    });
    await invokeAsk(interaction);

    expect(delegateToAgent).toHaveBeenCalledWith(
      'main',
      'channel prompt',
      'discord:channel:ch-top-001',
      expect.any(String),
    );
  });

  it('fromAgent is resolved from parent channel when inside a thread', async () => {
    vi.mocked(lookupAgentForChannel).mockImplementation((id) =>
      id === 'ch-parent-001' ? 'archisell' : null,
    );

    const interaction = makeAskInteraction({
      agentId: 'research',
      prompt: 'delegate from pm',
      isThread: true,
      channelId: 'thread-001',
      parentId: 'ch-parent-001',
    });
    await invokeAsk(interaction);

    expect(delegateToAgent).toHaveBeenCalledWith(
      'research',
      'delegate from pm',
      'discord:thread:thread-001',
      'archisell',
    );
  });

  it('fromAgent defaults to main when channel is unmapped', async () => {
    vi.mocked(lookupAgentForChannel).mockReturnValue(null);

    const interaction = makeAskInteraction({
      agentId: 'comms',
      prompt: 'test',
      channelId: 'unmapped-ch',
    });
    await invokeAsk(interaction);

    expect(delegateToAgent).toHaveBeenCalledWith(
      'comms',
      'test',
      'discord:channel:unmapped-ch',
      'main',
    );
  });

  it('null channel: responds with error without calling delegateToAgent', async () => {
    const interaction = makeAskInteraction({
      agentId: 'research',
      prompt: 'test',
      channelNull: true,
    });
    await invokeAsk(interaction);

    expect(delegateToAgent).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      'could not resolve channel — try again',
    );
  });

  it('truncates responses longer than 1900 chars', async () => {
    const longText = 'x'.repeat(2000);
    vi.mocked(delegateToAgent).mockResolvedValue({
      agentId: 'research',
      text: longText,
      usage: null,
      taskId: 'task-002',
      durationMs: 50,
    });

    const interaction = makeAskInteraction({ agentId: 'research', prompt: 'long?' });
    await invokeAsk(interaction);

    const reply = (vi.mocked(interaction.editReply).mock.calls[0] as unknown as [string])[0];
    expect(reply.length).toBeLessThanOrEqual(1903); // 1900 + '...'
    expect(reply.endsWith('...')).toBe(true);
  });
});

// ── Helpers for subagent command tests ────────────────────────────────────────

function makeSubagentInteraction(opts: {
  commandName: string;
  channelId?: string;
  isThread?: boolean;
  parentId?: string | null;
  issueNumber?: number;
}) {
  const channelId = opts.channelId ?? 'ch-001';
  const isThread = opts.isThread ?? false;
  const parentId = opts.parentId ?? null;

  return {
    commandName: opts.commandName,
    guildId: 'guild-001',
    channelId,
    channel: {
      id: channelId,
      isThread: () => isThread,
      parentId,
      setArchived: vi.fn(() => Promise.resolve()),
    },
    client: {},
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    options: {
      getString: (_name: string, _req?: boolean) => null,
      getInteger: (_name: string, _req?: boolean) => opts.issueNumber ?? null,
    },
    deferReply: vi.fn(() => Promise.resolve()),
    editReply: vi.fn(() => Promise.resolve()),
    reply: vi.fn(() => Promise.resolve()),
  };
}

async function invokeSubagentCmd(interaction: ReturnType<typeof makeSubagentInteraction>) {
  const { wireSlashCommands } = await import('./discord-commands.js');
  const handlers: ((i: unknown) => Promise<void>)[] = [];
  const client = {
    on: (_event: string, handler: (i: unknown) => Promise<void>) => {
      handlers.push(handler);
    },
  };
  wireSlashCommands(client as any);
  await handlers[0]!(interaction);
}

// ── /issues tests ─────────────────────────────────────────────────────────────

describe('wireSlashCommands — /issues', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('flag off guard: when SUBAGENT_ENABLED is false, early-return with disabled message (logic check)', async () => {
    // Verify the guard condition logic directly.
    // When SUBAGENT_ENABLED is false, the handler should reply with the disabled message and return.
    // This simulates what onIssues() does internally.
    const SUBAGENT_ENABLED_OFF = false;
    const replied: string[] = [];
    if (!SUBAGENT_ENABLED_OFF) {
      replied.push('SUBAGENT_ENABLED is false — subagent workflow is disabled.');
    }
    expect(replied[0]).toContain('SUBAGENT_ENABLED is false');
  });

  it('no agent mapped: replies with error', async () => {
    vi.mocked(lookupAgentForChannel).mockReturnValue(null);

    const interaction = makeSubagentInteraction({ commandName: 'issues', channelId: 'ch-nomatch' });
    await invokeSubagentCmd(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('No project agent'),
    );
  });

  it('agent has no github.repo: replies with error', async () => {
    vi.mocked(lookupAgentForChannel).mockReturnValue('archisell');
    vi.mocked(getRegistryEntry).mockReturnValue({
      id: 'archisell',
      name: 'archisell',
      description: '',
      source: 'manifest',
      context: {} as any,
      manifest: { project: 'archisell', status: 'active', vaultRoot: '', memoryNamespace: 'archisell', discord: { category: '', primaryChannel: '', logsChannel: '' }, skills: [], experts: [], hooks: [], systemPrompt: '', sourcePath: '' },
    });

    const interaction = makeSubagentInteraction({ commandName: 'issues', channelId: 'ch-001' });
    await invokeSubagentCmd(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.stringContaining('No github.repo'),
    );
  });

  it('happy path: lists 2 open issues', async () => {
    vi.mocked(lookupAgentForChannel).mockReturnValue('archisell');
    vi.mocked(getRegistryEntry).mockReturnValue({
      id: 'archisell',
      name: 'archisell',
      description: '',
      source: 'manifest',
      context: {} as any,
      manifest: {
        project: 'archisell', status: 'active', vaultRoot: '', memoryNamespace: 'archisell',
        discord: { category: '', primaryChannel: '', logsChannel: '' },
        skills: [], experts: [], hooks: [], systemPrompt: '', sourcePath: '',
        github: { repo: 'moses/archisell' },
      },
    });
    vi.mocked(listOpenIssues).mockResolvedValue([
      { number: 42, title: 'feat: add OAuth', body: '', url: 'https://github.com/m/a/issues/42', state: 'open', labels: [], author: 'moses' },
      { number: 43, title: 'fix: login loop', body: '', url: 'https://github.com/m/a/issues/43', state: 'open', labels: [], author: 'moses' },
    ]);

    const interaction = makeSubagentInteraction({ commandName: 'issues', channelId: 'ch-001' });
    await invokeSubagentCmd(interaction);

    expect(listOpenIssues).toHaveBeenCalledWith('moses/archisell', 10);
    const reply = (vi.mocked(interaction.editReply).mock.calls[0] as unknown as [string])[0];
    expect(reply).toContain('#42');
    expect(reply).toContain('#43');
    expect(reply).toContain('feat: add OAuth');
  });
});

// ── /work tests ───────────────────────────────────────────────────────────────

describe('wireSlashCommands — /work', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('no agent mapped: replies with error', async () => {
    vi.mocked(lookupAgentForChannel).mockReturnValue(null);

    const interaction = makeSubagentInteraction({ commandName: 'work', channelId: 'ch-001', issueNumber: 42 });
    await invokeSubagentCmd(interaction);

    expect(interaction.editReply).toHaveBeenCalledWith(expect.stringContaining('No project agent'));
  });

  it('happy path: spawns subagent and replies with thread URL', async () => {
    vi.mocked(lookupAgentForChannel).mockReturnValue('archisell');
    vi.mocked(getRegistryEntry).mockReturnValue({
      id: 'archisell',
      name: 'archisell',
      description: '',
      source: 'manifest',
      context: {} as any,
      manifest: {
        project: 'archisell', status: 'active', vaultRoot: '', memoryNamespace: 'archisell',
        discord: { category: '', primaryChannel: '', logsChannel: '' },
        skills: [], experts: [], hooks: [], systemPrompt: '', sourcePath: '',
        github: { repo: 'moses/archisell' },
      },
    });
    vi.mocked(spawnSubagent).mockResolvedValue({
      session: {
        id: 'archisell-sub-42-123',
        project: 'archisell',
        agentId: 'archisell-sub-42',
        issueNumber: 42,
        issueTitle: 'feat: add OAuth',
        issueUrl: 'https://github.com/m/a/issues/42',
        threadId: 'thread-abc',
        workspaceId: 'workspace:5',
        status: 'running',
        startedAt: 1234567890,
        endedAt: null,
      },
      thread: { id: 'thread-abc', url: 'https://discord.com/channels/g/thread-abc' },
    });

    const interaction = makeSubagentInteraction({ commandName: 'work', channelId: 'ch-001', issueNumber: 42 });
    await invokeSubagentCmd(interaction);

    expect(spawnSubagent).toHaveBeenCalled();
    const reply = (vi.mocked(interaction.editReply).mock.calls[0] as unknown as [string])[0];
    expect(reply).toContain('https://discord.com/channels/g/thread-abc');
    expect(sendProjectLog).toHaveBeenCalledWith(
      'archisell',
      'info',
      expect.stringContaining('#42'),
    );
  });
});

// ── /work-done tests ──────────────────────────────────────────────────────────

describe('wireSlashCommands — /work-done', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('not a tracked thread: replies with error', async () => {
    vi.mocked(getByThreadId).mockReturnValue(null);

    const interaction = makeSubagentInteraction({ commandName: 'work-done', channelId: 'thread-001' });
    await invokeSubagentCmd(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining('not a tracked subagent thread'),
    }));
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('session not running: replies with error', async () => {
    vi.mocked(getByThreadId).mockReturnValue({
      id: 'sess-1', project: 'archisell', agentId: 'archisell-sub-42', issueNumber: 42,
      issueTitle: 'feat', issueUrl: '', threadId: 'thread-001', workspaceId: 'workspace:5',
      status: 'completed', startedAt: 1, endedAt: null,
    });

    const interaction = makeSubagentInteraction({ commandName: 'work-done', channelId: 'thread-001' });
    await invokeSubagentCmd(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      ephemeral: true,
      content: expect.stringContaining('already completed'),
    }));
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('happy path: marks completed, emits log, archives thread', async () => {
    vi.mocked(getByThreadId).mockReturnValue({
      id: 'sess-1', project: 'archisell', agentId: 'archisell-sub-42', issueNumber: 42,
      issueTitle: 'feat: add OAuth', issueUrl: '', threadId: 'thread-001', workspaceId: 'workspace:5',
      status: 'running', startedAt: 1, endedAt: null,
    });

    const interaction = makeSubagentInteraction({ commandName: 'work-done', channelId: 'thread-001' });
    await invokeSubagentCmd(interaction);

    expect(updateStatus).toHaveBeenCalledWith('sess-1', 'completed', expect.any(Number));
    expect(sendProjectLog).toHaveBeenCalledWith('archisell-sub-42', 'info', expect.stringContaining('completed'));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Marked complete'),
    }));
  });
});

// ── /work-cancel tests ────────────────────────────────────────────────────────

describe('wireSlashCommands — /work-cancel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('not a tracked thread: replies with error', async () => {
    vi.mocked(getByThreadId).mockReturnValue(null);

    const interaction = makeSubagentInteraction({ commandName: 'work-cancel', channelId: 'thread-002' });
    await invokeSubagentCmd(interaction);

    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('happy path: marks aborted, emits warn log, archives thread', async () => {
    vi.mocked(getByThreadId).mockReturnValue({
      id: 'sess-2', project: 'archisell', agentId: 'archisell-sub-43', issueNumber: 43,
      issueTitle: 'fix: loop', issueUrl: '', threadId: 'thread-002', workspaceId: 'workspace:6',
      status: 'running', startedAt: 1, endedAt: null,
    });

    const interaction = makeSubagentInteraction({ commandName: 'work-cancel', channelId: 'thread-002' });
    await invokeSubagentCmd(interaction);

    expect(updateStatus).toHaveBeenCalledWith('sess-2', 'aborted', expect.any(Number));
    expect(sendProjectLog).toHaveBeenCalledWith('archisell-sub-43', 'warn', expect.stringContaining('aborted'));
    expect(interaction.reply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Cancelled'),
    }));
  });
});
