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

import { ingestConversationTurn, setHighImportanceCallback, setMirrorCallback } from './memory-ingest.js';
import { generateContent, parseJsonResponse } from './gemini.js';
import { saveStructuredMemoryAtomic } from './db.js';

const mockGenerateContent = vi.mocked(generateContent);
const mockParseJson = vi.mocked(parseJsonResponse);
const mockSave = vi.mocked(saveStructuredMemoryAtomic);

describe('ingestConversationTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Hard filters (skip before hitting Gemini) ────────────────────

  it('skips messages <= 15 characters', async () => {
    const result = await ingestConversationTurn('chat1', 'short msg', 'ok');
    expect(result).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('skips messages exactly 15 characters', async () => {
    const result = await ingestConversationTurn('chat1', '123456789012345', 'ok');
    expect(result).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('processes messages of 16 characters', async () => {
    mockGenerateContent.mockResolvedValue('{}');
    mockParseJson.mockReturnValue({ skip: true });
    const result = await ingestConversationTurn('chat1', '1234567890123456', 'ok');
    // Should have called Gemini even though it was skipped by LLM
    expect(mockGenerateContent).toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('skips messages starting with /', async () => {
    const result = await ingestConversationTurn('chat1', '/chatid some long command text here', 'Your ID is 12345');
    expect(result).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  // ── Gemini decides to skip ────────────────────────────────────────

  it('returns false when Gemini says skip', async () => {
    mockGenerateContent.mockResolvedValue('{"skip": true}');
    mockParseJson.mockReturnValue({ skip: true });
    const result = await ingestConversationTurn('chat1', 'ok sounds good thanks for doing that', 'No problem.');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns false when Gemini returns null (parse failure)', async () => {
    mockGenerateContent.mockResolvedValue('garbage');
    mockParseJson.mockReturnValue(null);
    const result = await ingestConversationTurn('chat1', 'some message that is long enough', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  // ── Gemini extracts a memory ──────────────────────────────────────

  it('saves a structured memory on valid extraction', async () => {
    const extraction = {
      skip: false,
      summary: 'User prefers dark mode in all applications',
      entities: ['dark mode', 'UI'],
      topics: ['preferences', 'UI'],
      importance: 0.8,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn(
      'chat1',
      'I always want dark mode enabled in everything',
      'Got it, I will remember your dark mode preference.',
    );

    expect(result).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(
      'chat1',
      'I always want dark mode enabled in everything',
      'User prefers dark mode in all applications',
      ['dark mode', 'UI'],
      ['preferences', 'UI'],
      0.8,
      expect.any(Array),
      'conversation',
      'main',
    );
  });

  // ── Importance filtering ──────────────────────────────────────────

  it('skips extraction with importance < 0.3', async () => {
    const extraction = {
      skip: false,
      summary: 'Trivial fact',
      entities: [],
      topics: [],
      importance: 0.25,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some trivial message longer than fifteen', 'ok');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('skips extraction with importance exactly 0.2 (below 0.3 floor)', async () => {
    const extraction = {
      skip: false,
      summary: 'Low importance fact',
      entities: [],
      topics: [],
      importance: 0.2,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some borderline message longer than fifteen', 'ok');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('skips extraction with importance exactly 0.3 (below 0.5 floor)', async () => {
    const extraction = {
      skip: false,
      summary: 'Borderline fact',
      entities: [],
      topics: [],
      importance: 0.3,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some borderline message longer than fifteen', 'ok');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('saves extraction with importance exactly 0.5', async () => {
    const extraction = {
      skip: false,
      summary: 'Useful fact',
      entities: [],
      topics: [],
      importance: 0.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some useful message longer than fifteen', 'ok');
    expect(result).toBe(true);
    expect(mockSave).toHaveBeenCalled();
  });

  // ── Importance clamping ───────────────────────────────────────────

  it('clamps importance above 1.0 to 1.0', async () => {
    const extraction = {
      skip: false,
      summary: 'Very important',
      entities: [],
      topics: [],
      importance: 1.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    await ingestConversationTurn('chat1', 'extremely important message for testing', 'noted');
    expect(mockSave).toHaveBeenCalledWith(
      'chat1',
      expect.any(String),
      'Very important',
      [],
      [],
      1.0,  // clamped
      expect.any(Array),
      'conversation',
      'main',
    );
  });

  it('clamps negative importance to 0', async () => {
    const extraction = {
      skip: false,
      summary: 'Negative importance',
      entities: [],
      topics: [],
      importance: -0.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    // importance -0.5 < 0.2 threshold, so it should be skipped
    const result = await ingestConversationTurn('chat1', 'message with negative importance test', 'response');
    expect(result).toBe(false);
  });

  // ── Validation of required fields ─────────────────────────────────

  it('skips when summary is missing', async () => {
    const extraction = {
      skip: false,
      summary: '',
      entities: [],
      topics: [],
      importance: 0.7,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'message with no summary extracted from it', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('skips when importance is not a number', async () => {
    const extraction = {
      skip: false,
      summary: 'Valid summary',
      entities: [],
      topics: [],
      importance: 'high' as unknown as number,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'message where importance is a string', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  // ── Missing optional fields ───────────────────────────────────────

  it('handles missing entities and topics gracefully', async () => {
    const extraction = {
      skip: false,
      summary: 'No entities or topics',
      importance: 0.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'message with no entities or topics at all', 'response');
    expect(result).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(
      'chat1',
      expect.any(String),
      'No entities or topics',
      [],  // defaults to empty
      [],  // defaults to empty
      0.5,
      expect.any(Array),
      'conversation',
      'main',
    );
  });

  // ── Error handling ────────────────────────────────────────────────

  it('returns false when Gemini API throws', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API rate limited'));

    const result = await ingestConversationTurn('chat1', 'this message should not crash the bot', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  // ── Message truncation ────────────────────────────────────────────

  it('truncates long messages to 2000 chars in prompt', async () => {
    mockGenerateContent.mockResolvedValue('{"skip": true}');
    mockParseJson.mockReturnValue({ skip: true });

    const longMsg = 'x'.repeat(5000);
    await ingestConversationTurn('chat1', longMsg, 'response');

    const promptArg = mockGenerateContent.mock.calls[0][0];
    // The prompt should contain the truncated message, not the full 5000 chars
    expect(promptArg).not.toContain('x'.repeat(3000));
    expect(promptArg).toContain('x'.repeat(2000));
  });
});

// ── mirror callback (RFC 2e) ────────────────────────────────────────────

describe('mirror callback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset callbacks to null before each test
    setHighImportanceCallback(null as unknown as Parameters<typeof setHighImportanceCallback>[0]);
    setMirrorCallback(null as unknown as Parameters<typeof setMirrorCallback>[0]);
  });

  function makeExtraction(importance: number) {
    return {
      skip: false,
      summary: 'A lasting preference about something meaningful',
      entities: ['entity'],
      topics: ['topic-a', 'topic-b'],
      importance,
    };
  }

  async function ingestWith(importance: number) {
    const ext = makeExtraction(importance);
    mockGenerateContent.mockResolvedValue(JSON.stringify(ext));
    mockParseJson.mockReturnValue(ext);
    return ingestConversationTurn('chat1', 'a long enough message about something worth remembering', 'noted');
  }

  // a) mirror callback fires at importance 0.7
  it('fires mirror callback at importance 0.7', async () => {
    const mirror = vi.fn();
    setMirrorCallback(mirror);

    await ingestWith(0.7);

    expect(mirror).toHaveBeenCalledOnce();
    expect(mirror).toHaveBeenCalledWith(
      expect.any(Number),
      'A lasting preference about something meaningful',
      0.7,
      ['topic-a', 'topic-b'],
    );
  });

  // a) mirror callback fires at importance 0.8
  it('fires mirror callback at importance 0.8', async () => {
    const mirror = vi.fn();
    setMirrorCallback(mirror);

    await ingestWith(0.8);

    expect(mirror).toHaveBeenCalledOnce();
  });

  // b) mirror callback does NOT fire at importance 0.69
  it('does NOT fire mirror callback at importance 0.69', async () => {
    const mirror = vi.fn();
    setMirrorCallback(mirror);

    await ingestWith(0.69);

    expect(mirror).not.toHaveBeenCalled();
  });

  // b) mirror callback does NOT fire at importance 0.5 (hard floor — still saved, not mirrored)
  it('does NOT fire mirror callback at importance 0.5', async () => {
    const mirror = vi.fn();
    setMirrorCallback(mirror);

    const result = await ingestWith(0.5);
    expect(result).toBe(true); // memory IS saved
    expect(mirror).not.toHaveBeenCalled(); // but NOT mirrored
  });

  // c) errors in mirror callback do not block the high-importance notification callback
  it('mirror callback error does not block high-importance notification', async () => {
    const notification = vi.fn();
    const mirror = vi.fn().mockImplementation(() => { throw new Error('mirror failed'); });
    setHighImportanceCallback(notification);
    setMirrorCallback(mirror);

    await ingestWith(0.8); // triggers BOTH callbacks (0.8 >= both thresholds)

    expect(mirror).toHaveBeenCalledOnce();
    expect(notification).toHaveBeenCalledOnce();
  });

  // c) errors in notification callback do not block mirror callback
  it('notification callback error does not block mirror callback', async () => {
    const notification = vi.fn().mockImplementation(() => { throw new Error('notification failed'); });
    const mirror = vi.fn();
    setHighImportanceCallback(notification);
    setMirrorCallback(mirror);

    await ingestWith(0.8);

    expect(notification).toHaveBeenCalledOnce();
    expect(mirror).toHaveBeenCalledOnce();
  });

  // d) both callbacks fire independently when importance >= 0.8
  it('both callbacks fire independently when importance is 0.9', async () => {
    const notification = vi.fn();
    const mirror = vi.fn();
    setHighImportanceCallback(notification);
    setMirrorCallback(mirror);

    await ingestWith(0.9);

    expect(notification).toHaveBeenCalledOnce();
    expect(mirror).toHaveBeenCalledOnce();
    // notification gets (memoryId, summary, importance) — no topics
    expect(notification).toHaveBeenCalledWith(
      expect.any(Number),
      'A lasting preference about something meaningful',
      0.9,
    );
    // mirror gets (memoryId, summary, importance, topics)
    expect(mirror).toHaveBeenCalledWith(
      expect.any(Number),
      'A lasting preference about something meaningful',
      0.9,
      ['topic-a', 'topic-b'],
    );
  });

  // at exactly 0.8 notification fires AND mirror fires
  it('at exactly 0.8, both notification and mirror fire', async () => {
    const notification = vi.fn();
    const mirror = vi.fn();
    setHighImportanceCallback(notification);
    setMirrorCallback(mirror);

    await ingestWith(0.8);

    expect(notification).toHaveBeenCalledOnce();
    expect(mirror).toHaveBeenCalledOnce();
  });

  // mirror fires but notification does not when importance is exactly 0.7
  it('at exactly 0.7, mirror fires but notification does not', async () => {
    const notification = vi.fn();
    const mirror = vi.fn();
    setHighImportanceCallback(notification);
    setMirrorCallback(mirror);

    await ingestWith(0.7);

    expect(notification).not.toHaveBeenCalled();
    expect(mirror).toHaveBeenCalledOnce();
  });
});
