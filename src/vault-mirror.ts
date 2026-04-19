/**
 * vault-mirror.ts — RFC 2e
 *
 * Factory that builds the memory-mirror callback registered via setMirrorCallback().
 * Extracted from bot.ts so it can be unit-tested without starting the full bot.
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

import { logger } from './logger.js';

export interface VaultMirrorConfig {
  /** Absolute path to the compiled vault-bridge-cli.js */
  cliPath: string;
  /** Project root (cwd for the spawned process) */
  projectRoot: string;
  /** Agent ID to pass to the CLI */
  agentId: string;
  /** Obsidian vault root path */
  vaultRoot: string;
}

/**
 * Build a fire-and-forget callback that spawns vault-bridge-cli for each mirrored memory.
 * Returns null when OBSIDIAN_WRITE_ENABLED is false so the caller can skip registration.
 */
export function makeVaultMirrorCallback(
  enabled: boolean,
  config: VaultMirrorConfig | null,
): ((memoryId: number, summary: string, importance: number, topics: string[]) => void) | null {
  if (!enabled) return null;

  return (memoryId: number, summary: string, importance: number, topics: string[]) => {
    if (!config) {
      logger.debug('OBSIDIAN_WRITE_ENABLED but no vault configured; skipping mirror');
      return;
    }

    const { cliPath, projectRoot, agentId, vaultRoot } = config;

    if (!fs.existsSync(cliPath)) {
      logger.warn({ cliPath }, 'Vault mirror enabled but bridge CLI is missing — is the project built?');
      return;
    }

    const args = [
      cliPath, 'write',
      '--type', 'learning',
      '--title', summary.slice(0, 80),
      '--content', summary,
      '--importance', String(importance),
      '--topics', topics.join(','),
      '--source', 'memory-mirror',
      '--agent-id', agentId,
      '--memory-id', String(memoryId),
      '--vault-root', vaultRoot,
      '--chat-id', 'vault-bridge',
    ];

    try {
      const child = spawn('node', args, {
        detached: true,
        stdio: 'ignore',
        cwd: projectRoot,
      });
      child.unref();
    } catch (err) {
      logger.warn({ err }, 'Failed to spawn vault-bridge-cli for memory mirror');
    }
  };
}
