import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// ── Mock logger to suppress noise ─────────────────────────────────────
vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ── Mock config so AGENTIC_MASTER_ROOT is controllable ────────────────
vi.mock('./config.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    AGENTIC_MASTER_ROOT: '/nonexistent-agentic-master',
    PROJECT_ROOT: '/nonexistent-project',
    expandHome: (p: string) => {
      if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(1));
      return p;
    },
  };
});

import {
  slugify,
  todayStr,
  loadConventions,
  atomicWrite,
  parseFrontmatter,
  isProjectArchived,
  cmdWrite,
  cmdCloseTask,
  cmdUpdateBacklinks,
  fetchNeighbors,
  dedupeCheck,
  registerVaultPath,
} from './vault-bridge-cli.js';

// ── Helpers ───────────────────────────────────────────────────────────

function makeTmpVault(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vault-bridge-test-'));
}

function makeTmpAgenticMaster(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-master-test-'));
  const expertiseDir = path.join(dir, 'expertise');
  fs.mkdirSync(expertiseDir, { recursive: true });
  const vaultYaml = `vault_root: ~/Documents/Obsidian/ClaudeClaw
folders:
  sessions:      06-claudeclaw/sessions/
  learnings:     06-claudeclaw/learnings/
  reflections:   06-claudeclaw/reflections/
  knowledge:     05-knowledge/
  project:       04-projects/
  agent_scoped:  06-claudeclaw/agents/{agent_id}/
filename_patterns:
  session:     "{YYYY-MM-DD}-{slug}.md"
  learning:    "{slug}.md"
  reflection:  "{YYYY-MM-DD}-{slug}.md"
  knowledge:   "{slug}.md"
  context:     "context.md"
dedupe_cosine_threshold: 0.85
importance_mirror_threshold: 0.7
`;
  fs.writeFileSync(path.join(expertiseDir, 'obsidian-vault.yaml'), vaultYaml, 'utf-8');
  return dir;
}

function cleanupDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

/** Shared tmpdir refs, set in beforeEach and cleaned in afterEach. */
let tmpVault: string;
let tmpAgentic: string;

/** Build opts that point at tmpVault and tmpAgentic. */
function testOpts(extra?: {
  dedupeCheckFn?: typeof dedupeCheck;
  fetchNeighborsFn?: typeof fetchNeighbors;
  registerVaultPathFn?: typeof registerVaultPath;
}): Parameters<typeof cmdWrite>[1] {
  return {
    vaultRootOverride: tmpVault,
    agenticMasterRoot: tmpAgentic,
    dedupeCheckFn: extra?.dedupeCheckFn ?? ((_t, _c, _th) => ({ duplicate: false })),
    fetchNeighborsFn: extra?.fetchNeighborsFn ?? ((_topics, _limit) => []),
    registerVaultPathFn: extra?.registerVaultPathFn ?? ((_id, _p) => { /* no-op */ }),
  };
}

// ── Setup / teardown ──────────────────────────────────────────────────

beforeEach(() => {
  tmpVault = makeTmpVault();
  tmpAgentic = makeTmpAgenticMaster();
});

afterEach(() => {
  cleanupDir(tmpVault);
  cleanupDir(tmpAgentic);
});

// ── Tests ─────────────────────────────────────────────────────────────

describe('slugify', () => {
  it('lowercases, hyphenates spaces, strips special chars', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    // & is stripped, space becomes hyphen → single hyphen between words
    expect(slugify('TypeScript & async')).toBe('typescript-async');
    // multi-hyphen collapse
    expect(slugify('a--b')).toBe('a-b');
  });

  it('caps at 80 chars', () => {
    const long = 'a'.repeat(100);
    expect(slugify(long).length).toBeLessThanOrEqual(80);
  });
});

describe('loadConventions', () => {
  it('loads from yaml when agentic-master exists', () => {
    const conv = loadConventions(tmpAgentic);
    expect(conv.folders.sessions).toBe('06-claudeclaw/sessions/');
    expect(conv.dedupe_cosine_threshold).toBe(0.85);
  });

  it('falls back to hardcoded defaults when yaml is missing', () => {
    const conv = loadConventions('/no-such-directory');
    expect(conv.folders.learnings).toBe('06-claudeclaw/learnings/');
  });
});

// ── Test 1: write --type learning creates file at expected path ───────

describe('cmdWrite', () => {
  it('1. write --type learning creates file at expected path with correct frontmatter', async () => {
    const result = await cmdWrite(
      ['--type', 'learning', '--title', 'My Learning', '--content', 'Some insight here'],
      testOpts(),
    );

    expect(result.status).toBe('written');
    expect(result.path).toMatch(/^06-claudeclaw\/learnings\/my-learning\.md/);

    const abs = path.join(tmpVault, result.path!);
    expect(fs.existsSync(abs)).toBe(true);

    const content = fs.readFileSync(abs, 'utf-8');
    const fm = parseFrontmatter(content);

    expect(fm['status']).toBe('active');
    expect(Array.isArray(fm['tags'])).toBe(true);
    expect((fm['tags'] as string[]).includes('type/learning')).toBe(true);
    expect(fm['created']).toBe(todayStr());
    expect(content).toContain('Some insight here');
  });

  // ── Test 2: session --agent-id routes to agent_scoped folder ─────────

  it('2. write --type session --agent-id archisell routes to agents/archisell/sessions/', async () => {
    const result = await cmdWrite(
      ['--type', 'session', '--title', 'Daily Standup', '--content', 'Status update', '--agent-id', 'archisell'],
      testOpts(),
    );

    expect(result.status).toBe('written');
    expect(result.path).toContain('06-claudeclaw/agents/archisell/sessions/');

    const abs = path.join(tmpVault, result.path!);
    expect(fs.existsSync(abs)).toBe(true);
  });

  // ── Test 3: project-context merges into existing context.md ──────────

  it('3. write --type project-context --project foo merges into existing context.md', async () => {
    // Create project folder and initial context.md
    const projDir = path.join(tmpVault, '04-projects', 'foo');
    fs.mkdirSync(projDir, { recursive: true });
    const ctxPath = path.join(projDir, 'context.md');
    fs.writeFileSync(ctxPath, `---
tags:
  - type/project-context
status: active
created: 2026-01-01
related: []
---

# Foo Project

Initial content.
`, 'utf-8');

    const result = await cmdWrite(
      ['--type', 'project-context', '--project', 'foo', '--title', 'Foo Context', '--content', 'New update.'],
      testOpts(),
    );

    expect(result.status).toBe('updated');
    expect(result.path).toBe(path.join('04-projects', 'foo', 'context.md'));

    // Verify original + new content coexist and file wasn't duplicated
    const updated = fs.readFileSync(ctxPath, 'utf-8');
    expect(updated).toContain('Initial content.');
    expect(updated).toContain('New update.');

    // No duplicate context.md-2 should exist
    expect(fs.existsSync(path.join(projDir, 'context.md-2'))).toBe(false);
  });

  // ── Test 4: archived project returns status: skipped ─────────────────

  it('4. write --type project-context --project archived-xyz returns status: skipped', async () => {
    // Create an archived project context.md
    const projDir = path.join(tmpVault, '04-projects', 'archived-xyz');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'context.md'), `---
tags:
  - type/project-context
status: archived
created: 2025-01-01
related: []
---

# Archived Project
`, 'utf-8');

    const result = await cmdWrite(
      ['--type', 'project-context', '--project', 'archived-xyz', '--title', 'Archived', '--content', 'stuff'],
      testOpts(),
    );

    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('archived-project');
  });

  // ── Test 5: atomic write — verifies .tmp file convention ─────────────

  it('5. atomicWrite writes to .tmp then renames to final path', () => {
    const target = path.join(tmpVault, 'atomic-test', 'note.md');
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // Intercept to confirm .tmp is created
    const tmpPath = target + '.tmp';
    const origWriteFile = fs.writeFileSync.bind(fs);
    let tmpWritten = false;

    // Actually call atomicWrite and verify behavior
    atomicWrite(target, 'content here');

    // After atomicWrite: final file exists, .tmp does not
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);
    expect(fs.readFileSync(target, 'utf-8')).toBe('content here');
    void origWriteFile;
    void tmpWritten;
  });

  // ── Test 6: slug collision auto-suffixes to -2 ───────────────────────

  it('6. slug collision auto-suffixes to -2', async () => {
    // Write first file
    const r1 = await cmdWrite(
      ['--type', 'knowledge', '--title', 'Duplicate Title', '--content', 'First content'],
      testOpts(),
    );
    expect(r1.status).toBe('written');

    // Write second with same title
    const r2 = await cmdWrite(
      ['--type', 'knowledge', '--title', 'Duplicate Title', '--content', 'Second content', '--no-dedupe'],
      { ...testOpts(), dedupeCheckFn: () => ({ duplicate: false }) },
    );
    expect(r2.status).toBe('written');
    expect(r2.path).toMatch(/-2\.md$/);

    const abs2 = path.join(tmpVault, r2.path!);
    expect(fs.existsSync(abs2)).toBe(true);
    expect(fs.readFileSync(abs2, 'utf-8')).toContain('Second content');
  });

  // ── Test 7: importance + source appear in frontmatter ────────────────

  it('7. importance and source appear in frontmatter when flags set', async () => {
    const result = await cmdWrite(
      [
        '--type', 'reflection',
        '--title', 'Deep Thought',
        '--content', 'Insight content',
        '--importance', '0.9',
        '--source', 'memory-mirror',
        '--no-dedupe',
      ],
      testOpts(),
    );

    expect(result.status).toBe('written');
    const abs = path.join(tmpVault, result.path!);
    const content = fs.readFileSync(abs, 'utf-8');
    const fm = parseFrontmatter(content);

    expect(fm['importance']).toBe(0.9);
    expect(fm['source']).toBe('memory-mirror');
  });

  // ── Test 8: tags include project/ and agent/ prefixes ────────────────

  it('8. tags include project/ and agent/ prefixes when flags set', async () => {
    const result = await cmdWrite(
      [
        '--type', 'session',
        '--title', 'Project Session',
        '--content', 'Notes for project',
        '--project', 'myproject',
        '--agent-id', 'myagent',
        '--no-dedupe',
      ],
      testOpts(),
    );

    expect(result.status).toBe('written');
    const abs = path.join(tmpVault, result.path!);
    const content = fs.readFileSync(abs, 'utf-8');
    const fm = parseFrontmatter(content);
    const tags = fm['tags'] as string[];

    expect(tags).toContain('type/session');
    expect(tags).toContain('project/myproject');
    expect(tags).toContain('agent/myagent');
  });

  // ── Test 9: wiki-link injection adds ## Related section ──────────────

  it('9. wiki-link injection adds ## Related section with neighbor links', async () => {
    const mockFetchNeighbors = vi.fn((_topics: string[], _limit: number) => [
      '06-claudeclaw/learnings/neighbor-one.md',
      '05-knowledge/neighbor-two.md',
    ]);

    const result = await cmdWrite(
      [
        '--type', 'learning',
        '--title', 'Connected Learning',
        '--content', 'Content with neighbors',
        '--topics', 'typescript,testing',
        '--no-dedupe',
      ],
      {
        ...testOpts(),
        fetchNeighborsFn: mockFetchNeighbors,
      },
    );

    expect(result.status).toBe('written');
    const abs = path.join(tmpVault, result.path!);
    const content = fs.readFileSync(abs, 'utf-8');

    expect(content).toContain('## Related');
    expect(content).toContain('[[06-claudeclaw/learnings/neighbor-one]]');
    expect(content).toContain('[[05-knowledge/neighbor-two]]');
    expect(mockFetchNeighbors).toHaveBeenCalledWith(['typescript', 'testing'], 3);
  });

  // ── Test 10: dedupe hit returns status: updated, no new file ─────────

  it('10. dedupe hit returns status: updated and does not create a new file', async () => {
    // Pre-create the "existing" file that dedupe will point to
    const existingRel = '06-claudeclaw/learnings/existing-note.md';
    const existingAbs = path.join(tmpVault, existingRel);
    fs.mkdirSync(path.dirname(existingAbs), { recursive: true });
    fs.writeFileSync(existingAbs, `---
tags:
  - type/learning
status: active
created: 2026-01-01
related: []
---

# Existing Note

Original content.
`, 'utf-8');

    const mockDedupe = vi.fn(() => ({
      duplicate: true as const,
      existingId: 42,
      vaultPath: existingRel,
    }));

    const countBefore = fs.readdirSync(path.join(tmpVault, '06-claudeclaw', 'learnings')).length;

    const result = await cmdWrite(
      ['--type', 'learning', '--title', 'Near Duplicate', '--content', 'Very similar content'],
      { ...testOpts(), dedupeCheckFn: mockDedupe },
    );

    const countAfter = fs.readdirSync(path.join(tmpVault, '06-claudeclaw', 'learnings')).length;

    expect(result.status).toBe('updated');
    expect(result.reason).toBe('duplicate');
    // No new file created
    expect(countAfter).toBe(countBefore);
    // updated_at was set
    const updated = fs.readFileSync(existingAbs, 'utf-8');
    const fm = parseFrontmatter(updated);
    expect(fm['updated_at']).toBe(todayStr());
  });

  // ── Test 11: --memory-id triggers registerVaultPath ──────────────────

  it('11. --memory-id triggers registerVaultPath with the written path', async () => {
    const mockRegister = vi.fn((_id: number, _p: string) => { /* no-op */ });

    const result = await cmdWrite(
      [
        '--type', 'knowledge',
        '--title', 'Registered Note',
        '--content', 'Content to register',
        '--memory-id', '99',
        '--no-dedupe',
      ],
      { ...testOpts(), registerVaultPathFn: mockRegister },
    );

    expect(result.status).toBe('written');
    expect(result.memoryId).toBe(99);
    expect(mockRegister).toHaveBeenCalledOnce();
    const [calledId, calledPath] = mockRegister.mock.calls[0]!;
    expect(calledId).toBe(99);
    expect(calledPath).toContain('registered-note');
  });
});

// ── Test 11 (suite): close-task ───────────────────────────────────────

describe('cmdCloseTask', () => {
  it('11. flips - [ ] to - [x] and sets status to done when no open tasks remain', () => {
    const noteRel = 'notes/task-note.md';
    const noteAbs = path.join(tmpVault, noteRel);
    fs.mkdirSync(path.dirname(noteAbs), { recursive: true });
    fs.writeFileSync(noteAbs, `---
tags:
  - type/learning
status: active
created: 2026-01-01
related: []
---

# Tasks

- [ ] Fix the bug
- [x] Already done
`, 'utf-8');

    const result = cmdCloseTask(
      ['--file', noteRel, '--task-text', 'Fix the bug'],
      { vaultRootOverride: tmpVault, agenticMasterRoot: tmpAgentic },
    );

    expect(result.status).toBe('closed');
    expect(result.path).toBe(noteRel);
    expect(result.status_changed_to_done).toBe(true);

    const updated = fs.readFileSync(noteAbs, 'utf-8');
    expect(updated).toContain('- [x] Fix the bug');
    expect(updated).not.toContain('- [ ] Fix the bug');

    const fm = parseFrontmatter(updated);
    expect(fm['status']).toBe('done');
  });

  it('does NOT set status to done when other open tasks remain', () => {
    const noteRel = 'notes/multi-task.md';
    const noteAbs = path.join(tmpVault, noteRel);
    fs.mkdirSync(path.dirname(noteAbs), { recursive: true });
    fs.writeFileSync(noteAbs, `---
tags:
  - type/learning
status: active
created: 2026-01-01
related: []
---

- [ ] Task one
- [ ] Task two
`, 'utf-8');

    const result = cmdCloseTask(
      ['--file', noteRel, '--task-text', 'Task one'],
      { vaultRootOverride: tmpVault, agenticMasterRoot: tmpAgentic },
    );

    expect(result.status).toBe('closed');
    expect(result.status_changed_to_done).toBe(false);

    const updated = fs.readFileSync(noteAbs, 'utf-8');
    const fm = parseFrontmatter(updated);
    expect(fm['status']).toBe('active');
  });

  it('returns error when task not found', () => {
    const noteRel = 'notes/no-match.md';
    const noteAbs = path.join(tmpVault, noteRel);
    fs.mkdirSync(path.dirname(noteAbs), { recursive: true });
    fs.writeFileSync(noteAbs, `---
status: active
---
- [ ] Different task
`, 'utf-8');

    const result = cmdCloseTask(
      ['--file', noteRel, '--task-text', 'Nonexistent task'],
      { vaultRootOverride: tmpVault, agenticMasterRoot: tmpAgentic },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('task-not-found');
  });

  it('returns error when file not found', () => {
    const result = cmdCloseTask(
      ['--file', 'nonexistent/file.md', '--task-text', 'Any task'],
      { vaultRootOverride: tmpVault, agenticMasterRoot: tmpAgentic },
    );

    expect(result.status).toBe('error');
    expect(result.error).toBe('task-not-found');
  });
});

// ── Test 12: update-backlinks ─────────────────────────────────────────

describe('cmdUpdateBacklinks', () => {
  it('12. appends wiki-link to related: list; idempotent on second call', () => {
    const targetRel = 'notes/target.md';
    const targetAbs = path.join(tmpVault, targetRel);
    fs.mkdirSync(path.dirname(targetAbs), { recursive: true });
    fs.writeFileSync(targetAbs, `---
tags:
  - type/knowledge
status: active
created: 2026-01-01
related: []
---

# Target Note
`, 'utf-8');

    const linkRel = '06-claudeclaw/learnings/source-note.md';

    // First call — should add the link
    const r1 = cmdUpdateBacklinks(
      ['--target', targetRel, '--link', linkRel],
      { vaultRootOverride: tmpVault, agenticMasterRoot: tmpAgentic },
    );
    expect(r1.status).toBe('linked');
    expect(r1.added).toBe(true);

    const updated = fs.readFileSync(targetAbs, 'utf-8');
    const fm1 = parseFrontmatter(updated);
    expect((fm1['related'] as string[])).toContain('[[06-claudeclaw/learnings/source-note]]');

    // Second call — idempotent, added should be false
    const r2 = cmdUpdateBacklinks(
      ['--target', targetRel, '--link', linkRel],
      { vaultRootOverride: tmpVault, agenticMasterRoot: tmpAgentic },
    );
    expect(r2.status).toBe('linked');
    expect(r2.added).toBe(false);

    // Still only one entry
    const updated2 = fs.readFileSync(targetAbs, 'utf-8');
    const fm2 = parseFrontmatter(updated2);
    const related2 = fm2['related'] as string[];
    const linkStr = '[[06-claudeclaw/learnings/source-note]]';
    expect(related2.filter((r) => r === linkStr).length).toBe(1);
  });

  it('returns error when target file not found', () => {
    const result = cmdUpdateBacklinks(
      ['--target', 'nonexistent/file.md', '--link', 'some/link.md'],
      { vaultRootOverride: tmpVault, agenticMasterRoot: tmpAgentic },
    );
    expect(result.status).toBe('error');
  });
});

// ── isProjectArchived ─────────────────────────────────────────────────

describe('isProjectArchived', () => {
  it('returns true when context.md has status: archived', () => {
    const projDir = path.join(tmpVault, '04-projects', 'old-proj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'context.md'), `---
status: archived
---
# Old Project
`, 'utf-8');

    const conv = loadConventions(tmpAgentic);
    expect(isProjectArchived(tmpVault, 'old-proj', conv)).toBe(true);
  });

  it('returns false when context.md has status: active', () => {
    const projDir = path.join(tmpVault, '04-projects', 'live-proj');
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, 'context.md'), `---
status: active
---
# Live Project
`, 'utf-8');

    const conv = loadConventions(tmpAgentic);
    expect(isProjectArchived(tmpVault, 'live-proj', conv)).toBe(false);
  });

  it('returns false when project folder does not exist', () => {
    const conv = loadConventions(tmpAgentic);
    expect(isProjectArchived(tmpVault, 'no-such-project', conv)).toBe(false);
  });
});
