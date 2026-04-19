/**
 * Tests for sendProjectLog emitters in scheduler.ts (RFC 3b).
 * Uses fake timers to trigger runDueTasks via the setInterval loop.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('./project-logs.js', () => ({
  sendProjectLog: vi.fn(() => Promise.resolve()),
}));

vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    PROJECT_AGENTS_ENABLED: true,
    ALLOWED_CHAT_ID: '12345',
    AGENT_ID: 'main',
    agentMcpAllowlist: [],
  };
});

vi.mock('./db.js', () => ({
  getDueTasks: vi.fn(() => []),
  getSession: vi.fn(() => null),
  logConversationTurn: vi.fn(),
  markTaskRunning: vi.fn(),
  updateTaskAfterRun: vi.fn(),
  resetStuckTasks: vi.fn(() => 0),
  claimNextMissionTask: vi.fn(() => null),
  completeMissionTask: vi.fn(),
  resetStuckMissionTasks: vi.fn(() => 0),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('./message-queue.js', () => ({
  messageQueue: {
    enqueue: vi.fn((_key: string, fn: () => Promise<void>) => fn()),
  },
}));

vi.mock('./agent.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('./bot.js', () => ({
  formatForTelegram: vi.fn((t: string) => t),
  splitMessage: vi.fn((t: string) => [t]),
}));

import { initScheduler } from './scheduler.js';
import { getDueTasks } from './db.js';
import { runAgent } from './agent.js';
import { sendProjectLog } from './project-logs.js';

const mockGetDueTasks = vi.mocked(getDueTasks);
const mockRunAgent = vi.mocked(runAgent);
const mockSendProjectLog = vi.mocked(sendProjectLog);

function makeFakeTask(prompt = 'Check daily briefing for the project') {
  return {
    id: 'task-abc',
    prompt,
    schedule: '0 9 * * *',
    agent_id: 'main',
    status: 'active' as const,
    next_run: Math.floor(Date.now() / 1000) - 60,
    last_run: null,
    last_result: null,
    last_status: null,
    started_at: null,
    created_at: Math.floor(Date.now() / 1000) - 3600,
  };
}

describe('scheduler sendProjectLog emitters', () => {
  let sender: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    sender = vi.fn(() => Promise.resolve());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function triggerOneTick() {
    // initScheduler registers setInterval(60s). Advance past it to fire once.
    initScheduler(sender, 'main');
    await vi.advanceTimersByTimeAsync(60_000);
  }

  it('emits [scheduled] running log when task starts', async () => {
    mockGetDueTasks.mockReturnValue([makeFakeTask()]);
    mockRunAgent.mockResolvedValue({ text: 'done', aborted: false, usage: null, newSessionId: undefined });

    await triggerOneTick();

    const startCall = mockSendProjectLog.mock.calls.find(
      ([, , msg]) => typeof msg === 'string' && msg.includes('running'),
    );
    expect(startCall).toBeDefined();
    expect(startCall![0]).toBe('main');
    expect(startCall![1]).toBe('info');
    expect(startCall![2]).toMatch(/\[scheduled\].*running/);
  });

  it('emits [scheduled] done log on success', async () => {
    mockGetDueTasks.mockReturnValue([makeFakeTask()]);
    mockRunAgent.mockResolvedValue({ text: 'All done!', aborted: false, usage: null, newSessionId: undefined });

    await triggerOneTick();

    const doneCall = mockSendProjectLog.mock.calls.find(
      ([, , msg]) => typeof msg === 'string' && msg.includes('done'),
    );
    expect(doneCall).toBeDefined();
    expect(doneCall![0]).toBe('main');
    expect(doneCall![1]).toBe('info');
    expect(doneCall![2]).toMatch(/\[scheduled\].*done \(\d+\.\d+s\)/);
  });

  it('emits [scheduled] failed warn log on error', async () => {
    mockGetDueTasks.mockReturnValue([makeFakeTask()]);
    mockRunAgent.mockRejectedValue(new Error('Network timeout'));

    await triggerOneTick();

    const failCall = mockSendProjectLog.mock.calls.find(
      ([, , msg]) => typeof msg === 'string' && msg.includes('failed'),
    );
    expect(failCall).toBeDefined();
    expect(failCall![0]).toBe('main');
    expect(failCall![1]).toBe('warn');
    expect(failCall![2]).toMatch(/\[scheduled\].*failed: Network timeout/);
  });
});
