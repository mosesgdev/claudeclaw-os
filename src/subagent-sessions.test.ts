import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  createSession,
  getByThreadId,
  getByIssueNumber,
  listRunning,
  updateStatus,
} from './subagent-sessions.js';
import type { SubagentSession } from './subagent-sessions.js';

// ── Helpers ───────────────────────────────────────────────────────────

let idCounter = 0;

function makeSession(overrides: Partial<Omit<SubagentSession, 'endedAt'>> = {}): Omit<SubagentSession, 'endedAt'> {
  idCounter++;
  return {
    id: `session-${idCounter}`,
    project: 'archisell',
    agentId: `archisell-sub-${idCounter}`,
    issueNumber: idCounter,
    issueTitle: `Test issue ${idCounter}`,
    issueUrl: `https://github.com/moses/archisell/issues/${idCounter}`,
    threadId: `thread-${idCounter}`,
    workspaceId: `workspace:${idCounter}`,
    status: 'running',
    startedAt: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

// ── Setup ─────────────────────────────────────────────────────────────

beforeEach(() => {
  _initTestDatabase();
  idCounter = 0;
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('createSession + getByThreadId', () => {
  it('inserts a session and retrieves it by threadId', () => {
    const s = makeSession({ threadId: 'thread-abc', issueNumber: 42 });
    createSession(s);

    const found = getByThreadId('thread-abc');
    expect(found).not.toBeNull();
    expect(found!.id).toBe(s.id);
    expect(found!.project).toBe('archisell');
    expect(found!.issueNumber).toBe(42);
    expect(found!.status).toBe('running');
    expect(found!.endedAt).toBeNull();
  });

  it('returns null for an unknown threadId', () => {
    expect(getByThreadId('no-such-thread')).toBeNull();
  });
});

describe('getByIssueNumber', () => {
  it('returns the most recent session for project + issueNumber', () => {
    const s1 = makeSession({ project: 'archisell', issueNumber: 10, startedAt: 1000 });
    const s2 = makeSession({ project: 'archisell', issueNumber: 10, startedAt: 2000 });
    createSession(s1);
    createSession(s2);

    const found = getByIssueNumber('archisell', 10);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(s2.id); // most recent
  });

  it('returns null when no session exists for the project+issue', () => {
    expect(getByIssueNumber('archisell', 999)).toBeNull();
  });
});

describe('listRunning', () => {
  it('returns only sessions with status running', () => {
    const s1 = makeSession({ status: 'running' });
    const s2 = makeSession({ status: 'completed' });
    const s3 = makeSession({ status: 'running' });
    createSession(s1);
    createSession(s2);
    createSession(s3);

    const running = listRunning();
    expect(running).toHaveLength(2);
    const ids = running.map((r) => r.id);
    expect(ids).toContain(s1.id);
    expect(ids).toContain(s3.id);
    expect(ids).not.toContain(s2.id);
  });

  it('returns empty array when no sessions are running', () => {
    expect(listRunning()).toEqual([]);
  });
});

describe('updateStatus', () => {
  it('updates status without setting endedAt', () => {
    const s = makeSession({ status: 'running' });
    createSession(s);

    updateStatus(s.id, 'completed');

    const found = getByThreadId(s.threadId);
    expect(found!.status).toBe('completed');
    expect(found!.endedAt).toBeNull();
  });

  it('updates status and sets endedAt when provided', () => {
    const s = makeSession({ status: 'running' });
    createSession(s);
    const now = Math.floor(Date.now() / 1000);

    updateStatus(s.id, 'aborted', now);

    const found = getByThreadId(s.threadId);
    expect(found!.status).toBe('aborted');
    expect(found!.endedAt).toBe(now);
  });
});
