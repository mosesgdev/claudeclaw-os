import fs from 'fs';
import path from 'path';

import matter from 'gray-matter';

import { VAULT_PROJECTS_ROOT } from './config.js';
import { logger } from './logger.js';

export interface ProjectManifest {
  project: string;
  status: 'active' | 'archived';
  vaultRoot: string;
  memoryNamespace: string;
  discord: { category: string; primaryChannel: string; logsChannel: string };
  skills: string[];
  experts: string[];
  hooks: string[];
  systemPrompt: string;
  sourcePath: string;
}

/**
 * Parse a single context.md file into a ProjectManifest.
 *
 * Returns null (and logs a warning) if the file is malformed or missing
 * required fields. The caller decides whether to act on archived manifests;
 * this function returns them as-is.
 */
export function parseManifest(filePath: string): ProjectManifest | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    logger.warn({ filePath, err }, 'project-manifests: cannot read file');
    return null;
  }

  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch (err) {
    logger.warn({ filePath, err }, 'project-manifests: malformed YAML frontmatter');
    return null;
  }

  const data = parsed.data as Record<string, unknown>;

  // Validate required fields
  const missing: string[] = [];

  if (typeof data['project'] !== 'string' || !data['project']) missing.push('project');
  if (typeof data['status'] !== 'string' || !data['status']) missing.push('status');
  if (typeof data['vault_root'] !== 'string' || !data['vault_root']) missing.push('vault_root');
  if (typeof data['memory_namespace'] !== 'string' || !data['memory_namespace'])
    missing.push('memory_namespace');

  const discord = data['discord'] as Record<string, unknown> | undefined;
  if (!discord || typeof discord !== 'object') {
    missing.push('discord');
  } else {
    if (typeof discord['category'] !== 'string' || !discord['category'])
      missing.push('discord.category');
    if (typeof discord['primary_channel'] !== 'string' || !discord['primary_channel'])
      missing.push('discord.primary_channel');
  }

  if (missing.length > 0) {
    logger.warn(
      { filePath, missing },
      'project-manifests: skipping manifest with missing required fields',
    );
    return null;
  }

  return {
    project: data['project'] as string,
    status: data['status'] as 'active' | 'archived',
    vaultRoot: data['vault_root'] as string,
    memoryNamespace: data['memory_namespace'] as string,
    discord: {
      category: (discord as Record<string, unknown>)['category'] as string,
      primaryChannel: (discord as Record<string, unknown>)['primary_channel'] as string,
      logsChannel:
        typeof (discord as Record<string, unknown>)['logs_channel'] === 'string' &&
        (discord as Record<string, unknown>)['logs_channel']
          ? ((discord as Record<string, unknown>)['logs_channel'] as string)
          : 'logs',
    },
    skills: Array.isArray(data['skills']) ? (data['skills'] as string[]) : [],
    experts: Array.isArray(data['experts']) ? (data['experts'] as string[]) : [],
    hooks: Array.isArray(data['hooks']) ? (data['hooks'] as string[]) : [],
    systemPrompt: parsed.content.trim(),
    sourcePath: path.resolve(filePath),
  };
}

/**
 * Walk '<rootDir>/asterisk/context.md', parse each manifest, filter out nulls
 * and archived entries, and return the remaining active ProjectManifests.
 *
 * If rootDir is omitted, uses VAULT_PROJECTS_ROOT from config.
 * If the directory does not exist, returns [] with one info log.
 */
export function scanProjectManifests(rootDir?: string): ProjectManifest[] {
  const dir = rootDir ?? VAULT_PROJECTS_ROOT;

  if (!fs.existsSync(dir)) {
    logger.info({ dir }, 'project-manifests: projects root does not exist, returning empty list');
    return [];
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    logger.warn({ dir, err }, 'project-manifests: cannot read projects root directory');
    return [];
  }

  const manifests: ProjectManifest[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const contextPath = path.join(dir, entry.name, 'context.md');
    if (!fs.existsSync(contextPath)) continue;

    const manifest = parseManifest(contextPath);
    if (!manifest) continue;
    if (manifest.status === 'archived') continue;

    manifests.push(manifest);
  }

  return manifests;
}
