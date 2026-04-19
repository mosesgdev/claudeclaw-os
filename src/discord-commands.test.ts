/**
 * Tests for discord-commands.ts — /ask slash command (RFC 3c)
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

// ── Imports after mocks ───────────────────────────────────────────────────────
import { slashCommands } from './discord-commands.js';
import { delegateToAgent, getAvailableAgents } from './orchestrator.js';
import { lookupAgentForChannel } from './discord-channel-map.js';

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

  it('has exactly 6 registered commands', () => {
    // newchat, memory, forget, reload-agents, ask, cmux
    expect(slashCommands).toHaveLength(6);
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
