#!/usr/bin/env node
/**
 * memory-dedupe-cli.ts — RFC 2a dedupe + vault-link tool
 *
 * Usage:
 *   node dist/memory-dedupe-cli.js check --text "<summary>" [--chat-id <id>] [--threshold 0.85]
 *   node dist/memory-dedupe-cli.js set-vault-path --id <memoryId> --path "<vault-relative-path>"
 *   node dist/memory-dedupe-cli.js neighbors --topics "a,b,c" [--limit 5]
 *
 * Designed to be shelled out by the vault bridge (phase 2c).
 * All output is newline-terminated JSON on stdout. Exit 0 on success, 1 on error.
 */

import { initDatabase, getMemoriesWithEmbeddings } from './db.js';
import { embedText, cosineSimilarity } from './embeddings.js';
import { setVaultPath, getVaultPath, listLinksByTopics } from './memory-vault-links.js';
import { GOOGLE_API_KEY } from './config.js';

// ── Helpers ───────────────────────────────────────────────────────────

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : undefined;
}

function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function die(data: unknown, code = 1): never {
  printJson(data);
  process.exit(code);
}

// ── Main ──────────────────────────────────────────────────────────────

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...rest] = argv;

  initDatabase();

  switch (command) {
    // ── check ──────────────────────────────────────────────────────────
    case 'check': {
      const text = parseFlag(rest, '--text');
      if (!text) die({ error: 'missing_arg', detail: '--text is required' });

      if (!GOOGLE_API_KEY) {
        die({ error: 'no_embedding_key' });
      }

      const chatId = parseFlag(rest, '--chat-id') ?? 'vault-bridge';
      const threshold = parseFloat(parseFlag(rest, '--threshold') ?? '0.85');

      let queryEmbedding: number[];
      try {
        queryEmbedding = await embedText(text);
      } catch (err) {
        die({ error: 'embed_failed', detail: String(err) });
      }

      const candidates = getMemoriesWithEmbeddings(chatId);
      let bestSim = 0;
      let bestId: number | null = null;

      for (const mem of candidates) {
        const sim = cosineSimilarity(queryEmbedding!, mem.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestId = mem.id;
        }
      }

      if (bestSim >= threshold && bestId !== null) {
        const vaultPath = getVaultPath(bestId) ?? undefined;
        printJson({ duplicate: true, existingId: bestId, similarity: bestSim, vaultPath });
      } else {
        printJson({ duplicate: false });
      }
      break;
    }

    // ── set-vault-path ─────────────────────────────────────────────────
    case 'set-vault-path': {
      const idStr = parseFlag(rest, '--id');
      const vaultPath = parseFlag(rest, '--path');

      if (!idStr || !vaultPath) {
        die({ error: 'missing_arg', detail: '--id and --path are required' });
      }

      const memoryId = parseInt(idStr!, 10);
      if (isNaN(memoryId)) die({ error: 'invalid_arg', detail: '--id must be an integer' });

      setVaultPath(memoryId, vaultPath!);
      printJson({ ok: true, memoryId, vaultPath });
      break;
    }

    // ── neighbors ──────────────────────────────────────────────────────
    case 'neighbors': {
      const topicsStr = parseFlag(rest, '--topics') ?? '';
      const limit = parseInt(parseFlag(rest, '--limit') ?? '10', 10);
      const topics = topicsStr
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);

      const results = listLinksByTopics(topics, isNaN(limit) ? 10 : limit);
      printJson(results);
      break;
    }

    default: {
      const msg = [
        'Usage:',
        '  memory-dedupe-cli check --text "<text>" [--chat-id <id>] [--threshold 0.85]',
        '  memory-dedupe-cli set-vault-path --id <memoryId> --path "<vault-path>"',
        '  memory-dedupe-cli neighbors --topics "a,b,c" [--limit 5]',
      ].join('\n');
      process.stderr.write(msg + '\n');
      process.exit(1);
    }
  }
}

// Only run when invoked directly (not when imported in tests)
if (process.argv[1] && process.argv[1].endsWith('memory-dedupe-cli.js')) {
  main().catch((err) => {
    process.stderr.write(String(err) + '\n');
    process.exit(1);
  });
}
