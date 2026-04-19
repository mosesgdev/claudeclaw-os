/**
 * Tests for sendProjectLog emitters in orchestrator.ts (RFC 3b).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./project-logs.js', () => ({
  sendProjectLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return { ...actual, PROJECT_AGENTS_ENABLED: true };
});

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('./db.js', () => ({
  logToHiveMind: vi.fn(),
  createInterAgentTask: vi.fn(),
  completeInterAgentTask: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(() => Promise.resolve({ contextText: '' })),
}));

vi.mock('./agent-registry.js', () => ({
  initAgentRegistry: vi.fn(),
  getRegistryEntries: vi.fn(() => [
    { id: 'research', name: 'Research Agent', description: 'Does research', source: 'yaml', cwd: '/tmp' },
  ]),
  getRegistryContext: vi.fn(() => ({
    agentId: 'research',
    name: 'Research Agent',
    source: 'yaml',
    cwd: '/tmp',
    systemPrompt: 'You are a researcher.',
    mcpServers: [],
    model: undefined,
  })),
}));

import { delegateToAgent, initOrchestrator } from './orchestrator.js';
import { runAgent } from './agent.js';
import { sendProjectLog } from './project-logs.js';

const mockRunAgent = vi.mocked(runAgent);
const mockSendProjectLog = vi.mocked(sendProjectLog);

describe('orchestrator sendProjectLog emitters', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initOrchestrator();
  });

  it('emits [mission] Delegated log to fromAgent on success', async () => {
    mockRunAgent.mockResolvedValue({ text: 'Research complete.', aborted: false, usage: null, newSessionId: undefined });

    await delegateToAgent('research', 'Look into market trends for Q2', 'chat123', 'main');

    await Promise.resolve();

    expect(mockSendProjectLog).toHaveBeenCalledOnce();
    const [agentId, level, message] = mockSendProjectLog.mock.calls[0];
    expect(agentId).toBe('main');   // fromAgent's channel
    expect(level).toBe('info');
    expect(message).toMatch(/^\[mission\] Delegated to research: "Look into market trends/);
  });

  it('emits [mission] Delegation failed warn log to fromAgent on error', async () => {
    mockRunAgent.mockRejectedValue(new Error('Agent crashed'));

    await expect(
      delegateToAgent('research', 'Look into market trends for Q2', 'chat123', 'main'),
    ).rejects.toThrow('Agent crashed');

    await Promise.resolve();

    expect(mockSendProjectLog).toHaveBeenCalledOnce();
    const [agentId, level, message] = mockSendProjectLog.mock.calls[0];
    expect(agentId).toBe('main');   // fromAgent's channel
    expect(level).toBe('warn');
    expect(message).toMatch(/^\[mission\] Delegation to research failed: Agent crashed/);
  });
});
