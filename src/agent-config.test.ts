import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

import { loadAgentConfig } from './agent-config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Write test agent.yaml files into PROJECT_ROOT/agents/__test__<id>/ so
// resolveAgentDir falls back to them without any mocking.  The __test__ prefix
// ensures listAgentIds() never accidentally picks these up at runtime because
// real agent IDs never start with underscores (skipped by the scanner).

const PROJECT_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const AGENTS_DIR = path.join(PROJECT_ROOT, 'agents');

const TEST_PREFIX = '__test__agent-config-';

function agentDir(id: string): string {
  return path.join(AGENTS_DIR, TEST_PREFIX + id);
}

function writeAgentYaml(id: string, data: Record<string, unknown>): void {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.yaml'), yaml.dump(data), 'utf-8');
}

function agentId(id: string): string {
  return TEST_PREFIX + id;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  delete process.env['TEST_BOT_TOKEN'];
});

afterEach(() => {
  // Clean up any test agent directories
  if (fs.existsSync(AGENTS_DIR)) {
    for (const entry of fs.readdirSync(AGENTS_DIR)) {
      if (entry.startsWith(TEST_PREFIX)) {
        fs.rmSync(path.join(AGENTS_DIR, entry), { recursive: true, force: true });
      }
    }
  }
  delete process.env['TEST_BOT_TOKEN'];
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('loadAgentConfig', () => {
  it('loads successfully when telegram_bot_token_env is present and token is in env', () => {
    process.env['TEST_BOT_TOKEN'] = '123456:ABC-token';
    writeAgentYaml('with-token', {
      name: 'My Agent',
      description: 'A test agent',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
      model: 'claude-sonnet-4-6',
    });

    const config = loadAgentConfig(agentId('with-token'));

    expect(config.name).toBe('My Agent');
    expect(config.botTokenEnv).toBe('TEST_BOT_TOKEN');
    expect(config.botToken).toBe('123456:ABC-token');
    expect(config.model).toBe('claude-sonnet-4-6');
  });

  it('loads successfully WITHOUT telegram_bot_token_env — botToken and botTokenEnv are undefined', () => {
    writeAgentYaml('discord-only', {
      name: 'Discord Agent',
      description: 'A Discord-only agent with no Telegram token',
    });

    const config = loadAgentConfig(agentId('discord-only'));

    expect(config.name).toBe('Discord Agent');
    expect(config.botTokenEnv).toBeUndefined();
    expect(config.botToken).toBeUndefined();
  });

  it('throws when telegram_bot_token_env is set but the env var is missing', () => {
    delete process.env['TEST_BOT_TOKEN'];
    writeAgentYaml('missing-token', {
      name: 'Missing Token Agent',
      telegram_bot_token_env: 'TEST_BOT_TOKEN',
    });

    expect(() => loadAgentConfig(agentId('missing-token'))).toThrow(
      /Bot token not found: set TEST_BOT_TOKEN/,
    );
  });

  it('throws when name is missing', () => {
    writeAgentYaml('no-name', {
      description: 'Agent without a name',
    });

    expect(() => loadAgentConfig(agentId('no-name'))).toThrow(/must have 'name'/);
  });

  it('throws when agent.yaml does not exist', () => {
    // Create directory but no yaml
    fs.mkdirSync(agentDir('phantom'), { recursive: true });

    expect(() => loadAgentConfig(agentId('phantom'))).toThrow(/Agent config not found/);
  });
});
