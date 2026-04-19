import { logger } from './logger.js';

const log = logger.child({ name: 'subagent-briefing' });

// ── Types ────────────────────────────────────────────────────────────

export interface BriefingInput {
  project: string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  /** Raw content of the project context.md; truncated to 2k chars. */
  projectContextMd: string;
  workingDir: string;
  currentBranch?: string;
}

const MAX_ISSUE_BODY = 4000;
const MAX_PROJECT_CONTEXT = 2000;
const WARN_PROMPT_LENGTH = 10000;

// ── Public API ───────────────────────────────────────────────────────

/**
 * Build the one-shot briefing prompt that is sent to a fresh subagent workspace.
 * Caps issueBody to 4000 chars and projectContextMd to 2000 chars.
 * Logs a warning if the final prompt exceeds 10000 chars.
 */
export function buildBriefingPrompt(input: BriefingInput): string {
  const body =
    input.issueBody.length > MAX_ISSUE_BODY
      ? input.issueBody.slice(0, MAX_ISSUE_BODY) + '\n\n[... truncated ...]'
      : input.issueBody;

  const context =
    input.projectContextMd.length > MAX_PROJECT_CONTEXT
      ? input.projectContextMd.slice(0, MAX_PROJECT_CONTEXT) + '\n\n[... truncated ...]'
      : input.projectContextMd;

  const branch = input.currentBranch ?? `issue/${input.issueNumber}`;

  const sections: string[] = [
    `You are working on a specific GitHub issue for the ${input.project} project.`,
    '',
    `## Issue #${input.issueNumber}: ${input.issueTitle}`,
    body,
  ];

  if (context.trim()) {
    sections.push('');
    sections.push('## Project context');
    sections.push(context);
  }

  sections.push('');
  sections.push('## Repository');
  sections.push(`Working directory: ${input.workingDir}`);
  sections.push(`Branch: ${branch}`);
  sections.push('');
  sections.push('## Constraints');
  sections.push('- Match existing conventions. Don\'t add new dependencies without checking.');
  sections.push('- Use `/compact` if context feels full.');
  sections.push('- When done, write a PR description draft and pause.');
  sections.push('');
  sections.push('## How to report progress');
  sections.push(
    'Short status updates back in this thread. When you have a question or hit\n' +
    'a decision point, ask. When the work is done, open a PR via `gh pr create`\n' +
    'and post the URL here.',
  );

  const prompt = sections.join('\n');

  if (prompt.length > WARN_PROMPT_LENGTH) {
    log.warn(
      { length: prompt.length, issueNumber: input.issueNumber },
      'subagent-briefing: prompt exceeds 10000 chars',
    );
  }

  return prompt;
}
