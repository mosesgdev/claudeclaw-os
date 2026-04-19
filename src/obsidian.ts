import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { logger } from './logger.js';
import { OBSIDIAN_WRITE_ENABLED } from './config.js';

export interface ObsidianConfig {
  vault: string;
  folders: string[];
  readOnly?: string[];
}

interface ObsidianNote {
  title: string;
  folder: string;
  openTasks: string[];
}

/** A knowledge/learning summary entry surfaced from the vault. */
interface ObsidianSummaryEntry {
  folder: string;
  filename: string;
  title: string;
  summary: string;
}

interface ObsidianCache {
  notes: ObsidianNote[];
  profile: string | null;
  knowledge: ObsidianSummaryEntry[];
  learnings: ObsidianSummaryEntry[];
}

let _cache: ObsidianCache = { notes: [], profile: null, knowledge: [], learnings: [] };
let _cacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

export function buildObsidianContext(config: ObsidianConfig | undefined): string {
  if (!config) return '';

  // Validate vault path exists on first cache build
  if (_cacheTime === 0 && !fs.existsSync(config.vault)) {
    logger.warn(
      { vault: config.vault },
      'Obsidian vault path does not exist. Check agent.yaml obsidian.vault setting. Obsidian integration is disabled.',
    );
    return '';
  }

  const now = Date.now();
  if (now - _cacheTime > CACHE_TTL_MS) {
    _cache = buildCache(config);
    _cacheTime = now;
  }

  return renderContext(_cache);
}

function buildCache(config: ObsidianConfig): ObsidianCache {
  const notes = scanFolders(config);
  let profile: string | null = null;
  let knowledge: ObsidianSummaryEntry[] = [];
  let learnings: ObsidianSummaryEntry[] = [];

  if (OBSIDIAN_WRITE_ENABLED) {
    profile = loadProfile(config.vault);
    knowledge = scanSummaryFolder(config.vault, '05-knowledge', 'type/knowledge');
    learnings = scanSummaryFolder(config.vault, '06-claudeclaw/learnings', 'type/learning');
  }

  return { notes, profile, knowledge, learnings };
}

function renderContext(cache: ObsidianCache): string {
  const sections: string[] = [];

  // Profile section (only when OBSIDIAN_WRITE_ENABLED and profile loaded)
  if (cache.profile !== null) {
    sections.push(`[Obsidian: profile]\n${cache.profile}\n[End profile]`);
  }

  // Active tasks section
  if (cache.notes.length > 0) {
    const taskLines: string[] = ['[Obsidian: active tasks]'];
    let currentFolder = '';
    for (const note of cache.notes) {
      if (note.folder !== currentFolder) {
        currentFolder = note.folder;
        taskLines.push(`  ${currentFolder}/`);
      }
      for (const task of note.openTasks) {
        taskLines.push(`    Open: ${task} (${note.title})`);
      }
    }
    taskLines.push('[End tasks]');
    sections.push(taskLines.join('\n'));
  }

  // Knowledge section
  if (cache.knowledge.length > 0) {
    const lines: string[] = ['[Obsidian: knowledge]', `  05-knowledge/`];
    for (const entry of cache.knowledge) {
      lines.push(`    - ${entry.title} — ${entry.summary}  (file: ${entry.filename})`);
    }
    lines.push('[End knowledge]');
    sections.push(lines.join('\n'));
  }

  // Learnings section
  if (cache.learnings.length > 0) {
    const lines: string[] = ['[Obsidian: learnings]', `  06-claudeclaw/learnings/`];
    for (const entry of cache.learnings) {
      lines.push(`    - ${entry.title} — ${entry.summary}  (file: ${entry.filename})`);
    }
    lines.push('[End learnings]');
    sections.push(lines.join('\n'));
  }

  if (sections.length === 0) return '';

  return sections.join('\n\n');
}

/** Load moses-profile.md content, capped at 2000 chars. Returns null if absent. */
function loadProfile(vaultRoot: string): string | null {
  const profilePath = path.join(vaultRoot, '00-inbox', 'moses-profile.md');
  if (!fs.existsSync(profilePath)) return null;
  try {
    const raw = fs.readFileSync(profilePath, 'utf-8');
    return raw.length > 2000 ? raw.slice(0, 2000) : raw;
  } catch {
    return null;
  }
}

/**
 * Scan a vault subfolder for files with status:active and the expected type tag.
 * Returns the 20 most-recently-modified entries, each with H1 title + first paragraph.
 */
function scanSummaryFolder(
  vaultRoot: string,
  folderRel: string,
  requiredTag: string,
): ObsidianSummaryEntry[] {
  const folderPath = path.join(vaultRoot, folderRel);
  if (!fs.existsSync(folderPath)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(folderPath, { withFileTypes: true });
  } catch {
    return [];
  }

  // Collect md files with their mtime
  const files: { name: string; mtime: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    try {
      const stat = fs.statSync(path.join(folderPath, entry.name));
      files.push({ name: entry.name, mtime: stat.mtimeMs });
    } catch {
      // skip unreadable
    }
  }

  // Sort by most-recently-modified descending, cap at 20
  files.sort((a, b) => b.mtime - a.mtime);
  const top20 = files.slice(0, 20);

  const results: ObsidianSummaryEntry[] = [];

  for (const file of top20) {
    const filePath = path.join(folderPath, file.name);
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    // Parse frontmatter via gray-matter
    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch {
      continue;
    }

    const fm = parsed.data as Record<string, unknown>;

    // Filter: status must be 'active'
    if (fm['status'] !== 'active') continue;

    // Filter: tags must include requiredTag
    const tags = normaliseTags(fm['tags']);
    if (!tags.includes(requiredTag)) continue;

    const { title, summary } = extractTitleAndSummary(parsed.content, file.name);

    results.push({
      folder: folderRel,
      filename: file.name,
      title,
      summary,
    });
  }

  return results;
}

/** Normalise frontmatter tags field to a flat string array. */
function normaliseTags(raw: unknown): string[] {
  if (!raw) return [];
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw)) return raw.map(String);
  return [];
}

/**
 * Extract the first H1 heading and the first non-empty paragraph from markdown body.
 * Falls back to filename (without extension) as title when no H1 found.
 * Summary is capped at 200 chars.
 */
export function extractTitleAndSummary(
  body: string,
  filename: string,
): { title: string; summary: string } {
  const lines = body.split('\n');

  let title: string | null = null;
  let summaryLines: string[] = [];
  let pastTitle = false;
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!pastTitle) {
      const h1 = trimmed.match(/^#\s+(.+)/);
      if (h1) {
        title = h1[1].trim();
        pastTitle = true;
        continue;
      }
    }

    if (pastTitle || title === null) {
      // Skip blank lines before paragraph starts
      if (!inParagraph && trimmed === '') continue;
      // Stop collecting at next heading or blank line after content
      if (trimmed.startsWith('#')) break;
      if (trimmed === '' && inParagraph) break;
      if (trimmed !== '') {
        inParagraph = true;
        summaryLines.push(trimmed);
      }
    }
  }

  const rawTitle = title ?? filename.replace(/\.md$/, '');
  const rawSummary = summaryLines.join(' ');
  const summary = rawSummary.length > 200 ? rawSummary.slice(0, 200) : rawSummary;

  return { title: rawTitle, summary };
}

function scanFolders(config: ObsidianConfig): ObsidianNote[] {
  const allFolders = [...config.folders, ...(config.readOnly ?? [])];
  const notes: ObsidianNote[] = [];

  for (const folder of allFolders) {
    const folderPath = path.join(config.vault, folder);
    if (!fs.existsSync(folderPath)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

      const filePath = path.join(folderPath, entry.name);
      let content: string;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }

      // Skip notes tagged as done
      if (/^status:\s*done/mi.test(content)) continue;

      // Extract open tasks: lines matching - [ ]
      const openTasks: string[] = [];
      for (const line of content.split('\n')) {
        const match = line.match(/^-\s+\[\s\]\s+(.+)/);
        if (match) {
          openTasks.push(match[1].trim());
        }
      }

      if (openTasks.length > 0) {
        const title = entry.name.replace(/\.md$/, '');
        notes.push({ title, folder, openTasks });
      }
    }
  }

  return notes;
}

/** Reset cache (for testing). */
export function _resetObsidianCache(): void {
  _cache = { notes: [], profile: null, knowledge: [], learnings: [] };
  _cacheTime = 0;
}
