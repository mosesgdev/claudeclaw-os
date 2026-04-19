import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing the module under test
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'child_process';
import { fetchIssue, listOpenIssues } from './gh-issue.js';

const mockExecFile = vi.mocked(execFile);

// Helper to make execFile resolve with a JSON string.
// promisify(execFile) calls execFile(cmd, args, callback) — three args.
function mockSuccess(data: unknown): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFile.mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1] as (err: null, result: { stdout: string; stderr: string }) => void;
    // Node's promisify wraps the callback result in an object when there are multiple values.
    // For execFile the promisified signature is: callback(err, { stdout, stderr })
    cb(null, { stdout: JSON.stringify(data), stderr: '' });
    return {} as ReturnType<typeof execFile>;
  });
}

// Helper to make execFile reject with an error
function mockFailure(message: string): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockExecFile.mockImplementation((...args: any[]) => {
    const cb = args[args.length - 1] as (err: Error) => void;
    cb(new Error(message));
    return {} as ReturnType<typeof execFile>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── fetchIssue ────────────────────────────────────────────────────────

describe('fetchIssue', () => {
  it('parses a gh issue view response with label objects and author object', async () => {
    mockSuccess({
      number: 42,
      title: 'Add OAuth support',
      body: 'We need Google OAuth.',
      url: 'https://github.com/moses/archisell/issues/42',
      state: 'OPEN',
      labels: [{ name: 'feat' }, { name: 'auth' }],
      author: { login: 'mosesgdev' },
    });

    const issue = await fetchIssue('moses/archisell', 42);

    expect(issue.number).toBe(42);
    expect(issue.title).toBe('Add OAuth support');
    expect(issue.body).toBe('We need Google OAuth.');
    expect(issue.url).toBe('https://github.com/moses/archisell/issues/42');
    expect(issue.state).toBe('open');
    expect(issue.labels).toEqual(['feat', 'auth']);
    expect(issue.author).toBe('mosesgdev');
  });

  it('throws when gh CLI returns an error', async () => {
    mockFailure('gh: command not found');

    await expect(fetchIssue('moses/archisell', 42)).rejects.toThrow('gh: command not found');
  });
});

// ── listOpenIssues ────────────────────────────────────────────────────

describe('listOpenIssues', () => {
  it('returns an array of parsed issues from gh issue list', async () => {
    mockSuccess([
      {
        number: 10,
        title: 'First issue',
        body: 'Body of first.',
        url: 'https://github.com/moses/archisell/issues/10',
        state: 'OPEN',
        labels: [],
        author: { login: 'alice' },
      },
      {
        number: 11,
        title: 'Second issue',
        body: '',
        url: 'https://github.com/moses/archisell/issues/11',
        state: 'OPEN',
        labels: [{ name: 'bug' }],
        author: { login: 'bob' },
      },
    ]);

    const issues = await listOpenIssues('moses/archisell', 10);

    expect(issues).toHaveLength(2);
    expect(issues[0].number).toBe(10);
    expect(issues[0].labels).toEqual([]);
    expect(issues[0].author).toBe('alice');
    expect(issues[1].number).toBe(11);
    expect(issues[1].labels).toEqual(['bug']);
    expect(issues[1].author).toBe('bob');
  });

  it('throws when gh CLI returns an error', async () => {
    mockFailure('repository not found');

    await expect(listOpenIssues('moses/nonexistent', 30)).rejects.toThrow('repository not found');
  });
});
