import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  setDefaultAgentContext,
  getDefaultAgentContext,
  buildContextFromYaml,
  type AgentContext,
} from './agent-context.js';
import type { AgentConfig } from './agent-config.js';

// Helper to reset the module-level singleton between tests.
// We do this by calling setDefaultAgentContext(null as any) — the module
// doesn't expose a reset function, so we reinitialise before each test.
function resetDefaultCtx(): void {
  // Set to a known value first so the next getDefaultAgentContext call
  // reflects the reset. We abuse the setter to inject null.
  (setDefaultAgentContext as unknown as (ctx: AgentContext | null) => void)(null);
}

describe('getDefaultAgentContext', () => {
  beforeEach(() => {
    resetDefaultCtx();
  });

  afterEach(() => {
    resetDefaultCtx();
  });

  it('throws when default context has not been initialised', () => {
    expect(() => getDefaultAgentContext()).toThrow(
      'Default AgentContext not initialized',
    );
  });

  it('returns the context after setDefaultAgentContext is called', () => {
    const ctx: AgentContext = {
      agentId: 'main',
      name: 'Main',
      source: 'yaml',
      cwd: '/tmp/claudeclaw',
    };
    setDefaultAgentContext(ctx);
    expect(getDefaultAgentContext()).toBe(ctx);
  });

  it('replaces the previous default when called again', () => {
    const ctx1: AgentContext = { agentId: 'a', name: 'A', source: 'yaml', cwd: '/a' };
    const ctx2: AgentContext = { agentId: 'b', name: 'B', source: 'yaml', cwd: '/b' };
    setDefaultAgentContext(ctx1);
    setDefaultAgentContext(ctx2);
    expect(getDefaultAgentContext().agentId).toBe('b');
  });
});

describe('buildContextFromYaml', () => {
  const baseCfg: AgentConfig = {
    name: 'Research',
    description: 'Research agent',
    model: 'claude-sonnet-4-5',
    mcpServers: ['brave-search'],
    obsidian: { vault: '/vault', folders: ['01-inbox'], readOnly: [] },
    botToken: 'tg:token',
  };

  it('maps all fields from config correctly', () => {
    const ctx = buildContextFromYaml('research', baseCfg, '/agents/research', 'System prompt');
    expect(ctx.agentId).toBe('research');
    expect(ctx.name).toBe('Research');
    expect(ctx.source).toBe('yaml');
    expect(ctx.cwd).toBe('/agents/research');
    expect(ctx.model).toBe('claude-sonnet-4-5');
    expect(ctx.mcpServers).toEqual(['brave-search']);
    expect(ctx.obsidian).toEqual({ vault: '/vault', folders: ['01-inbox'], readOnly: [] });
    expect(ctx.systemPrompt).toBe('System prompt');
    expect(ctx.botToken).toBe('tg:token');
  });

  it('omits systemPrompt when not provided', () => {
    const ctx = buildContextFromYaml('research', baseCfg, '/agents/research');
    expect(ctx.systemPrompt).toBeUndefined();
  });

  it('works with a minimal config (only name required)', () => {
    const minimal: AgentConfig = { name: 'Minimal', description: '' };
    const ctx = buildContextFromYaml('minimal', minimal, '/agents/minimal');
    expect(ctx.agentId).toBe('minimal');
    expect(ctx.name).toBe('Minimal');
    expect(ctx.model).toBeUndefined();
    expect(ctx.mcpServers).toBeUndefined();
    expect(ctx.obsidian).toBeUndefined();
    expect(ctx.botToken).toBeUndefined();
  });

  it('does not set project or vaultRoot (yaml source)', () => {
    const ctx = buildContextFromYaml('x', baseCfg, '/tmp');
    expect(ctx.project).toBeUndefined();
    expect(ctx.vaultRoot).toBeUndefined();
  });
});
