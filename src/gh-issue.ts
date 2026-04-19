import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// ── Types ────────────────────────────────────────────────────────────

export interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  state: 'open' | 'closed';
  labels: string[];
  author: string;
}

// ── Internal helpers ─────────────────────────────────────────────────

interface GhLabelObject {
  name: string;
}

interface GhIssueRaw {
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  labels: GhLabelObject[] | string[];
  author: { login: string } | string;
}

function parseGhIssue(raw: GhIssueRaw): GhIssue {
  const labels = Array.isArray(raw.labels)
    ? raw.labels.map((l) => (typeof l === 'string' ? l : l.name))
    : [];

  const author =
    typeof raw.author === 'string'
      ? raw.author
      : (raw.author as { login: string })?.login ?? '';

  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? '',
    url: raw.url,
    state: raw.state === 'CLOSED' || raw.state === 'closed' ? 'closed' : 'open',
    labels,
    author,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Fetch a single GitHub issue by number using the `gh` CLI.
 * Throws if `gh` is not installed or returns a non-zero exit code.
 */
export async function fetchIssue(repo: string, number: number): Promise<GhIssue> {
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'number,title,body,url,state,labels,author',
  ]);
  const raw = JSON.parse(stdout) as GhIssueRaw;
  return parseGhIssue(raw);
}

/**
 * List open issues for a repository using the `gh` CLI.
 * @param limit  Maximum number of issues to return (default: 30).
 * Throws if `gh` is not installed or returns a non-zero exit code.
 */
export async function listOpenIssues(repo: string, limit = 30): Promise<GhIssue[]> {
  const { stdout } = await execFileAsync('gh', [
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'open',
    '--limit',
    String(limit),
    '--json',
    'number,title,body,url,state,labels,author',
  ]);
  const raws = JSON.parse(stdout) as GhIssueRaw[];
  return raws.map(parseGhIssue);
}
