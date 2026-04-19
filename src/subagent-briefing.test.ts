import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { buildBriefingPrompt } from './subagent-briefing.js';

const BASE_INPUT = {
  project: 'archisell',
  issueNumber: 42,
  issueTitle: 'Add OAuth support',
  issueBody: 'Users need to log in via Google OAuth.',
  issueUrl: 'https://github.com/moses/archisell/issues/42',
  projectContextMd: '# Archisell\n\nThis is the project context.',
  workingDir: '/Users/moses/Projects/archisell',
  currentBranch: 'main',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildBriefingPrompt', () => {
  it('renders a complete prompt with project context', () => {
    const prompt = buildBriefingPrompt(BASE_INPUT);

    expect(prompt).toContain('You are working on a specific GitHub issue for the archisell project.');
    expect(prompt).toContain('## Issue #42: Add OAuth support');
    expect(prompt).toContain('Users need to log in via Google OAuth.');
    expect(prompt).toContain('## Project context');
    expect(prompt).toContain('# Archisell');
    expect(prompt).toContain('## Repository');
    expect(prompt).toContain('Working directory: /Users/moses/Projects/archisell');
    expect(prompt).toContain('Branch: main');
    expect(prompt).toContain('## Constraints');
    expect(prompt).toContain("- Use `/compact` if context feels full.");
    expect(prompt).toContain('## How to report progress');
    expect(prompt).toContain('gh pr create');
  });

  it('renders prompt without project context section when projectContextMd is empty', () => {
    const prompt = buildBriefingPrompt({ ...BASE_INPUT, projectContextMd: '' });

    expect(prompt).toContain('## Issue #42: Add OAuth support');
    expect(prompt).not.toContain('## Project context');
    expect(prompt).toContain('## Repository');
  });

  it('uses issue/<number> as branch when currentBranch is not provided', () => {
    const prompt = buildBriefingPrompt({ ...BASE_INPUT, currentBranch: undefined });

    expect(prompt).toContain('Branch: issue/42');
  });

  it('truncates issueBody longer than 4000 chars and adds a notice', () => {
    const longBody = 'x'.repeat(5000);
    const prompt = buildBriefingPrompt({ ...BASE_INPUT, issueBody: longBody });

    // Body section should contain exactly 4000 x's plus the truncation notice
    expect(prompt).toContain('x'.repeat(4000));
    expect(prompt).toContain('[... truncated ...]');
    // Must not contain the full 5000 chars worth
    expect(prompt).not.toContain('x'.repeat(5001));
  });

  it('truncates projectContextMd longer than 2000 chars and adds a notice', () => {
    const longContext = 'c'.repeat(3000);
    const prompt = buildBriefingPrompt({ ...BASE_INPUT, projectContextMd: longContext });

    expect(prompt).toContain('c'.repeat(2000));
    expect(prompt).toContain('[... truncated ...]');
    expect(prompt).not.toContain('c'.repeat(2001));
  });
});
