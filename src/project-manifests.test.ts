import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { parseManifest, scanProjectManifests } from './project-manifests.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDir = path.join(os.tmpdir(), `project-manifests-test-${Date.now()}`);

function mkProject(name: string, content: string): string {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const contextPath = path.join(dir, 'context.md');
  fs.writeFileSync(contextPath, content);
  return contextPath;
}

const VALID_FRONTMATTER = `---
project: archisell
status: active
vault_root: 04-projects/archisell
memory_namespace: archisell
discord:
  category: archisell
  primary_channel: pm-archisell
skills:
  - gmail
  - obsidian-write
experts:
  - archisell-domain
hooks: []
---

# Archisell — Project Context

This is the body of the system prompt.
`;

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseManifest
// ---------------------------------------------------------------------------

describe('parseManifest', () => {
  it('parses a well-formed context.md with all fields and body', () => {
    const filePath = mkProject('archisell', VALID_FRONTMATTER);
    const manifest = parseManifest(filePath);

    expect(manifest).not.toBeNull();
    expect(manifest!.project).toBe('archisell');
    expect(manifest!.status).toBe('active');
    expect(manifest!.vaultRoot).toBe('04-projects/archisell');
    expect(manifest!.memoryNamespace).toBe('archisell');
    expect(manifest!.discord.category).toBe('archisell');
    expect(manifest!.discord.primaryChannel).toBe('pm-archisell');
    expect(manifest!.skills).toEqual(['gmail', 'obsidian-write']);
    expect(manifest!.experts).toEqual(['archisell-domain']);
    expect(manifest!.hooks).toEqual([]);
    expect(manifest!.systemPrompt).toContain('Archisell — Project Context');
    expect(manifest!.systemPrompt).toContain('This is the body of the system prompt.');
    expect(manifest!.sourcePath).toBe(path.resolve(filePath));
  });

  it('returns archived manifest (caller decides whether to skip)', () => {
    const content = VALID_FRONTMATTER.replace('status: active', 'status: archived');
    const filePath = mkProject('archived-proj', content);
    const manifest = parseManifest(filePath);

    expect(manifest).not.toBeNull();
    expect(manifest!.status).toBe('archived');
  });

  it('returns null when discord.category is missing and logs a warning', () => {
    const content = `---
project: nocategory
status: active
vault_root: 04-projects/nocategory
memory_namespace: nocategory
discord:
  primary_channel: pm-nocategory
---

Body here.
`;
    const filePath = mkProject('nocategory', content);
    const manifest = parseManifest(filePath);
    expect(manifest).toBeNull();
  });

  it('returns null when discord block is entirely missing', () => {
    const content = `---
project: nodiscord
status: active
vault_root: 04-projects/nodiscord
memory_namespace: nodiscord
---

Body here.
`;
    const filePath = mkProject('nodiscord', content);
    const manifest = parseManifest(filePath);
    expect(manifest).toBeNull();
  });

  it('returns null when project field is missing', () => {
    const content = `---
status: active
vault_root: 04-projects/x
memory_namespace: x
discord:
  category: x
  primary_channel: pm-x
---

Body.
`;
    const filePath = mkProject('noproj', content);
    expect(parseManifest(filePath)).toBeNull();
  });

  it('returns null on malformed YAML frontmatter', () => {
    const content = `---
project: broken
status: active
vault_root: [unclosed bracket
---

Body.
`;
    const filePath = mkProject('malformed', content);
    expect(parseManifest(filePath)).toBeNull();
  });

  it('parses explicit logs_channel from frontmatter', () => {
    const content = `---
project: archisell
status: active
vault_root: 04-projects/archisell
memory_namespace: archisell
discord:
  category: archisell
  primary_channel: pm-archisell
  logs_channel: custom-logs
---
Body.
`;
    const filePath = mkProject('explicit-logs', content);
    const manifest = parseManifest(filePath);

    expect(manifest).not.toBeNull();
    expect(manifest!.discord.logsChannel).toBe('custom-logs');
  });

  it('defaults logsChannel to "logs" when logs_channel is omitted', () => {
    const filePath = mkProject('default-logs', VALID_FRONTMATTER);
    const manifest = parseManifest(filePath);

    expect(manifest).not.toBeNull();
    expect(manifest!.discord.logsChannel).toBe('logs');
  });

  it('defaults skills, experts, hooks to empty arrays when omitted', () => {
    const content = `---
project: minimal
status: active
vault_root: 04-projects/minimal
memory_namespace: minimal
discord:
  category: minimal
  primary_channel: pm-minimal
---
`;
    const filePath = mkProject('minimal', content);
    const manifest = parseManifest(filePath);

    expect(manifest).not.toBeNull();
    expect(manifest!.skills).toEqual([]);
    expect(manifest!.experts).toEqual([]);
    expect(manifest!.hooks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scanProjectManifests
// ---------------------------------------------------------------------------

describe('scanProjectManifests', () => {
  it('returns [] when the projects root does not exist', () => {
    const missing = path.join(tmpDir, 'nonexistent');
    expect(scanProjectManifests(missing)).toEqual([]);
  });

  it('returns [] when the projects root is empty', () => {
    expect(scanProjectManifests(tmpDir)).toEqual([]);
  });

  it('skips a project folder that has no context.md', () => {
    fs.mkdirSync(path.join(tmpDir, 'nocontext'));
    expect(scanProjectManifests(tmpDir)).toEqual([]);
  });

  it('filters out archived manifests', () => {
    const content = VALID_FRONTMATTER.replace('status: active', 'status: archived');
    mkProject('archived-only', content);
    expect(scanProjectManifests(tmpDir)).toEqual([]);
  });

  it('returns valid active manifests and ignores archived + malformed', () => {
    // Two valid active projects
    mkProject('alpha', VALID_FRONTMATTER.replace('project: archisell', 'project: alpha')
      .replace('vault_root: 04-projects/archisell', 'vault_root: 04-projects/alpha')
      .replace('memory_namespace: archisell', 'memory_namespace: alpha')
      .replace(/category: archisell/, 'category: alpha')
      .replace(/primary_channel: pm-archisell/, 'primary_channel: pm-alpha'));

    mkProject('beta', VALID_FRONTMATTER.replace('project: archisell', 'project: beta')
      .replace('vault_root: 04-projects/archisell', 'vault_root: 04-projects/beta')
      .replace('memory_namespace: archisell', 'memory_namespace: beta')
      .replace(/category: archisell/, 'category: beta')
      .replace(/primary_channel: pm-archisell/, 'primary_channel: pm-beta'));

    // One malformed
    mkProject('malformed', `---\n: broken yaml [\n---\nBody\n`);

    // One archived
    mkProject('archived', VALID_FRONTMATTER.replace('status: active', 'status: archived'));

    const results = scanProjectManifests(tmpDir);
    expect(results).toHaveLength(2);

    const ids = results.map((m) => m.project).sort();
    expect(ids).toEqual(['alpha', 'beta']);
  });
});
