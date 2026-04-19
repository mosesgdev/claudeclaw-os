import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Mock OBSIDIAN_WRITE_ENABLED so we can flip it per describe block ──────────
// Must be hoisted before importing obsidian.ts.
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./config.js')>();
  return {
    ...actual,
    get OBSIDIAN_WRITE_ENABLED() {
      return mockWriteEnabled;
    },
  };
});

// Mutable flag controlled per test block
let mockWriteEnabled = false;

import { buildObsidianContext, _resetObsidianCache, extractTitleAndSummary } from './obsidian.js';

const tmpDir = path.join(os.tmpdir(), `obsidian-test-${Date.now()}`);

function writeNote(folder: string, name: string, content: string): void {
  const dir = path.join(tmpDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

/** Write a note and set its mtime. Returns the path. */
function writeNoteAt(folder: string, name: string, content: string, mtimeMs: number): string {
  const dir = path.join(tmpDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
  return p;
}

function knowledgeFrontmatter(extra = ''): string {
  return `---\nstatus: active\ntags:\n  - type/knowledge\n${extra}---\n`;
}

function learningFrontmatter(extra = ''): string {
  return `---\nstatus: active\ntags:\n  - type/learning\n${extra}---\n`;
}

describe('obsidian', () => {
  beforeEach(() => {
    mockWriteEnabled = false;
    _resetObsidianCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Original tests (unchanged behaviour) ────────────────────────────────────

  it('returns empty string when config is undefined', () => {
    expect(buildObsidianContext(undefined)).toBe('');
  });

  it('returns empty string when folders have no notes with open tasks', () => {
    writeNote('Projects', 'done.md', '# Done\nAll tasks complete.');
    const result = buildObsidianContext({ vault: tmpDir, folders: ['Projects'] });
    expect(result).toBe('');
  });

  it('includes titles and open tasks from notes', () => {
    writeNote('Projects', 'hiring.md', '# Hiring\n- [ ] Post job listing\n- [x] Review resumes');
    const result = buildObsidianContext({ vault: tmpDir, folders: ['Projects'] });
    expect(result).toContain('Open: Post job listing (hiring)');
    expect(result).not.toContain('Review resumes');
  });

  it('skips notes tagged status: done', () => {
    writeNote('Projects', 'old.md', 'status: done\n- [ ] Should be ignored');
    const result = buildObsidianContext({ vault: tmpDir, folders: ['Projects'] });
    expect(result).toBe('');
  });

  it('includes notes from readOnly folders', () => {
    writeNote('Daily', 'today.md', '- [ ] Morning review');
    const result = buildObsidianContext({ vault: tmpDir, folders: [], readOnly: ['Daily'] });
    expect(result).toContain('Open: Morning review');
  });

  it('groups tasks by folder', () => {
    writeNote('FolderA', 'a.md', '- [ ] Task A');
    writeNote('FolderB', 'b.md', '- [ ] Task B');
    const result = buildObsidianContext({ vault: tmpDir, folders: ['FolderA', 'FolderB'] });
    expect(result).toContain('FolderA/');
    expect(result).toContain('FolderB/');
  });

  it('uses cache on second call', () => {
    writeNote('Projects', 'x.md', '- [ ] First task');
    const first = buildObsidianContext({ vault: tmpDir, folders: ['Projects'] });
    // Add a new note — should not appear due to cache
    writeNote('Projects', 'y.md', '- [ ] Second task');
    const second = buildObsidianContext({ vault: tmpDir, folders: ['Projects'] });
    expect(first).toBe(second);
    expect(second).not.toContain('Second task');
  });

  it('output is reasonably compact', () => {
    for (let i = 0; i < 10; i++) {
      writeNote('Big', `note${i}.md`, `- [ ] Task ${i}`);
    }
    const result = buildObsidianContext({ vault: tmpDir, folders: ['Big'] });
    // Rough check: should be under ~2000 chars for 10 tasks
    expect(result.length).toBeLessThan(2000);
  });

  // ── New tests: feature-flag gating ──────────────────────────────────────────

  it('when OBSIDIAN_WRITE_ENABLED=false, output matches old format (tasks only)', () => {
    mockWriteEnabled = false;
    writeNote('Projects', 'work.md', '- [ ] Do work');
    const result = buildObsidianContext({ vault: tmpDir, folders: ['Projects'] });
    // Old sections present
    expect(result).toContain('[Obsidian: active tasks]');
    // New sections absent
    expect(result).not.toContain('[Obsidian: profile]');
    expect(result).not.toContain('[Obsidian: knowledge]');
    expect(result).not.toContain('[Obsidian: learnings]');
  });

  // ── Part B: Profile section ──────────────────────────────────────────────────

  describe('profile section', () => {
    beforeEach(() => {
      mockWriteEnabled = true;
      _resetObsidianCache();
    });

    it('loads profile when moses-profile.md is present', () => {
      writeNote('00-inbox', 'moses-profile.md', '# Moses Profile\nMoses is the CTO.');
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).toContain('[Obsidian: profile]');
      expect(result).toContain('Moses is the CTO.');
      expect(result).toContain('[End profile]');
    });

    it('skips profile section when moses-profile.md is absent', () => {
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).not.toContain('[Obsidian: profile]');
    });

    it('caps profile at 2000 chars', () => {
      const longContent = 'x'.repeat(3000);
      writeNote('00-inbox', 'moses-profile.md', longContent);
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).toContain('[Obsidian: profile]');
      // The profile content in the output should be at most 2000 chars
      const profileStart = result.indexOf('[Obsidian: profile]\n') + '[Obsidian: profile]\n'.length;
      const profileEnd = result.indexOf('\n[End profile]');
      const profileContent = result.slice(profileStart, profileEnd);
      expect(profileContent.length).toBeLessThanOrEqual(2000);
    });
  });

  // ── Part B: Knowledge section ────────────────────────────────────────────────

  describe('knowledge section', () => {
    beforeEach(() => {
      mockWriteEnabled = true;
      _resetObsidianCache();
    });

    it('surfaces files with status:active and type/knowledge tag', () => {
      writeNote('05-knowledge', 'typescript-tips.md',
        `${knowledgeFrontmatter()}# TypeScript Tips\nAlways use strict mode.`);
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).toContain('[Obsidian: knowledge]');
      expect(result).toContain('TypeScript Tips');
      expect(result).toContain('Always use strict mode.');
      expect(result).toContain('typescript-tips.md');
    });

    it('skips files with status:done', () => {
      writeNote('05-knowledge', 'old-thing.md',
        `---\nstatus: done\ntags:\n  - type/knowledge\n---\n# Old Thing\nDeprecated.`);
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).not.toContain('Old Thing');
    });

    it('skips files without type/knowledge tag', () => {
      writeNote('05-knowledge', 'wrong-type.md',
        `---\nstatus: active\ntags:\n  - type/session\n---\n# Wrong Type\nShould be skipped.`);
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).not.toContain('Wrong Type');
    });

    it('skips files with wrong type even if active', () => {
      writeNote('05-knowledge', 'wrong-type2.md',
        `---\nstatus: active\ntags:\n  - type/learning\n---\n# Learning In Knowledge\nSkipped.`);
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).not.toContain('[Obsidian: knowledge]');
    });

    it('caps result to 20 most-recently-modified files', () => {
      // Create 25 files, varying mtimes
      for (let i = 0; i < 25; i++) {
        const mtime = Date.now() - i * 1000; // newer = lower index
        writeNoteAt('05-knowledge', `file${i}.md`,
          `${knowledgeFrontmatter()}# File ${i}\nContent ${i}.`, mtime);
      }
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      // Count how many "file: fileN.md" entries appear
      const matches = result.match(/file: file\d+\.md/g) ?? [];
      expect(matches.length).toBe(20);
    });
  });

  // ── Part B: Learnings section ─────────────────────────────────────────────────

  describe('learnings section', () => {
    beforeEach(() => {
      mockWriteEnabled = true;
      _resetObsidianCache();
    });

    it('surfaces files with status:active and type/learning tag', () => {
      writeNote('06-claudeclaw/learnings', 'discord-bot.md',
        `${learningFrontmatter()}# Discord Bot Learnings\nUse gateway intents.`);
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).toContain('[Obsidian: learnings]');
      expect(result).toContain('Discord Bot Learnings');
      expect(result).toContain('Use gateway intents.');
    });

    it('skips files without type/learning tag', () => {
      writeNote('06-claudeclaw/learnings', 'not-learning.md',
        `---\nstatus: active\ntags:\n  - type/knowledge\n---\n# Not A Learning\nSkipped.`);
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(result).not.toContain('Not A Learning');
    });

    it('caps to 20 most-recently-modified files', () => {
      for (let i = 0; i < 25; i++) {
        const mtime = Date.now() - i * 1000;
        writeNoteAt('06-claudeclaw/learnings', `learn${i}.md`,
          `${learningFrontmatter()}# Learn ${i}\nDetail ${i}.`, mtime);
      }
      const result = buildObsidianContext({ vault: tmpDir, folders: [] });
      const matches = result.match(/file: learn\d+\.md/g) ?? [];
      expect(matches.length).toBe(20);
    });
  });

  // ── Part B: Title + paragraph extraction ─────────────────────────────────────

  describe('extractTitleAndSummary', () => {
    it('extracts H1 title and first paragraph', () => {
      const body = `# My Title\n\nThis is the first paragraph of the note.\n\nSecond paragraph.`;
      const { title, summary } = extractTitleAndSummary(body, 'fallback.md');
      expect(title).toBe('My Title');
      expect(summary).toBe('This is the first paragraph of the note.');
    });

    it('uses filename as fallback when no H1 present', () => {
      const body = `Just some content without a heading.`;
      const { title } = extractTitleAndSummary(body, 'my-note.md');
      expect(title).toBe('my-note');
    });

    it('caps summary at 200 chars', () => {
      const longParagraph = 'word '.repeat(60);
      const body = `# Title\n\n${longParagraph}`;
      const { summary } = extractTitleAndSummary(body, 'x.md');
      expect(summary.length).toBeLessThanOrEqual(200);
    });

    it('handles file with H1 but no paragraph', () => {
      const body = `# Just A Title\n\n`;
      const { title, summary } = extractTitleAndSummary(body, 'empty.md');
      expect(title).toBe('Just A Title');
      expect(summary).toBe('');
    });

    it('stops paragraph collection at second heading', () => {
      const body = `# Title\n\nFirst para.\n\n## Subheading\n\nSecond para.`;
      const { summary } = extractTitleAndSummary(body, 'x.md');
      expect(summary).toBe('First para.');
      expect(summary).not.toContain('Second para');
    });
  });

  // ── Cache behaviour ───────────────────────────────────────────────────────────

  describe('cache with extended read path', () => {
    beforeEach(() => {
      mockWriteEnabled = true;
      _resetObsidianCache();
    });

    it('returns same result within TTL (cache hit)', () => {
      writeNote('05-knowledge', 'cached.md',
        `${knowledgeFrontmatter()}# Cached\nCached content.`);
      const first = buildObsidianContext({ vault: tmpDir, folders: [] });
      // Add a new knowledge file — should not appear due to cache
      writeNote('05-knowledge', 'new-entry.md',
        `${knowledgeFrontmatter()}# New Entry\nShouldn't show.`);
      const second = buildObsidianContext({ vault: tmpDir, folders: [] });
      expect(first).toBe(second);
      expect(second).not.toContain('New Entry');
    });
  });
});
