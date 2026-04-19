import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const CMUX_BIN = '/Applications/cmux.app/Contents/Resources/bin/cmux';
const CMUX_TIMEOUT_MS = 10_000;

export interface CmuxWorkspace {
  id: string;
  title: string;
  selected: boolean;
}

async function cmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(CMUX_BIN, args, { timeout: CMUX_TIMEOUT_MS });
  return stdout;
}

export async function ping(): Promise<boolean> {
  try {
    const out = await cmux(['ping']);
    return out.trim() === 'PONG';
  } catch {
    return false;
  }
}

export async function listWorkspaces(): Promise<CmuxWorkspace[]> {
  const out = await cmux(['list-workspaces']);
  const workspaces: CmuxWorkspace[] = [];
  for (const rawLine of out.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const selected = line.startsWith('*');
    const body = selected ? line.slice(1).trimStart() : line.trimStart();
    const match = body.match(/^(workspace:\d+)\s+(.*?)(?:\s+\[selected\])?$/);
    if (!match) continue;
    workspaces.push({ id: match[1], title: match[2].trim(), selected });
  }
  return workspaces;
}

export async function findWorkspaceByTitle(title: string): Promise<CmuxWorkspace | null> {
  const workspaces = await listWorkspaces();
  return workspaces.find((w) => w.title === title) ?? null;
}

export interface NewWorkspaceOptions {
  name: string;
  cwd?: string;
  command?: string;
}

export async function newWorkspace(opts: NewWorkspaceOptions): Promise<string> {
  const args = ['new-workspace', '--name', opts.name];
  if (opts.cwd) args.push('--cwd', opts.cwd);
  if (opts.command) args.push('--command', opts.command);
  const out = await cmux(args);
  const match = out.match(/workspace:\d+/);
  if (!match) throw new Error(`cmux new-workspace returned no id: ${out}`);
  return match[0];
}

export async function send(workspaceId: string, text: string): Promise<void> {
  await cmux(['send', '--workspace', workspaceId, text]);
}

export async function sendKey(workspaceId: string, key: string): Promise<void> {
  await cmux(['send-key', '--workspace', workspaceId, key]);
}

export async function readScreen(
  workspaceId: string,
  opts: { lines?: number; scrollback?: boolean } = {},
): Promise<string> {
  const args = ['read-screen', '--workspace', workspaceId];
  if (opts.scrollback) args.push('--scrollback');
  if (opts.lines) args.push('--lines', String(opts.lines));
  return cmux(args);
}

export async function ensureWorkspace(
  title: string,
  opts: { cwd?: string; command?: string } = {},
): Promise<string> {
  const existing = await findWorkspaceByTitle(title);
  if (existing) return existing.id;
  return newWorkspace({ name: title, ...opts });
}

export async function sendPrompt(
  workspaceId: string,
  prompt: string,
  opts: { waitMs?: number; readLines?: number } = {},
): Promise<string> {
  const waitMs = opts.waitMs ?? 3000;
  const readLines = opts.readLines ?? 60;
  await send(workspaceId, prompt);
  await sendKey(workspaceId, 'enter');
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return readScreen(workspaceId, { lines: readLines });
}
