import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setProjectLogsMap,
  setProjectLogsSender,
  getProjectLogsChannelId,
  sendProjectLog,
  _resetProjectLogsForTest,
} from './project-logs.js';

beforeEach(() => {
  _resetProjectLogsForTest();
});

describe('setProjectLogsMap / getProjectLogsChannelId', () => {
  it('roundtrips a map correctly', () => {
    setProjectLogsMap({ archisell: 'ch-logs-001', immo: 'ch-logs-002' });
    expect(getProjectLogsChannelId('archisell')).toBe('ch-logs-001');
    expect(getProjectLogsChannelId('immo')).toBe('ch-logs-002');
  });

  it('returns null for an unknown agent', () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    expect(getProjectLogsChannelId('unknown-agent')).toBeNull();
  });

  it('returns null when map is empty', () => {
    expect(getProjectLogsChannelId('archisell')).toBeNull();
  });

  it('replaces the previous map on repeated setProjectLogsMap calls', () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    setProjectLogsMap({ immo: 'ch-002' });
    expect(getProjectLogsChannelId('archisell')).toBeNull();
    expect(getProjectLogsChannelId('immo')).toBe('ch-002');
  });
});

describe('sendProjectLog', () => {
  it('returns silently (no throw) when no sender is registered', async () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    await expect(sendProjectLog('archisell', 'info', 'hello')).resolves.toBeUndefined();
  });

  it('returns silently when no channel is mapped for the agent', async () => {
    const sender = vi.fn(async () => {});
    setProjectLogsSender(sender);
    await expect(sendProjectLog('unknown', 'info', 'hello')).resolves.toBeUndefined();
    expect(sender).not.toHaveBeenCalled();
  });

  it('calls the sender with the formatted string for info level', async () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    const sender = vi.fn(async () => {});
    setProjectLogsSender(sender);

    await sendProjectLog('archisell', 'info', 'test message');

    expect(sender).toHaveBeenCalledOnce();
    expect(sender).toHaveBeenCalledWith('ch-001', 'ℹ️ test message');
  });

  it('calls the sender with the formatted string for warn level', async () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    const sender = vi.fn(async () => {});
    setProjectLogsSender(sender);

    await sendProjectLog('archisell', 'warn', 'something off');

    expect(sender).toHaveBeenCalledWith('ch-001', '⚠️ something off');
  });

  it('calls the sender with the formatted string for error level', async () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    const sender = vi.fn(async () => {});
    setProjectLogsSender(sender);

    await sendProjectLog('archisell', 'error', 'it broke');

    expect(sender).toHaveBeenCalledWith('ch-001', '🔴 it broke');
  });

  it('appends JSON meta to the log line', async () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    const sender = vi.fn(async () => {});
    setProjectLogsSender(sender);

    await sendProjectLog('archisell', 'info', 'with meta', { importance: 0.9, key: 'val' });

    const call = sender.mock.calls[0] as unknown as [string, string];
    expect(call[1]).toBe('ℹ️ with meta {"importance":0.9,"key":"val"}');
  });

  it('does not append anything for empty meta object', async () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    const sender = vi.fn(async () => {});
    setProjectLogsSender(sender);

    await sendProjectLog('archisell', 'info', 'no meta', {});

    const call = sender.mock.calls[0] as unknown as [string, string];
    expect(call[1]).toBe('ℹ️ no meta');
  });

  it('swallows errors thrown by the sender', async () => {
    setProjectLogsMap({ archisell: 'ch-001' });
    const sender = vi.fn(async () => {
      throw new Error('Discord down');
    });
    setProjectLogsSender(sender);

    await expect(sendProjectLog('archisell', 'error', 'boom')).resolves.toBeUndefined();
  });
});
