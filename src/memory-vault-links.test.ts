import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase } from './db.js';
import {
  setVaultPath,
  getVaultPath,
  getLinkByPath,
  listLinksByTopics,
} from './memory-vault-links.js';

// ── DB helpers ─────────────────────────────────────────────────────────

import { getDb } from './db.js';

function insertMemory(opts: {
  id?: number;
  chatId?: string;
  summary?: string;
  importance?: number;
  topics?: string[];
}): number {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare(`
    INSERT INTO memories (chat_id, source, raw_text, summary, entities, topics, importance, salience, created_at, accessed_at)
    VALUES (?, 'test', ?, ?, '[]', ?, ?, 1.0, ?, ?)
  `).run(
    opts.chatId ?? 'test-chat',
    opts.summary ?? 'test summary',
    opts.summary ?? 'test summary',
    JSON.stringify(opts.topics ?? []),
    opts.importance ?? 0.5,
    now,
    now,
  );
  return Number(result.lastInsertRowid);
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('memory-vault-links', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('setVaultPath inserts a row; getVaultPath returns the path', () => {
    const id = insertMemory({ summary: 'foo' });
    setVaultPath(id, '06-claudeclaw/learnings/foo.md');
    expect(getVaultPath(id)).toBe('06-claudeclaw/learnings/foo.md');
  });

  it('getVaultPath returns null for an unknown memory id', () => {
    expect(getVaultPath(9999)).toBeNull();
  });

  it('setVaultPath twice on the same id updates vault_path and bumps updated_at', async () => {
    const id = insertMemory({ summary: 'bar' });
    setVaultPath(id, 'first/path.md');

    const db = getDb();
    const before = (db.prepare('SELECT updated_at FROM memory_vault_links WHERE memory_id = ?').get(id) as { updated_at: number }).updated_at;

    // Wait 1 second to ensure updated_at changes
    await new Promise((r) => setTimeout(r, 1001));

    setVaultPath(id, 'second/path.md');
    expect(getVaultPath(id)).toBe('second/path.md');

    const after = (db.prepare('SELECT updated_at FROM memory_vault_links WHERE memory_id = ?').get(id) as { updated_at: number }).updated_at;
    expect(after).toBeGreaterThan(before);
  });

  it('getLinkByPath returns the correct row', () => {
    const id = insertMemory({ summary: 'baz' });
    setVaultPath(id, 'some/vault/path.md');
    const link = getLinkByPath('some/vault/path.md');
    expect(link).not.toBeNull();
    expect(link!.memoryId).toBe(id);
    expect(link!.vaultPath).toBe('some/vault/path.md');
  });

  it('getLinkByPath returns null for an unknown path', () => {
    expect(getLinkByPath('does/not/exist.md')).toBeNull();
  });

  it('listLinksByTopics returns only rows whose topics overlap', () => {
    const idA = insertMemory({ summary: 'TypeScript tips', topics: ['typescript', 'coding'] });
    const idB = insertMemory({ summary: 'Cooking recipes', topics: ['cooking', 'food'] });
    const idC = insertMemory({ summary: 'More TS', topics: ['typescript'] });

    setVaultPath(idA, 'learnings/ts-tips.md');
    setVaultPath(idB, 'learnings/cooking.md');
    setVaultPath(idC, 'learnings/more-ts.md');

    const results = listLinksByTopics(['typescript']);
    const ids = results.map((r) => r.memoryId);
    expect(ids).toContain(idA);
    expect(ids).toContain(idC);
    expect(ids).not.toContain(idB);
  });

  it('listLinksByTopics returns empty array for no topic matches', () => {
    const id = insertMemory({ summary: 'Python tips', topics: ['python'] });
    setVaultPath(id, 'learnings/python.md');
    expect(listLinksByTopics(['rust'])).toHaveLength(0);
  });

  it('listLinksByTopics respects the limit', () => {
    for (let i = 0; i < 5; i++) {
      const id = insertMemory({ summary: `Memory ${i}`, topics: ['shared'], importance: 0.9 - i * 0.1 });
      setVaultPath(id, `learnings/memory-${i}.md`);
    }
    const results = listLinksByTopics(['shared'], 3);
    expect(results.length).toBe(3);
  });

  it('listLinksByTopics orders by importance DESC', () => {
    const idLow = insertMemory({ summary: 'Low importance', topics: ['tag'], importance: 0.2 });
    const idHigh = insertMemory({ summary: 'High importance', topics: ['tag'], importance: 0.9 });
    setVaultPath(idLow, 'learnings/low.md');
    setVaultPath(idHigh, 'learnings/high.md');

    const results = listLinksByTopics(['tag']);
    expect(results[0].memoryId).toBe(idHigh);
    expect(results[results.length - 1].memoryId).toBe(idLow);
  });

  it('listLinksByTopics returns empty array for empty topics list', () => {
    const id = insertMemory({ topics: ['foo'] });
    setVaultPath(id, 'learnings/foo.md');
    expect(listLinksByTopics([])).toHaveLength(0);
  });
});
