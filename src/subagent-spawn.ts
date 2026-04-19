/**
 * subagent-spawn.ts — RFC 5b primitive for spawning a subagent cockpit.
 *
 * Spawns a fresh cmux workspace for a GitHub issue and links it to a
 * dedicated Discord thread. Inserts a subagent_sessions row.
 * No slash commands or routing are wired here (that is 5c).
 */

import fs from 'fs';

import type { Client, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';

import * as cmux from './cmux.js';
import { pollUntilStable } from './cmux-command.js';
import { fetchIssue } from './gh-issue.js';
import { logger } from './logger.js';
import { buildBriefingPrompt } from './subagent-briefing.js';
import { createSession, updateStatus } from './subagent-sessions.js';
import type { SubagentSession } from './subagent-sessions.js';

const log = logger.child({ name: 'subagent-spawn' });

// ── Types ────────────────────────────────────────────────────────────

export interface SpawnResult {
  session: SubagentSession;
  thread: { id: string; url: string };
}

export interface SpawnOptions {
  project: string;
  /** PM agent id; subagent id is derived as `<project>-sub-<issue>`. */
  agentId: string;
  issueNumber: number;
  client: Client;
  /** Discord channel id for the PM's primary channel. */
  pmChannelId: string;
  /** GitHub repo in `owner/repo` format (from manifest `github.repo`). */
  repo: string;
  /** Absolute path to the project's working directory. */
  workingDir: string;
  /**
   * Absolute path to the project's context.md inside the vault.
   * When present, its contents are included in the briefing prompt.
   * When null or on read error, an empty context section is used.
   */
  vaultProjectContextPath: string | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

function buildThreadName(labels: string[], title: string, issueNumber: number): string {
  const prefix = labels.length > 0 ? `${labels[0]} ` : '';
  const maxTitle = 95 - prefix.length - ` #${issueNumber}`.length;
  const shortTitle = title.length > maxTitle ? title.slice(0, maxTitle) : title;
  return `${prefix}${shortTitle} #${issueNumber}`;
}

function readContextFile(contextPath: string | null): string {
  if (!contextPath) return '';
  try {
    return fs.readFileSync(contextPath, 'utf8');
  } catch {
    log.warn({ contextPath }, 'subagent-spawn: could not read project context file');
    return '';
  }
}

function generateSessionId(project: string, issueNumber: number): string {
  return `${project}-sub-${issueNumber}-${Date.now()}`;
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Spawn a subagent for a GitHub issue:
 *   1. Fetch the issue via gh.
 *   2. Create a Discord thread under the PM's primary channel.
 *   3. Create a cmux workspace (command: claude, cwd: workingDir).
 *   4. Send the briefing prompt to the workspace.
 *   5. Insert a subagent_sessions row.
 *   6. Return the session + thread info.
 */
export async function spawnSubagent(opts: SpawnOptions): Promise<SpawnResult> {
  const {
    project,
    agentId,
    issueNumber,
    client,
    pmChannelId,
    repo,
    workingDir,
    vaultProjectContextPath,
  } = opts;

  // 1. Fetch the issue (fail fast — no side effects yet)
  let issue;
  try {
    issue = await fetchIssue(repo, issueNumber);
  } catch (err) {
    throw new Error(
      `subagent-spawn: failed to fetch issue #${issueNumber} from ${repo}: ${String(err)}`,
    );
  }

  // 2. Resolve the PM channel and create a Discord thread
  let channel: TextChannel;
  try {
    const resolved = await client.channels.fetch(pmChannelId);
    if (!resolved || !('threads' in resolved)) {
      throw new Error(`channel ${pmChannelId} is not a text channel or is unavailable`);
    }
    channel = resolved as TextChannel;
  } catch (err) {
    throw new Error(`subagent-spawn: cannot resolve PM channel ${pmChannelId}: ${String(err)}`);
  }

  const threadName = buildThreadName(issue.labels, issue.title, issueNumber);

  let thread;
  try {
    thread = await channel.threads.create({
      name: threadName,
      autoArchiveDuration: 1440,
      type: ChannelType.PublicThread,
    });
  } catch (err) {
    throw new Error(
      `subagent-spawn: failed to create Discord thread for issue #${issueNumber}: ${String(err)}`,
    );
  }

  // 3. Create a cmux workspace
  const subagentId = `${project}-sub-${issueNumber}`;
  const workspaceTitle = `claudeclaw-sub-${project}-${issueNumber}`;

  let workspaceId: string;
  try {
    workspaceId = await cmux.newWorkspace({
      name: workspaceTitle,
      cwd: workingDir,
      command: 'claude',
    });
  } catch (err) {
    // Clean up the thread we just created
    try {
      await thread.setArchived(true);
    } catch (archiveErr) {
      log.warn({ archiveErr }, 'subagent-spawn: could not archive thread after workspace failure');
    }
    throw new Error(
      `subagent-spawn: failed to create cmux workspace for issue #${issueNumber}: ${String(err)}`,
    );
  }

  // 4. Build and send the briefing prompt
  const projectContextMd = readContextFile(vaultProjectContextPath);

  const briefing = buildBriefingPrompt({
    project,
    issueNumber,
    issueTitle: issue.title,
    issueBody: issue.body,
    issueUrl: issue.url,
    projectContextMd,
    workingDir,
  });

  const sessionId = generateSessionId(project, issueNumber);

  try {
    await cmux.send(workspaceId, briefing);
    await cmux.sendKey(workspaceId, 'enter');
    // Wait for the initial stabilisation (30s cap)
    await pollUntilStable(workspaceId, 30_000);
  } catch (err) {
    // Insert the row as failed — thread exists, workspace may be partial
    const startedAt = Math.floor(Date.now() / 1000);
    createSession({
      id: sessionId,
      project,
      agentId: subagentId,
      issueNumber,
      issueTitle: issue.title,
      issueUrl: issue.url,
      threadId: thread.id,
      workspaceId,
      status: 'failed',
      startedAt,
    });
    updateStatus(sessionId, 'failed', startedAt);
    throw new Error(
      `subagent-spawn: failed to send briefing to workspace ${workspaceId}: ${String(err)}`,
    );
  }

  // 5. Insert the session row
  const startedAt = Math.floor(Date.now() / 1000);
  const session: SubagentSession = {
    id: sessionId,
    project,
    agentId: subagentId,
    issueNumber,
    issueTitle: issue.title,
    issueUrl: issue.url,
    threadId: thread.id,
    workspaceId,
    status: 'running',
    startedAt,
    endedAt: null,
  };

  createSession({
    id: session.id,
    project: session.project,
    agentId: session.agentId,
    issueNumber: session.issueNumber,
    issueTitle: session.issueTitle,
    issueUrl: session.issueUrl,
    threadId: session.threadId,
    workspaceId: session.workspaceId,
    status: session.status,
    startedAt: session.startedAt,
  });

  log.info(
    {
      project,
      issueNumber,
      threadId: thread.id,
      workspaceId,
      sessionId,
    },
    `subagent-spawn: spawned for #${issueNumber} "${issue.title}"`,
  );

  const guildId = thread.guildId ?? '';
  const threadUrl = `https://discord.com/channels/${guildId}/${thread.id}`;

  return {
    session,
    thread: { id: thread.id, url: threadUrl },
  };
}
