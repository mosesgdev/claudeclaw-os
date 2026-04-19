/**
 * cmux-command.ts — channel-agnostic handler for /cmux.
 *
 * Streamlined from the Telegram PoC in bot.ts. Used by both the Telegram
 * bot.command('cmux', ...) handler and the Discord /cmux slash handler.
 *
 * Responsibilities:
 *   - Resolve a per-chat workspace title (stable across calls)
 *   - Dispatch the subcommand (status | new | read | <prompt>)
 *   - Replace the fixed sleep with a screen-stability poller that returns
 *     once two consecutive screen reads are byte-identical (or after a hard cap)
 *
 * Feature-gated by CMUX_ENABLED in config.ts.
 */

import { CMUX_ENABLED, PROJECT_ROOT } from './config.js';
import * as cmux from './cmux.js';
import { logger } from './logger.js';

export interface CmuxCommandOpts {
  /** Stable identifier for the chat. Combined with agentId to form the workspace title. */
  chatId: string;
  /** Agent id so per-project PMs each own their workspace. */
  agentId: string;
  /** The user's text after the command name (may be empty). */
  text: string;
  /**
   * Max time (ms) to wait for the screen to stabilise after sending a prompt.
   * Default 45s. The poller returns as soon as two consecutive reads match.
   */
  stabilityTimeoutMs?: number;
  /** Max characters of screen output to include in the reply. Default 3500. */
  replyCap?: number;
}

export interface CmuxCommandResult {
  /** Plain-text reply to the user. If null, nothing to send. */
  reply: string | null;
  /**
   * Raw screen content for callers that want to format it themselves (e.g.
   * Telegram's HTML <pre> wrapper). Empty for status/new subcommands.
   */
  screen?: string;
  /** True if the command produced screen output the caller should format. */
  hasScreen?: boolean;
}

/**
 * Build the workspace title for a given chat + agent.
 * Keeping this deterministic lets the poller find the right workspace
 * across restarts, and lets multiple agents coexist for the same chat.
 */
export function workspaceTitleFor(chatId: string, agentId: string): string {
  // Slug unsafe chars — cmux tolerates most strings but we want legible titles.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  return `claudeclaw-${safe(agentId)}-${safe(chatId)}`;
}

export async function runCmuxCommand(opts: CmuxCommandOpts): Promise<CmuxCommandResult> {
  if (!CMUX_ENABLED) {
    return { reply: 'cmux integration is disabled. Set CMUX_ENABLED=true in .env to enable.' };
  }

  const text = opts.text.trim();
  const title = workspaceTitleFor(opts.chatId, opts.agentId);
  const replyCap = opts.replyCap ?? 3500;
  const stabilityMs = opts.stabilityTimeoutMs ?? 45_000;

  try {
    if (!(await cmux.ping())) {
      return { reply: 'cmux socket not reachable. Is cmux.app running?' };
    }

    // Subcommand: status (default when no text).
    if (text === '' || text === 'status') {
      const workspaces = await cmux.listWorkspaces();
      const mine = workspaces.find((w) => w.title === title);
      const lines = [
        `cmux online · ${workspaces.length} workspace(s)`,
        mine
          ? `This chat: ${mine.id} (${mine.title})`
          : `This chat: no workspace yet. Send "/cmux new" or "/cmux <prompt>" to create.`,
      ];
      return { reply: lines.join('\n') };
    }

    // Subcommand: new (force-create).
    if (text === 'new') {
      const id = await cmux.newWorkspace({ name: title, cwd: PROJECT_ROOT, command: 'claude' });
      return { reply: `Created ${id} (${title}). Sending prompts to this workspace now.` };
    }

    // Ensure workspace exists for the remaining subcommands.
    const id = await cmux.ensureWorkspace(title, { cwd: PROJECT_ROOT, command: 'claude' });

    // Subcommand: read (just dump the current screen).
    if (text === 'read') {
      const screen = await cmux.readScreen(id, { lines: 60 });
      return {
        reply: null,
        screen: screen.slice(-replyCap),
        hasScreen: true,
      };
    }

    // Default: treat text as a prompt to send.
    await cmux.send(id, text);
    await cmux.sendKey(id, 'enter');
    const screen = await pollUntilStable(id, stabilityMs);
    return {
      reply: null,
      screen: screen.slice(-replyCap),
      hasScreen: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err, chatId: opts.chatId, agentId: opts.agentId, name: 'cmux-command' }, 'cmux command failed');
    return { reply: `cmux error: ${msg}` };
  }
}

/**
 * Poll read-screen until two consecutive reads are identical (the UI has
 * finished updating) or the hard cap is reached. Minimum 1s between reads.
 * Assumes the first read happens at t=2s to give the TUI time to render.
 */
export async function pollUntilStable(
  workspaceId: string,
  maxMs: number,
  options: {
    readLines?: number;
    minIntervalMs?: number;
    firstReadDelayMs?: number;
    readFn?: typeof cmux.readScreen;
  } = {},
): Promise<string> {
  const readLines = options.readLines ?? 60;
  const interval = options.minIntervalMs ?? 1500;
  const firstDelay = options.firstReadDelayMs ?? 2000;
  const read = options.readFn ?? cmux.readScreen;

  await sleep(firstDelay);
  let prev = await read(workspaceId, { lines: readLines });

  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(interval);
    const next = await read(workspaceId, { lines: readLines });
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
