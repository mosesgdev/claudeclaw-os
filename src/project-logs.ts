import { logger } from './logger.js';

export interface ProjectLogsMap {
  [agentId: string]: string; // agent_id → logs channel ID
}

let _map: ProjectLogsMap = {};
let _sendFn: ((channelId: string, content: string) => Promise<void>) | null = null;

export function setProjectLogsMap(map: ProjectLogsMap): void {
  _map = { ...map };
}

export function setProjectLogsSender(
  fn: (channelId: string, content: string) => Promise<void>,
): void {
  _sendFn = fn;
}

export function getProjectLogsChannelId(agentId: string): string | null {
  return _map[agentId] ?? null;
}

export type LogLevel = 'info' | 'warn' | 'error';

export async function sendProjectLog(
  agentId: string,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const channelId = getProjectLogsChannelId(agentId);
  if (!channelId) return;
  if (!_sendFn) {
    logger.debug({ agentId, level }, 'sendProjectLog called before setProjectLogsSender wired');
    return;
  }
  const icon = level === 'info' ? 'ℹ️' : level === 'warn' ? '⚠️' : '🔴';
  const metaStr = meta && Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
  const line = `${icon} ${message}${metaStr}`;
  try {
    await _sendFn(channelId, line);
  } catch (err) {
    logger.warn({ err, agentId, level }, 'sendProjectLog failed');
  }
}

/** Reset state — tests only. */
export function _resetProjectLogsForTest(): void {
  _map = {};
  _sendFn = null;
}
