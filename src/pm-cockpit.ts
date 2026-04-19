/**
 * pm-cockpit.ts — persistent cmux workspace management for project PM agents.
 *
 * Each active project manifest gets one dedicated cmux workspace started at
 * bootstrap. Messages arriving in the project's channel are dispatched here
 * (via dispatchToPmCockpit) instead of through runAgent, when both
 * PROJECT_AGENTS_ENABLED and CMUX_ENABLED are true.
 *
 * Workspace naming uses `claudeclaw-pm-<agentId>` (not the ad-hoc per-chat
 * pattern used by /cmux, which is `claudeclaw-<agent>-<chat>`).
 */

import * as cmux from './cmux.js';
import { pollUntilStable } from './cmux-command.js';
import { logger } from './logger.js';
import type { MessageChannel } from './channels/types.js';

const log = logger.child({ name: 'pm-cockpit' });

// ── Types ─────────────────────────────────────────────────────────────

export interface PmCockpit {
  agentId: string;
  workspaceId: string;
  workingDir: string;
}

// ── In-memory registry ────────────────────────────────────────────────

const _cockpits = new Map<string, PmCockpit>();

export function getPmCockpit(agentId: string): PmCockpit | null {
  return _cockpits.get(agentId) ?? null;
}

export function setPmCockpit(c: PmCockpit): void {
  _cockpits.set(c.agentId, c);
}

export function clearPmCockpits(): void {
  _cockpits.clear();
}

/** Reset all state — for tests only. */
export function _resetForTest(): void {
  _cockpits.clear();
}

// ── Workspace title ───────────────────────────────────────────────────

/**
 * Return the stable cmux workspace title for a PM agent.
 * Distinct from workspaceTitleFor() (which is `claudeclaw-<agent>-<chat>`).
 */
export function pmWorkspaceTitleFor(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  return `claudeclaw-pm-${safe}`;
}

// ── Bootstrap ─────────────────────────────────────────────────────────

/**
 * Ensure a cmux workspace exists for the given project agent.
 * Returns the cockpit on success, or null if cmux isn't reachable / anything
 * fails. Safe to call repeatedly — uses ensureWorkspace under the hood.
 *
 * @param agentId   The manifest's memory_namespace / agentId.
 * @param workingDir Absolute path (already expandHome'd by caller).
 */
export async function ensurePmCockpit(
  agentId: string,
  workingDir: string,
): Promise<PmCockpit | null> {
  try {
    const alive = await cmux.ping();
    if (!alive) {
      log.debug({ agentId }, 'pm-cockpit: cmux not reachable, skipping');
      return null;
    }

    const title = pmWorkspaceTitleFor(agentId);
    const workspaceId = await cmux.ensureWorkspace(title, {
      cwd: workingDir,
      command: 'claude',
    });

    const cockpit: PmCockpit = { agentId, workspaceId, workingDir };
    setPmCockpit(cockpit);
    return cockpit;
  } catch (err) {
    log.warn({ agentId, err }, 'pm-cockpit: ensurePmCockpit failed');
    return null;
  }
}

// ── Dispatch ──────────────────────────────────────────────────────────

/**
 * Send a prompt to the PM's cockpit and return the stabilised screen.
 * Returns null if no cockpit exists for this agent or if dispatch fails.
 */
export async function dispatchToPmCockpit(
  agentId: string,
  prompt: string,
  opts: { stabilityTimeoutMs?: number; replyCap?: number } = {},
): Promise<string | null> {
  const cockpit = getPmCockpit(agentId);
  if (!cockpit) return null;

  const stabilityMs = opts.stabilityTimeoutMs ?? 45_000;
  const replyCap = opts.replyCap ?? 3500;

  try {
    await cmux.send(cockpit.workspaceId, prompt);
    await cmux.sendKey(cockpit.workspaceId, 'enter');
    const screen = await pollUntilStable(cockpit.workspaceId, stabilityMs);
    return screen.slice(-replyCap);
  } catch (err) {
    log.warn({ agentId, workspaceId: cockpit.workspaceId, err }, 'pm-cockpit: dispatchToPmCockpit failed');
    return null;
  }
}

// ── Routing helper ────────────────────────────────────────────────────

/**
 * Try to route the message to the PM's cockpit.
 * Returns the cockpit screen string when successfully dispatched,
 * or null when the agent has no cockpit (caller falls back to runAgent).
 *
 * Extracted as a standalone export so it can be unit-tested without
 * constructing a real MessageChannel.
 */
export async function maybeRouteToPmCockpit(
  agentId: string,
  userMessage: string,
  opts?: { stabilityTimeoutMs?: number; replyCap?: number },
): Promise<string | null> {
  return dispatchToPmCockpit(agentId, userMessage, opts);
}

// ── Reply formatting ──────────────────────────────────────────────────

/**
 * Format the raw cockpit screen for delivery over a given channel.
 * Telegram: HTML <pre> block (capped at 3500 chars).
 * Discord (or unknown): triple-backtick block (capped at 1900 chars).
 */
export function formatCockpitReply(channel: MessageChannel, screen: string): string {
  // Detect transport by checking for a transport property or escapeHtml availability.
  // MessageChannel implementations expose channel.transport as a discriminator.
  const transport: string = (channel as unknown as { transport?: string }).transport ?? 'unknown';

  if (transport === 'telegram') {
    const capped = screen.slice(-3500);
    const escaped = capped
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<pre>${escaped}</pre>`;
  }

  // Discord and everything else
  const capped = screen.slice(-1900);
  return '```\n' + capped + '\n```';
}
