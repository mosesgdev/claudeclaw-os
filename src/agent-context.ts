import type { AgentConfig } from './agent-config.js';

export interface AgentContext {
  agentId: string;
  name: string;
  source: 'yaml' | 'manifest';
  botToken?: string;
  cwd: string;
  model?: string;
  mcpServers?: string[];
  obsidian?: { vault: string; folders: string[]; readOnly?: string[] };
  systemPrompt?: string;
  allowedSkills?: string[];
  project?: string;
  vaultRoot?: string;
}

// Module-level default for code paths that can't thread ctx
// (schedulers, mission CLI, dashboard). Set by setDefaultAgentContext.
let _defaultCtx: AgentContext | null = null;

export function setDefaultAgentContext(ctx: AgentContext): void {
  _defaultCtx = ctx;
}

export function getDefaultAgentContext(): AgentContext {
  if (!_defaultCtx) {
    throw new Error(
      'Default AgentContext not initialized. Call setDefaultAgentContext in index.ts before any other module reads it.',
    );
  }
  return _defaultCtx;
}

/**
 * Build an AgentContext from a yaml-sourced AgentConfig.
 *
 * @param agentId      The agent's stable identifier
 * @param cfg          The loaded AgentConfig from agent.yaml
 * @param cwd          Resolved directory where the agent's CLAUDE.md lives
 * @param systemPrompt Contents of the agent's CLAUDE.md (optional)
 */
export function buildContextFromYaml(
  agentId: string,
  cfg: AgentConfig,
  cwd: string,
  systemPrompt?: string,
): AgentContext {
  return {
    agentId,
    name: cfg.name,
    source: 'yaml',
    botToken: cfg.botToken,
    cwd,
    model: cfg.model,
    mcpServers: cfg.mcpServers,
    obsidian: cfg.obsidian,
    systemPrompt,
  };
}
