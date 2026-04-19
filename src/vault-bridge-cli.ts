#!/usr/bin/env node
/**
 * vault-bridge-cli.ts — RFC 2c vault write bridge
 *
 * Usage:
 *   node dist/vault-bridge-cli.js write --type <type> --title "<title>" --content "<text>"
 *       [--project <name>] [--agent-id <id>] [--importance <0..1>]
 *       [--source <vault|memory-mirror|consolidation>] [--topics "a,b,c"]
 *       [--no-dedupe] [--chat-id <id>] [--memory-id <n>] [--content-file <path>]
 *       [--vault-root <path>]
 *
 *   node dist/vault-bridge-cli.js close-task
 *       --file "<vault-relative-path>" --task-text "<exact text>"
 *       [--vault-root <path>]
 *
 *   node dist/vault-bridge-cli.js update-backlinks
 *       --target "<vault-relative-path>" --link "<vault-relative-path>"
 *       [--vault-root <path>]
 *
 * All output is newline-terminated JSON on stdout. Exit 0 on success, 1 on error.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import yaml from 'js-yaml';

import { expandHome, AGENTIC_MASTER_ROOT, PROJECT_ROOT } from './config.js';
import { logger } from './logger.js';

// ── Types ─────────────────────────────────────────────────────────────

export type NoteType = 'session' | 'learning' | 'reflection' | 'knowledge' | 'project-context';
export type NoteSource = 'vault' | 'memory-mirror' | 'consolidation';

export interface VaultConventions {
  vault_root: string;
  folders: {
    sessions: string;
    learnings: string;
    reflections: string;
    knowledge: string;
    project: string;
    agent_scoped: string;
  };
  filename_patterns: {
    session: string;
    learning: string;
    reflection: string;
    knowledge: string;
    context: string;
  };
  dedupe_cosine_threshold: number;
  importance_mirror_threshold: number;
}

export interface WriteResult {
  status: 'written' | 'updated' | 'skipped' | 'error';
  path?: string;
  memoryId?: number;
  reason?: string;
  error?: string;
}

export interface CloseTaskResult {
  status: 'closed' | 'error';
  path?: string;
  status_changed_to_done?: boolean;
  error?: string;
}

export interface UpdateBacklinksResult {
  status: 'linked' | 'error';
  target?: string;
  added?: boolean;
  error?: string;
}

// ── Hardcoded defaults ────────────────────────────────────────────────

const DEFAULT_CONVENTIONS: VaultConventions = {
  vault_root: '~/Documents/Obsidian/ClaudeClaw',
  folders: {
    sessions: '06-claudeclaw/sessions/',
    learnings: '06-claudeclaw/learnings/',
    reflections: '06-claudeclaw/reflections/',
    knowledge: '05-knowledge/',
    project: '04-projects/',
    agent_scoped: '06-claudeclaw/agents/{agent_id}/',
  },
  filename_patterns: {
    session: '{YYYY-MM-DD}-{slug}.md',
    learning: '{slug}.md',
    reflection: '{YYYY-MM-DD}-{slug}.md',
    knowledge: '{slug}.md',
    context: 'context.md',
  },
  dedupe_cosine_threshold: 0.85,
  importance_mirror_threshold: 0.7,
};

// ── Inline fallback templates ─────────────────────────────────────────

const INLINE_TEMPLATES: Record<NoteType, string> = {
  session: `---
tags:
  - type/session
status: active
created: {YYYY-MM-DD}
related: []
---

# {title}

{content}
`,
  learning: `---
tags:
  - type/learning
status: active
created: {YYYY-MM-DD}
related: []
---

# {title}

{content}
`,
  reflection: `---
tags:
  - type/reflection
status: active
created: {YYYY-MM-DD}
related: []
---

# {title}

{content}
`,
  knowledge: `---
tags:
  - type/knowledge
status: active
created: {YYYY-MM-DD}
related: []
---

# {title}

{content}
`,
  'project-context': `---
tags:
  - type/project-context
status: active
created: {YYYY-MM-DD}
related: []
---

# {title}

{content}
`,
};

// ── Helpers ───────────────────────────────────────────────────────────

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function die(data: unknown, code = 1): never {
  printJson(data);
  process.exit(code);
}

/** Slugify a title: lowercase, hyphens for spaces, strip non-[a-z0-9-], cap at 80 chars. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

/** Return today's date as YYYY-MM-DD. */
export function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Read obsidian-vault.yaml from agentic-master; fall back to defaults on error. */
export function loadConventions(agenticMasterRoot?: string): VaultConventions {
  const root = agenticMasterRoot ?? AGENTIC_MASTER_ROOT;
  const yamlPath = path.join(root, 'expertise', 'obsidian-vault.yaml');
  try {
    const raw = yaml.load(fs.readFileSync(yamlPath, 'utf-8')) as Partial<VaultConventions>;
    return {
      vault_root: raw.vault_root ?? DEFAULT_CONVENTIONS.vault_root,
      folders: { ...DEFAULT_CONVENTIONS.folders, ...raw.folders },
      filename_patterns: { ...DEFAULT_CONVENTIONS.filename_patterns, ...raw.filename_patterns },
      dedupe_cosine_threshold: raw.dedupe_cosine_threshold ?? DEFAULT_CONVENTIONS.dedupe_cosine_threshold,
      importance_mirror_threshold: raw.importance_mirror_threshold ?? DEFAULT_CONVENTIONS.importance_mirror_threshold,
    };
  } catch {
    logger.warn({ yamlPath }, 'obsidian-vault.yaml not found; using hardcoded defaults');
    return DEFAULT_CONVENTIONS;
  }
}

/** Resolve the vault root: env override > VAULT_ROOT env > conventions. */
export function resolveVaultRoot(conventions: VaultConventions, override?: string): string {
  if (override) return override;
  const envRoot = process.env['VAULT_ROOT'];
  if (envRoot) return envRoot;
  return expandHome(conventions.vault_root);
}

/** Return an absolute path for a vault-relative path. */
export function vaultAbs(vaultRoot: string, rel: string): string {
  return path.join(vaultRoot, rel);
}

/**
 * Atomic write: write to <path>.tmp then rename to <path>.
 * Creates parent directories as needed.
 */
export function atomicWrite(targetPath: string, content: string): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmp = targetPath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, targetPath);
}

/** Resolve a unique file path, suffixing -2, -3, … if necessary. */
function uniquePath(base: string, ext: string, dir: string): string {
  let candidate = path.join(dir, base + ext);
  if (!fs.existsSync(candidate)) return candidate;
  let i = 2;
  while (true) {
    candidate = path.join(dir, `${base}-${i}${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
    i++;
  }
}

/** Parse simple frontmatter from a markdown file (YAML block between ---). */
export function parseFrontmatter(content: string): Record<string, unknown> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  try {
    return (yaml.load(match[1]) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

/** Replace frontmatter block in a markdown file with new YAML. */
function replaceFrontmatter(content: string, fm: Record<string, unknown>): string {
  const newFm = '---\n' + yaml.dump(fm, { lineWidth: -1 }).trimEnd() + '\n---';
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---/);
  if (!match) return newFm + '\n' + content;
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---/, newFm);
}

/**
 * Check if a project is archived by reading its context.md frontmatter status field.
 * Only inspects `status` — avoids requiring a full RFC 1 manifest, since a project
 * folder might exist with a minimal context.md (status only) and still be archived.
 * Returns true if status === 'archived', false otherwise.
 * Never throws — returns false on any error.
 */
export function isProjectArchived(vaultRoot: string, projectName: string, conventions: VaultConventions): boolean {
  const contextPath = path.join(vaultRoot, conventions.folders.project, projectName, 'context.md');
  if (!fs.existsSync(contextPath)) return false;
  try {
    const raw = fs.readFileSync(contextPath, 'utf-8');
    const fm = parseFrontmatter(raw);
    return fm['status'] === 'archived';
  } catch {
    return false;
  }
}

/** Load a template for a given type from vault _meta/templates/ or inline fallback. */
export function loadTemplate(vaultRoot: string, type: NoteType): string {
  const tplPath = path.join(vaultRoot, '_meta', 'templates', `${type}.md`);
  if (fs.existsSync(tplPath)) {
    try {
      return fs.readFileSync(tplPath, 'utf-8');
    } catch {
      // fall through to inline
    }
  }
  return INLINE_TEMPLATES[type];
}

/**
 * Shell out to memory-dedupe-cli to check for duplicates.
 * Returns the parsed JSON result or null if the CLI is unavailable or fails.
 */
export function dedupeCheck(
  text: string,
  chatId: string,
  threshold: number,
): { duplicate: false } | { duplicate: true; existingId: number; vaultPath?: string } | null {
  const cliPath = path.join(PROJECT_ROOT, 'dist', 'memory-dedupe-cli.js');
  if (!fs.existsSync(cliPath)) return null;
  try {
    const escaped = text.replace(/"/g, '\\"').replace(/`/g, '\\`');
    const cmd = `node "${cliPath}" check --text "${escaped}" --chat-id "${chatId}" --threshold ${threshold}`;
    const out = execSync(cmd, { timeout: 15000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out.trim()) as Record<string, unknown>;
    if (parsed['error'] === 'no_embedding_key') {
      logger.warn('memory-dedupe-cli: no embedding key; skipping dedupe');
      return null;
    }
    if (parsed['duplicate'] === true) {
      return {
        duplicate: true,
        existingId: parsed['existingId'] as number,
        vaultPath: parsed['vaultPath'] as string | undefined,
      };
    }
    return { duplicate: false };
  } catch (err) {
    logger.warn({ err }, 'memory-dedupe-cli unavailable; skipping dedupe');
    return null;
  }
}

/**
 * Shell out to memory-dedupe-cli neighbors to get wiki-link suggestions.
 * Returns an array of vault paths (at most cap). Returns [] on failure.
 */
export function fetchNeighbors(topics: string[], limit: number): string[] {
  if (topics.length === 0) return [];
  const cliPath = path.join(PROJECT_ROOT, 'dist', 'memory-dedupe-cli.js');
  if (!fs.existsSync(cliPath)) return [];
  try {
    const topicsStr = topics.join(',');
    const cmd = `node "${cliPath}" neighbors --topics "${topicsStr}" --limit ${limit}`;
    const out = execSync(cmd, { timeout: 10000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const parsed = JSON.parse(out.trim()) as Array<{ vaultPath?: string }>;
    return parsed
      .map((r) => r.vaultPath)
      .filter((p): p is string => Boolean(p))
      .slice(0, 5);
  } catch {
    return [];
  }
}

/**
 * Shell out to memory-dedupe-cli set-vault-path.
 * Fire-and-forget: never throws.
 */
export function registerVaultPath(memoryId: number, vaultRelPath: string): void {
  const cliPath = path.join(PROJECT_ROOT, 'dist', 'memory-dedupe-cli.js');
  if (!fs.existsSync(cliPath)) return;
  try {
    const cmd = `node "${cliPath}" set-vault-path --id ${memoryId} --path "${vaultRelPath}"`;
    execSync(cmd, { timeout: 10000, stdio: 'ignore' });
  } catch (err) {
    logger.warn({ err, memoryId, vaultRelPath }, 'vault-bridge: set-vault-path failed (non-fatal)');
  }
}

/** Build the frontmatter object for a new note. */
function buildFrontmatter(opts: {
  type: NoteType;
  project?: string;
  agentId?: string;
  importance?: number;
  source?: NoteSource;
  extraRelated?: string[];
}): Record<string, unknown> {
  const tags: string[] = [`type/${opts.type}`];
  if (opts.project) tags.push(`project/${opts.project}`);
  if (opts.agentId) tags.push(`agent/${opts.agentId}`);

  const related: string[] = [];
  if (opts.project) {
    related.push(`[[04-projects/${opts.project}/context]]`);
  }
  if (opts.extraRelated) {
    for (const r of opts.extraRelated) {
      const slug = r.replace(/\.md$/, '');
      const link = `[[${slug}]]`;
      if (!related.includes(link)) related.push(link);
    }
  }

  const fm: Record<string, unknown> = {
    tags,
    status: 'active',
    created: todayStr(),
    related,
  };

  if (opts.importance !== undefined) fm['importance'] = opts.importance;
  if (opts.source) fm['source'] = opts.source;

  return fm;
}

/** Render a template string with given values. */
function renderTemplate(
  template: string,
  fm: Record<string, unknown>,
  title: string,
  content: string,
  relatedLinks: string[],
): string {
  const fmYaml = yaml.dump(fm, { lineWidth: -1 }).trimEnd();
  const fmBlock = '---\n' + fmYaml + '\n---';
  const date = todayStr();

  // Replace template placeholders with actual values
  let body = template
    .replace(/---[\s\S]*?---/, fmBlock)  // replace frontmatter block
    .replace(/\{YYYY-MM-DD\}/g, date)
    .replace(/\{title\}/g, title)
    .replace(/\{content\}/g, content);

  // Ensure content is present if template doesn't include {content}
  if (!body.includes(content) && content) {
    body = body.trimEnd() + '\n\n' + content + '\n';
  }

  // Inject wiki-links as ## Related section if we have neighbors
  if (relatedLinks.length > 0) {
    const relSection = '\n\n## Related\n\n' + relatedLinks.map((l) => `- [[${l.replace(/\.md$/, '')}]]`).join('\n');
    if (!body.includes('## Related')) {
      body = body.trimEnd() + relSection + '\n';
    }
  }

  return body;
}

// ── Subcommand: write ─────────────────────────────────────────────────

export async function cmdWrite(
  argv: string[],
  opts?: {
    // For testing: override the dedupe/neighbors functions
    dedupeCheckFn?: typeof dedupeCheck;
    fetchNeighborsFn?: typeof fetchNeighbors;
    registerVaultPathFn?: typeof registerVaultPath;
    agenticMasterRoot?: string;
    vaultRootOverride?: string;
  },
): Promise<WriteResult> {
  const type = parseFlag(argv, '--type') as NoteType | undefined;
  const title = parseFlag(argv, '--title');
  const contentArg = parseFlag(argv, '--content');
  const contentFile = parseFlag(argv, '--content-file');
  const project = parseFlag(argv, '--project');
  const agentId = parseFlag(argv, '--agent-id');
  const importanceStr = parseFlag(argv, '--importance');
  const source = (parseFlag(argv, '--source') ?? 'vault') as NoteSource;
  const topicsStr = parseFlag(argv, '--topics') ?? '';
  const noDedupe = hasFlag(argv, '--no-dedupe');
  const chatId = parseFlag(argv, '--chat-id') ?? 'vault-bridge';
  const memoryIdStr = parseFlag(argv, '--memory-id');
  const vaultRootArg = parseFlag(argv, '--vault-root');

  if (!type) return { status: 'error', error: '--type is required' };
  if (!title) return { status: 'error', error: '--title is required' };

  const validTypes: NoteType[] = ['session', 'learning', 'reflection', 'knowledge', 'project-context'];
  if (!validTypes.includes(type)) {
    return { status: 'error', error: `invalid --type; must be one of: ${validTypes.join(', ')}` };
  }
  if (type === 'project-context' && !project) {
    return { status: 'error', error: '--project is required when --type is project-context' };
  }

  let content: string;
  if (contentFile) {
    try {
      content = fs.readFileSync(contentFile, 'utf-8');
    } catch (err) {
      return { status: 'error', error: `cannot read --content-file: ${String(err)}` };
    }
  } else if (contentArg !== undefined) {
    content = contentArg;
  } else {
    return { status: 'error', error: '--content or --content-file is required' };
  }

  const importance = importanceStr !== undefined ? parseFloat(importanceStr) : undefined;
  const topics = topicsStr.split(',').map((t) => t.trim()).filter(Boolean);

  const conventions = loadConventions(opts?.agenticMasterRoot);
  const vaultRoot = opts?.vaultRootOverride ?? resolveVaultRoot(conventions, vaultRootArg);

  // Check archived project
  if (type === 'project-context' && project) {
    if (isProjectArchived(vaultRoot, project, conventions)) {
      return { status: 'skipped', reason: 'archived-project' };
    }
  }

  // Dedupe check (skip for project-context and session types — they are canonical/log)
  const dedupeFn = opts?.dedupeCheckFn ?? dedupeCheck;
  if (!noDedupe && (type === 'learning' || type === 'reflection' || type === 'knowledge')) {
    const dedupeResult = dedupeFn(content, chatId, conventions.dedupe_cosine_threshold);
    if (dedupeResult?.duplicate === true) {
      // Merge: update existing file's frontmatter
      if (dedupeResult.vaultPath) {
        const existingAbs = vaultAbs(vaultRoot, dedupeResult.vaultPath);
        if (fs.existsSync(existingAbs)) {
          try {
            const existingContent = fs.readFileSync(existingAbs, 'utf-8');
            const existingFm = parseFrontmatter(existingContent);
            const existingTags = (existingFm['tags'] as string[]) ?? [];
            const newTags = topics.map((t) => `topic/${t}`);
            for (const tag of newTags) {
              if (!existingTags.includes(tag)) existingTags.push(tag);
            }
            existingFm['tags'] = existingTags;
            existingFm['updated_at'] = todayStr();
            const updated = replaceFrontmatter(existingContent, existingFm);
            atomicWrite(existingAbs, updated);
          } catch (err) {
            logger.warn({ err }, 'vault-bridge: failed to merge into existing file');
          }
          return { status: 'updated', path: dedupeResult.vaultPath, reason: 'duplicate' };
        }
      }
      return { status: 'updated', reason: 'duplicate' };
    }
  }

  // Resolve target path
  let targetDir: string;
  let filename: string;
  let relativeDir: string;

  if (type === 'project-context') {
    relativeDir = path.join(conventions.folders.project, project!);
    targetDir = path.join(vaultRoot, relativeDir);
    filename = 'context.md';
  } else if (type === 'session' && agentId) {
    const agentFolder = conventions.folders.agent_scoped.replace('{agent_id}', agentId);
    relativeDir = path.join(agentFolder, 'sessions');
    targetDir = path.join(vaultRoot, relativeDir);
    filename = `${todayStr()}-${slugify(title)}.md`;
  } else if (type === 'session') {
    relativeDir = conventions.folders.sessions;
    targetDir = path.join(vaultRoot, relativeDir);
    filename = `${todayStr()}-${slugify(title)}.md`;
  } else if (type === 'learning') {
    relativeDir = conventions.folders.learnings;
    targetDir = path.join(vaultRoot, relativeDir);
    filename = `${slugify(title)}.md`;
  } else if (type === 'reflection') {
    relativeDir = conventions.folders.reflections;
    targetDir = path.join(vaultRoot, relativeDir);
    filename = `${todayStr()}-${slugify(title)}.md`;
  } else {
    // knowledge
    relativeDir = conventions.folders.knowledge;
    targetDir = path.join(vaultRoot, relativeDir);
    filename = `${slugify(title)}.md`;
  }

  // For project-context: if file exists, merge content rather than create new
  if (type === 'project-context') {
    const targetAbs = path.join(targetDir, filename);
    if (fs.existsSync(targetAbs)) {
      // Append new content to existing file
      const existing = fs.readFileSync(targetAbs, 'utf-8');
      const existingFm = parseFrontmatter(existing);
      existingFm['updated_at'] = todayStr();
      const updated = replaceFrontmatter(existing, existingFm).trimEnd() + '\n\n' + content + '\n';
      atomicWrite(targetAbs, updated);
      const relPath = path.join(relativeDir, filename);
      return { status: 'updated', path: relPath };
    }
  }

  // Slug collision avoidance (not for context.md which is canonical)
  let targetAbs: string;
  let relPath: string;
  if (type === 'project-context') {
    targetAbs = path.join(targetDir, filename);
    relPath = path.join(relativeDir, filename);
  } else {
    const slug = filename.replace(/\.md$/, '');
    // For dated slugs, extract base + date prefix
    const fullBase = filename.replace(/\.md$/, '');
    if (fs.existsSync(path.join(targetDir, filename))) {
      let i = 2;
      let candidate = path.join(targetDir, `${fullBase}-${i}.md`);
      while (fs.existsSync(candidate)) {
        i++;
        candidate = path.join(targetDir, `${fullBase}-${i}.md`);
      }
      targetAbs = candidate;
      relPath = path.join(relativeDir, `${fullBase}-${i}.md`);
    } else {
      targetAbs = path.join(targetDir, filename);
      relPath = path.join(relativeDir, filename);
      void slug; // used implicitly via filename
    }
  }

  // Fetch wiki-link neighbors
  const neighborFn = opts?.fetchNeighborsFn ?? fetchNeighbors;
  const neighborPaths = neighborFn(topics, 3);

  // Build frontmatter
  const fm = buildFrontmatter({
    type,
    project,
    agentId,
    importance,
    source,
    extraRelated: neighborPaths,
  });

  // Load template and render
  const template = loadTemplate(vaultRoot, type);
  const renderedContent = renderTemplate(template, fm, title, content, neighborPaths);

  // Atomic write
  atomicWrite(targetAbs, renderedContent);

  // Register vault path if memory-id provided
  const memoryId = memoryIdStr !== undefined ? parseInt(memoryIdStr, 10) : undefined;
  if (memoryId !== undefined && !isNaN(memoryId)) {
    const registerFn = opts?.registerVaultPathFn ?? registerVaultPath;
    registerFn(memoryId, relPath);
  }

  return {
    status: 'written',
    path: relPath,
    ...(memoryId !== undefined ? { memoryId } : {}),
  };
}

// ── Subcommand: close-task ────────────────────────────────────────────

export function cmdCloseTask(
  argv: string[],
  opts?: { vaultRootOverride?: string; agenticMasterRoot?: string },
): CloseTaskResult {
  const fileRel = parseFlag(argv, '--file');
  const taskText = parseFlag(argv, '--task-text');
  const vaultRootArg = parseFlag(argv, '--vault-root');

  if (!fileRel) return { status: 'error', error: '--file is required' };
  if (!taskText) return { status: 'error', error: '--task-text is required' };

  const conventions = loadConventions(opts?.agenticMasterRoot);
  const vaultRoot = opts?.vaultRootOverride ?? resolveVaultRoot(conventions, vaultRootArg);
  const targetAbs = vaultAbs(vaultRoot, fileRel);

  if (!fs.existsSync(targetAbs)) {
    return { status: 'error', error: 'task-not-found' };
  }

  let content = fs.readFileSync(targetAbs, 'utf-8');
  const openMarker = `- [ ] ${taskText.trim()}`;
  const closedMarker = `- [x] ${taskText.trim()}`;

  if (!content.includes(openMarker)) {
    return { status: 'error', error: 'task-not-found' };
  }

  content = content.replace(openMarker, closedMarker);

  // Check if any open tasks remain
  const hasOpenTasks = /- \[ \] .+/.test(content);

  let statusChangedToDone = false;
  if (!hasOpenTasks) {
    const fm = parseFrontmatter(content);
    if (fm['status'] !== 'done') {
      fm['status'] = 'done';
      content = replaceFrontmatter(content, fm);
      statusChangedToDone = true;
    }
  }

  atomicWrite(targetAbs, content);

  return {
    status: 'closed',
    path: fileRel,
    status_changed_to_done: statusChangedToDone,
  };
}

// ── Subcommand: update-backlinks ──────────────────────────────────────

export function cmdUpdateBacklinks(
  argv: string[],
  opts?: { vaultRootOverride?: string; agenticMasterRoot?: string },
): UpdateBacklinksResult {
  const targetRel = parseFlag(argv, '--target');
  const linkRel = parseFlag(argv, '--link');
  const vaultRootArg = parseFlag(argv, '--vault-root');

  if (!targetRel) return { status: 'error', error: '--target is required' };
  if (!linkRel) return { status: 'error', error: '--link is required' };

  const conventions = loadConventions(opts?.agenticMasterRoot);
  const vaultRoot = opts?.vaultRootOverride ?? resolveVaultRoot(conventions, vaultRootArg);
  const targetAbs = vaultAbs(vaultRoot, targetRel);

  if (!fs.existsSync(targetAbs)) {
    return { status: 'error', error: `target file not found: ${targetRel}` };
  }

  const content = fs.readFileSync(targetAbs, 'utf-8');
  const fm = parseFrontmatter(content);
  const related = (fm['related'] as string[]) ?? [];

  const slug = linkRel.replace(/\.md$/, '');
  const wikiLink = `[[${slug}]]`;

  if (related.includes(wikiLink)) {
    // Already present — idempotent
    atomicWrite(targetAbs, content); // still do atomic write to ensure consistency
    return { status: 'linked', target: targetRel, added: false };
  }

  related.push(wikiLink);
  fm['related'] = related;
  const updated = replaceFrontmatter(content, fm);

  atomicWrite(targetAbs, updated);

  return { status: 'linked', target: targetRel, added: true };
}

// ── Main ──────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  switch (command) {
    case 'write': {
      const result = await cmdWrite(rest);
      printJson(result);
      if (result.status === 'error') process.exit(1);
      break;
    }

    case 'close-task': {
      const result = cmdCloseTask(rest);
      printJson(result);
      if (result.status === 'error') process.exit(1);
      break;
    }

    case 'update-backlinks': {
      const result = cmdUpdateBacklinks(rest);
      printJson(result);
      if (result.status === 'error') process.exit(1);
      break;
    }

    default: {
      const msg = [
        'Usage:',
        '  vault-bridge-cli write --type <type> --title "<title>" --content "<text>" [options]',
        '  vault-bridge-cli close-task --file "<path>" --task-text "<text>"',
        '  vault-bridge-cli update-backlinks --target "<path>" --link "<path>"',
        '',
        'Types: session | learning | reflection | knowledge | project-context',
      ].join('\n');
      process.stderr.write(msg + '\n');
      process.exit(1);
    }
  }
}

// Only run when invoked directly (not when imported in tests)
if (process.argv[1] && process.argv[1].endsWith('vault-bridge-cli.js')) {
  main().catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
