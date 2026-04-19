/**
 * Tests for makeVaultMirrorCallback (RFC 2e).
 * Verifies spawn behaviour under various OBSIDIAN_WRITE_ENABLED / config states.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ───────────────────────────────────────────────────────────────

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({
    unref: vi.fn(),
  })),
}));

vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => true),
  },
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { spawn } from 'child_process';
import fs from 'fs';
import { makeVaultMirrorCallback } from './vault-mirror.js';
import { logger } from './logger.js';

const mockSpawn = vi.mocked(spawn);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockLogger = vi.mocked(logger);

const VALID_CONFIG = {
  cliPath: '/app/dist/vault-bridge-cli.js',
  projectRoot: '/app',
  agentId: 'main',
  vaultRoot: '/vault/root',
};

describe('makeVaultMirrorCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  // Does NOT spawn when enabled=false
  it('returns null (no-op) when enabled is false', () => {
    const cb = makeVaultMirrorCallback(false, VALID_CONFIG);
    expect(cb).toBeNull();
  });

  // Does NOT spawn when config is null (no vault configured)
  it('does not spawn when config is null (no vault configured)', () => {
    const cb = makeVaultMirrorCallback(true, null);
    expect(cb).not.toBeNull();

    cb!(42, 'Some summary', 0.75, ['topic-a']);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      'OBSIDIAN_WRITE_ENABLED but no vault configured; skipping mirror',
    );
  });

  // Does NOT spawn when the CLI file is missing
  it('does not spawn when vault-bridge-cli.js is missing', () => {
    mockExistsSync.mockReturnValue(false);

    const cb = makeVaultMirrorCallback(true, VALID_CONFIG);
    expect(cb).not.toBeNull();

    cb!(42, 'Some summary', 0.75, ['topic-a']);

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { cliPath: VALID_CONFIG.cliPath },
      'Vault bridge enabled but CLI missing (memory-mirror) — is the project built?',
    );
  });

  // Spawns with expected argv when everything is set up
  it('spawns vault-bridge-cli with correct arguments', () => {
    const cb = makeVaultMirrorCallback(true, VALID_CONFIG);
    expect(cb).not.toBeNull();

    cb!(99, 'User always uses dark mode in applications', 0.82, ['preferences', 'UI']);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args, opts] = mockSpawn.mock.calls[0];

    expect(cmd).toBe('node');
    expect(args).toContain(VALID_CONFIG.cliPath);
    expect(args).toContain('write');
    expect(args).toContain('--type');
    expect(args).toContain('learning');
    expect(args).toContain('--source');
    expect(args).toContain('memory-mirror');
    expect(args).toContain('--agent-id');
    expect(args).toContain('main');
    expect(args).toContain('--memory-id');
    expect(args).toContain('99');
    expect(args).toContain('--vault-root');
    expect(args).toContain(VALID_CONFIG.vaultRoot);
    expect(args).toContain('--importance');
    expect(args).toContain('0.82');
    expect(args).toContain('--topics');
    expect(args).toContain('preferences,UI');
    // Title is sliced to 80 chars
    expect(args).toContain('--title');
    const titleIdx = (args as string[]).indexOf('--title');
    expect((args as string[])[titleIdx + 1].length).toBeLessThanOrEqual(80);

    expect(opts).toMatchObject({ detached: true, stdio: 'ignore', cwd: VALID_CONFIG.projectRoot });
  });

  // child.unref() is called so the process doesn't block shutdown
  it('calls unref() on the spawned child', () => {
    const mockChild = { unref: vi.fn() };
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    const cb = makeVaultMirrorCallback(true, VALID_CONFIG);
    cb!(1, 'summary', 0.75, []);

    expect(mockChild.unref).toHaveBeenCalledOnce();
  });

  // spawn errors are caught and logged, not re-thrown
  it('catches spawn errors without throwing', () => {
    mockSpawn.mockImplementation(() => { throw new Error('spawn failed'); });

    const cb = makeVaultMirrorCallback(true, VALID_CONFIG);
    expect(() => cb!(1, 'summary', 0.75, [])).not.toThrow();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error), context: 'memory-mirror' },
      'Failed to spawn vault-bridge-cli',
    );
  });
});
