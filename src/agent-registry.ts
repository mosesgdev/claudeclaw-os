/**
 * Unified agent registry — merges yaml-sourced and manifest-sourced agents
 * into a single flat list of RegistryEntry objects.
 *
 * File-watcher (chokidar) integration is deferred to a later phase.
 * When implemented, call rebuildRegistry() on vault change events and emit
 * an 'agents:changed' event so discord-bootstrap can re-resolve channels.
 */

import fs from 'fs';
import path from 'path';

import {
  listAgentIds,
  loadAgentConfig,
  resolveAgentDir,
  resolveAgentClaudeMd,
} from './agent-config.js';
import {
  buildContextFromYaml,
  buildContextFromManifest,
  type AgentContext,
} from './agent-context.js';
import { PROJECT_AGENTS_ENABLED, PROJECT_ROOT, VAULT_PROJECTS_ROOT } from './config.js';
import { logger } from './logger.js';
import { scanProjectManifests, type ProjectManifest } from './project-manifests.js';

const log = logger.child({ name: 'agent-registry' });

// ── Types ────────────────────────────────────────────────────────────

export interface RegistryEntry {
  /** Stable agentId — yaml `id` or manifest `memory_namespace` */
  id: string;
  name: string;
  description: string;
  source: 'yaml' | 'manifest';
  context: AgentContext;
  /** Present only for manifest-sourced entries */
  manifest?: ProjectManifest;
}

// ── Module-level state ───────────────────────────────────────────────

let _registry: RegistryEntry[] = [];
let _initialized = false;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Compute the vault root path as the parent directory of VAULT_PROJECTS_ROOT.
 * VAULT_PROJECTS_ROOT points to e.g. ~/Documents/Obsidian/ClaudeClaw/04-projects,
 * so the vault root is ~/Documents/Obsidian/ClaudeClaw.
 */
function resolveVaultRootPath(): string {
  return path.dirname(VAULT_PROJECTS_ROOT);
}

function buildRegistryFromScratch(includeProjectAgents: boolean): RegistryEntry[] {
  const entries = new Map<string, RegistryEntry>();

  // ── 1. Load yaml agents ──────────────────────────────────────────
  const ids = listAgentIds();
  for (const id of ids) {
    try {
      const cfg = loadAgentConfig(id);
      const cwd = resolveAgentDir(id);
      const claudeMdPath = resolveAgentClaudeMd(id);
      let systemPrompt: string | undefined;
      if (claudeMdPath) {
        try {
          systemPrompt = fs.readFileSync(claudeMdPath, 'utf-8');
        } catch {
          // No CLAUDE.md — fine, systemPrompt stays undefined
        }
      }
      const ctx = buildContextFromYaml(id, cfg, cwd, systemPrompt);
      entries.set(id, {
        id,
        name: cfg.name,
        description: cfg.description,
        source: 'yaml',
        context: ctx,
      });
    } catch (err) {
      log.warn({ agentId: id, err }, 'agent-registry: skipping yaml agent — config load failed');
    }
  }

  // ── 2. Load manifest agents (belt-and-braces: only active ones) ──
  if (includeProjectAgents) {
    const vaultRootPath = resolveVaultRootPath();
    const manifests = scanProjectManifests();

    for (const m of manifests) {
      // scanProjectManifests already filters archived, but double-check.
      if (m.status !== 'active') {
        log.debug({ project: m.project }, 'agent-registry: skipping non-active manifest');
        continue;
      }

      const id = m.memoryNamespace;
      const ctx = buildContextFromManifest(m, vaultRootPath, PROJECT_ROOT);
      const entry: RegistryEntry = {
        id,
        name: m.project,
        description: `Project agent for ${m.project}`,
        source: 'manifest',
        context: ctx,
        manifest: m,
      };

      if (entries.has(id)) {
        log.warn(
          { agentId: id, existing: entries.get(id)!.source },
          'agent-registry: manifest agent wins over yaml agent on id conflict',
        );
      }
      entries.set(id, entry);
    }
  }

  return [...entries.values()];
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Initialise the registry. Safe to call multiple times — subsequent calls
 * are no-ops unless force is set (use rebuildRegistry() for explicit refresh).
 *
 * @param opts.includeProjectAgents Include manifest-sourced agents.
 *                                  Defaults to PROJECT_AGENTS_ENABLED from config.
 */
export function initAgentRegistry(opts?: { includeProjectAgents?: boolean }): void {
  if (_initialized) return;
  const include = opts?.includeProjectAgents ?? PROJECT_AGENTS_ENABLED;
  _registry = buildRegistryFromScratch(include);
  _initialized = true;
  log.info(
    { total: _registry.length, yaml: _registry.filter((e) => e.source === 'yaml').length, manifest: _registry.filter((e) => e.source === 'manifest').length },
    'Agent registry initialised',
  );
}

/** Return all registry entries. */
export function getRegistryEntries(): RegistryEntry[] {
  return [..._registry];
}

/** Look up an AgentContext by agentId. Returns null for unknown ids. */
export function getRegistryContext(agentId: string): AgentContext | null {
  return _registry.find((e) => e.id === agentId)?.context ?? null;
}

/** Look up a full RegistryEntry by agentId. Returns null for unknown ids. */
export function getRegistryEntry(agentId: string): RegistryEntry | null {
  return _registry.find((e) => e.id === agentId) ?? null;
}

/**
 * Re-scan all sources and replace the registry in-place.
 * Useful after a /reload-agents slash command or vault file change.
 *
 * Note: chokidar file-watcher integration (auto-rescan on vault change +
 * 'agents:changed' event emission) is deferred to a later phase.
 */
export function rebuildRegistry(opts?: { includeProjectAgents?: boolean }): void {
  const include = opts?.includeProjectAgents ?? PROJECT_AGENTS_ENABLED;
  _registry = buildRegistryFromScratch(include);
  // Allow re-init after rebuild
  _initialized = true;
  log.info(
    { total: _registry.length },
    'Agent registry rebuilt',
  );
}

/** Reset state — for testing only. */
export function _resetRegistryForTest(): void {
  _registry = [];
  _initialized = false;
}
