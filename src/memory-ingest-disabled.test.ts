/**
 * Tests for sendProjectLog gate when PROJECT_AGENTS_ENABLED=false (RFC 3b).
 * Kept in a separate file to isolate the config mock value from the main test file.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./gemini.js', () => ({
  generateContent: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

vi.mock('./db.js', () => ({
  saveStructuredMemoryAtomic: vi.fn(() => 1),
  getMemoriesWithEmbeddings: vi.fn(() => []),
}));

vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
  cosineSimilarity: vi.fn(() => 0),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('./project-logs.js', () => ({
  sendProjectLog: vi.fn(() => Promise.resolve()),
}));

// PROJECT_AGENTS_ENABLED = false
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return { ...actual, PROJECT_AGENTS_ENABLED: false };
});

import { ingestConversationTurn, setHighImportanceCallback, setMirrorCallback } from './memory-ingest.js';
import { generateContent, parseJsonResponse } from './gemini.js';
import { sendProjectLog } from './project-logs.js';

const mockGenerateContent = vi.mocked(generateContent);
const mockParseJson = vi.mocked(parseJsonResponse);
const mockSendProjectLog = vi.mocked(sendProjectLog);

describe('sendProjectLog gate — PROJECT_AGENTS_ENABLED=false', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setHighImportanceCallback(null as unknown as Parameters<typeof setHighImportanceCallback>[0]);
    setMirrorCallback(null as unknown as Parameters<typeof setMirrorCallback>[0]);
  });

  it('does NOT fire sendProjectLog when PROJECT_AGENTS_ENABLED is false', async () => {
    const ext = {
      skip: false,
      summary: 'A lasting preference about something meaningful',
      entities: ['entity'],
      topics: ['topic-a'],
      importance: 0.8,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(ext));
    mockParseJson.mockReturnValue(ext);

    await ingestConversationTurn('chat1', 'a long enough message about something worth remembering', 'noted', 'testAgent');
    await Promise.resolve();

    expect(mockSendProjectLog).not.toHaveBeenCalled();
  });
});
