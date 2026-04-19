/**
 * vault-mirror.ts — RFC 2e / 2f
 *
 * Factories that build fire-and-forget callbacks for:
 *   - Memory mirror (RFC 2e): makeVaultMirrorCallback
 *   - Consolidation mirror (RFC 2f): makeConsolidationMirror
 *
 * Both share spawnVaultBridge() — a single helper that detaches a vault-bridge-cli
 * child process and unrefs it so it never blocks the parent.
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
 * Shared spawn helper. Fires vault-bridge-cli with the given args in a detached,
 * unref'd child process. Never throws — logs a warning on spawn failure.
 */
function spawnVaultBridge(
  cliPath: string,
  projectRoot: string,
  args: string[],
  context: string,
): void {
  if (!fs.existsSync(cliPath)) {
    logger.warn({ cliPath }, `Vault bridge enabled but CLI missing (${context}) — is the project built?`);
    return;
  }

  try {
    const child = spawn('node', [cliPath, ...args], {
      detached: true,
      stdio: 'ignore',
      cwd: projectRoot,
    });
    child.unref();
  } catch (err) {
    logger.warn({ err, context }, 'Failed to spawn vault-bridge-cli');
  }
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

    spawnVaultBridge(cliPath, projectRoot, [
      'write',
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
    ], 'memory-mirror');
  };
}

/**
 * Build a fire-and-forget callback that spawns vault-bridge-cli for each consolidation insight.
 * Fires for consolidations with importance >= 0.7.
 * Returns null when OBSIDIAN_WRITE_ENABLED is false or no vault is configured.
 */
export function makeConsolidationMirror(
  enabled: boolean,
  config: VaultMirrorConfig | null,
): ((insight: string, summary: string, importance: number, topics: string[]) => void) | null {
  if (!enabled || !config) return null;

  return (insight: string, summary: string, importance: number, topics: string[]) => {
    if (importance < 0.7) return;

    const { cliPath, projectRoot, vaultRoot } = config;

    spawnVaultBridge(cliPath, projectRoot, [
      'write',
      '--type', 'reflection',
      '--source', 'consolidation',
      '--title', insight.slice(0, 80),
      '--content', summary,
      '--importance', String(importance),
      '--topics', topics.join(','),
      '--vault-root', vaultRoot,
      '--chat-id', 'vault-bridge',
    ], 'consolidation-mirror');
  };
}
