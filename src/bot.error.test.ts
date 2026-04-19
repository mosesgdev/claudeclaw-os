/**
 * Tests for sendProjectLog emission in handleMessage error catch (RFC 3b).
 * Uses a minimal stub of handleMessage by mocking all heavy deps.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./project-logs.js', () => ({
  sendProjectLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    PROJECT_AGENTS_ENABLED: true,
    ALLOWED_CHAT_ID: '111',
    AGENT_ID: 'main',
    CONTEXT_LIMIT: 1000000,
    DASHBOARD_PORT: 3141,
    DASHBOARD_TOKEN: 'tok',
    DASHBOARD_URL: 'http://localhost:3141',
    MAX_MESSAGE_LENGTH: 4096,
    activeBotToken: 'fake-token',
    agentDefaultModel: 'claude-opus-4-5',
    agentMcpAllowlist: [],
    agentSystemPrompt: '',
    agentObsidianConfig: null,
    TYPING_REFRESH_MS: 3000,
    AGENT_TIMEOUT_MS: 300000,
    STREAM_STRATEGY: 'inline',
    MODEL_FALLBACK_CHAIN: [],
    SHOW_COST_FOOTER: false,
    SMART_ROUTING_ENABLED: false,
    SMART_ROUTING_CHEAP_MODEL: null,
    EXFILTRATION_GUARD_ENABLED: false,
    PROTECTED_ENV_VARS: [],
    DAILY_COST_BUDGET: 0,
    HOURLY_TOKEN_BUDGET: 0,
    PROJECT_ROOT: '/tmp',
    OBSIDIAN_WRITE_ENABLED: false,
  };
});

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(),
  runAgentWithRetry: vi.fn(),
}));

vi.mock('./agent-context.js', () => ({
  getDefaultAgentContext: vi.fn(() => ({
    agentId: 'main',
    name: 'main',
    source: 'yaml',
    cwd: '/tmp',
    model: 'claude-opus-4-5',
    mcpServers: [],
    systemPrompt: '',
  })),
  setDefaultAgentContext: vi.fn(),
}));

vi.mock('./db.js', () => ({
  clearSession: vi.fn(),
  getRecentConversation: vi.fn(() => []),
  getRecentMemories: vi.fn(() => []),
  getRecentTaskOutputs: vi.fn(() => []),
  getSession: vi.fn(() => null),
  getSessionConversation: vi.fn(() => []),
  logToHiveMind: vi.fn(),
  pinMemory: vi.fn(),
  unpinMemory: vi.fn(),
  setSession: vi.fn(),
  lookupWaChatId: vi.fn(() => null),
  saveWaMessageMap: vi.fn(),
  saveTokenUsage: vi.fn(),
  saveCompactionEvent: vi.fn(),
  getCompactionCount: vi.fn(() => 0),
}));

vi.mock('./logger.js', () => {
  const leaf = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { logger: { ...leaf, child: vi.fn(() => leaf) } };
});

vi.mock('./memory.js', () => ({
  buildMemoryContext: vi.fn(() => Promise.resolve({ contextText: '', tokenEstimate: 0 })),
  evaluateMemoryRelevance: vi.fn(() => Promise.resolve(false)),
  saveConversationTurn: vi.fn(),
  shouldNudgeMemory: vi.fn(() => false),
  MEMORY_NUDGE_TEXT: '',
}));

vi.mock('./message-classifier.js', () => ({
  classifyMessageComplexity: vi.fn(() => Promise.resolve('full')),
}));

vi.mock('./notify.js', () => ({
  notifyUser: vi.fn(),
}));

vi.mock('./exfiltration-guard.js', () => ({
  scanForSecrets: vi.fn(() => ({ found: false })),
  redactSecrets: vi.fn((t: string) => t),
}));

vi.mock('./rate-tracker.js', () => ({
  trackUsage: vi.fn(),
  getRateStatus: vi.fn(() => ({ ok: true })),
}));

vi.mock('./cost-footer.js', () => ({
  buildCostFooter: vi.fn(() => ''),
}));

vi.mock('./memory-ingest.js', () => ({
  setHighImportanceCallback: vi.fn(),
  setMirrorCallback: vi.fn(),
  ingestConversationTurn: vi.fn(() => Promise.resolve(false)),
}));

vi.mock('./vault-mirror.js', () => ({
  makeVaultMirrorCallback: vi.fn(() => null),
  makeConsolidationMirror: vi.fn(() => null),
}));

vi.mock('./memory-consolidate.js', () => ({
  setConsolidationMirror: vi.fn(),
}));

vi.mock('./message-queue.js', () => ({
  messageQueue: {
    enqueue: vi.fn((_key: string, fn: () => Promise<void>) => fn()),
  },
}));

vi.mock('./orchestrator.js', () => ({
  parseDelegation: vi.fn(() => null),
  delegateToAgent: vi.fn(),
  getAvailableAgents: vi.fn(() => []),
}));

vi.mock('./state.js', () => ({
  emitChatEvent: vi.fn(),
  setProcessing: vi.fn(),
  setActiveAbort: vi.fn(),
  abortActiveQuery: vi.fn(),
}));

vi.mock('./security.js', () => ({
  isLocked: vi.fn(() => false),
  lock: vi.fn(),
  unlock: vi.fn(() => false),
  touchActivity: vi.fn(),
  checkKillPhrase: vi.fn(() => false),
  executeEmergencyKill: vi.fn(),
  isSecurityEnabled: vi.fn(() => false),
  getSecurityStatus: vi.fn(() => ({})),
  audit: vi.fn(),
}));

vi.mock('./channels/telegram.js', () => ({
  TelegramChannel: vi.fn(),
}));

vi.mock('./media.js', () => ({
  downloadMedia: vi.fn(),
  buildPhotoMessage: vi.fn(),
  buildDocumentMessage: vi.fn(),
  buildVideoMessage: vi.fn(),
}));

vi.mock('./errors.js', () => ({
  AgentError: class AgentError extends Error {
    constructor(public category: string, public recovery: { userMessage: string }) {
      super(recovery.userMessage);
    }
  },
}));

// ── Test ──────────────────────────────────────────────────────────────────────

import { handleMessage } from './bot.js';
import { runAgent } from './agent.js';
import { sendProjectLog } from './project-logs.js';

const mockRunAgent = vi.mocked(runAgent);
const mockSendProjectLog = vi.mocked(sendProjectLog);

function makeChannel(send = vi.fn(() => Promise.resolve())) {
  return {
    send,
    maxLength: 4096,
    showTyping: vi.fn(() => Promise.resolve()),
    startTyping: vi.fn(),
    stopTyping: vi.fn(),
  };
}

function makeInbound(text = 'what is the status of the project?') {
  return {
    text,
    chatKey: 'telegram:111',
    attachments: [],
    rawMessageId: 42,
  };
}

describe('handleMessage error catch — sendProjectLog emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits [error] handleMessage log when runAgent throws', async () => {
    mockRunAgent.mockRejectedValue(new Error('Unexpected model failure'));

    const channel = makeChannel();
    const inbound = makeInbound();

    await handleMessage(channel as never, inbound as never);

    // Allow void promises to settle
    await Promise.resolve();
    await Promise.resolve();

    // sendProjectLog should have been called with error level and [error] prefix
    expect(mockSendProjectLog).toHaveBeenCalled();
    const call = mockSendProjectLog.mock.calls.find(([, lvl]) => lvl === 'error');
    expect(call).toBeDefined();
    const [agentId, level, message] = call!;
    expect(agentId).toBe('main');
    expect(level).toBe('error');
    expect(message).toMatch(/^\[error\] handleMessage:/);
  });
});
