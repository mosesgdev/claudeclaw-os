# RFC 2: Obsidian Write — Skill + Vault Bridge

**Status:** Proposed
**Author:** Moses (planned by Opus, to be executed by Sonnet)
**Date:** 2026-04-19
**Depends on:** RFC 1 (`docs/rfc-project-agents.md`)

## Problem

Today claudeclaw reads the Obsidian vault but never writes to it. Claude Code sessions write to the vault ad hoc, producing isolated nodes (30% of files have zero wiki-links), inconsistent frontmatter, empty `_meta/templates/`, unused `learnings/` and `reflections/` folders. The vault is Moses's second brain but there is no enforced write protocol.

RFC 1 shipped per-project agents routed by Discord channel. Each PM agent has a scoped vault folder and memory namespace — but until writes are wired, a PM agent cannot grow the knowledge it owns.

## Goal

Single write-protocol shared by two callers:

1. **Claude Code CLI sessions** (including per-project PM agents spawned in a shell) invoke the `obsidian-write` skill from `~/agentic-master/skills/`.
2. **claudeclaw bot** mirrors high-importance memories into the same folders using the same conventions, via the existing `onHighImportanceMemory` callback (`src/memory-ingest.ts:8-12`).

Both paths go through the same bridge module, so output files are bit-compatible. The vault becomes the source of truth; claudeclaw's SQLite is a fast cache of what's in the vault plus ephemeral conversation context.

## Non-Goals

- Vault hygiene pass (frontmatter backfill, template population, isolated-node fixes). Moses does that manually; it does not gate this RFC.
- Two-way sync between SQLite and vault (reconcile-on-startup). Out of scope.
- Auto-generating MOC / graph views. Manual.
- Remote Obsidian Sync. Vault stays single-machine per earlier discussion.

## Design Principles

- **Bridge lives in claudeclaw as a CLI** — agentic-master has no Node/TS toolchain (verified: no `package.json`, `tsconfig.json`; existing scripts are Bash/Python). The bridge is `src/vault-bridge-cli.ts` inside claudeclaw (compiled to `dist/vault-bridge-cli.js`), matching the pattern established by `memory-dedupe-cli` in phase 2a. Both callers (Claude Code skill, bot memory hook) shell into it.
- **One write logic, two entry points.** Templates, routing, frontmatter, wiki-link injection — all in one CLI. No drift.
- **Agentic-master dependency:** the `obsidian-write` skill in agentic-master expects `CLAUDECLAW_ROOT` (default `~/Services/claudeclaw`) to be installed. Skill degrades gracefully with a clear error if `dist/vault-bridge-cli.js` is missing.
- **Fire-and-forget from the bot.** Vault writes never block Telegram/Discord responses.
- **Idempotent.** Running the skill twice on the same content never creates duplicates.
- **No shared filesystem write lock needed.** Obsidian handles concurrent writes fine since files are per-note; the bridge uses atomic write-then-rename to avoid partial reads.

## Architecture

```
Claude Code CLI  ──┐
                   ├──► agentic-master/skills/obsidian-write  ──► bridge.ts  ──► vault
bot.ts callback  ──┘                                              ▲
                                                                  │
                                              dedupe via claudeclaw/dist/memory-dedupe-cli
```

The bridge is a standalone Node module in agentic-master (not claudeclaw). For dedupe (cosine similarity against existing memory embeddings), the bridge optionally shells out to a small CLI exposed by claudeclaw (`dist/memory-dedupe-cli.js`). If claudeclaw isn't running, the bridge skips dedupe and still writes — falling back gracefully.

## Vault Conventions

Codified in `~/agentic-master/expertise/obsidian-vault.yaml` (new file, per reviewer rec):

```yaml
vault_root: ~/Documents/Obsidian/ClaudeClaw
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
frontmatter_required: [tags, status, created, related]
frontmatter_defaults:
  status: active
  related: []
dedupe_cosine_threshold: 0.85
importance_mirror_threshold: 0.7
read_only_for_agents: [00-inbox, 05-knowledge]
```

The bridge reads this file once at process start. Skills reference it via `agentic-master`'s expertise resolution.

## Types of Writes

| Type | Target | Filename | Agent-scoped | Also writes SQLite? |
|------|--------|---------|--------------|---------------------|
| session | `06-claudeclaw/sessions/` or `agents/{id}/sessions/` | `YYYY-MM-DD-{slug}.md` | yes | no (session is a log) |
| learning | `06-claudeclaw/learnings/` | `{slug}.md` | tag only | yes (importance ≥ 0.7) |
| reflection | `06-claudeclaw/reflections/` | `YYYY-MM-DD-{slug}.md` | tag only | yes (importance ≥ 0.7) |
| knowledge | `05-knowledge/` | `{slug}.md` | tag only | yes (importance ≥ 0.8) |
| project-context | `04-projects/{project}/context.md` | fixed | — | no (context.md is canonical) |
| close-task | in-place edit | — | — | — |

## Frontmatter Template

```yaml
---
tags:
  - type/{type}
  - project/{project}           # if project-scoped
  - agent/{agent_id}            # if agent-scoped
status: active                  # or draft, archived, done
created: YYYY-MM-DD
related:
  - "[[04-projects/{project}/context]]"  # if project-scoped
  - "[[auto-linked-neighbor]]"
importance: 0.85                # if mirrored from memory
source: vault | memory-mirror | consolidation
---
```

## Wiki-Link Injection

Two strategies, applied in order:

1. **Memory-graph lookup** (when dedupe CLI is available): bridge calls `memory-dedupe-cli neighbors --topics "X,Y" --limit 3` to fetch topically related memories. Each result has a `vault_path` if it was written via this pipeline before. Those paths become `[[wiki-links]]`.
2. **Filename fuzzy match** (fallback): scan the vault for existing filenames mentioned in the content; convert plain text → wiki-links for exact matches. Case-insensitive, longest-match first, capped at N=5 per document to avoid noise.

Also appends a `## Related` section at the end if absent, listing the wiki-links.

## The Dedupe Contract

Before writing a learning/reflection/knowledge file:

1. Embed the summary via `gemini` (already used by claudeclaw).
2. Shell out: `node <claudeclaw>/dist/memory-dedupe-cli.js check --text "$SUMMARY" --threshold 0.85`. Returns exit 0 with `{"duplicate": false}` or `{"duplicate": true, "existing_id": 42, "vault_path": "06-claudeclaw/learnings/foo.md"}`.
3. On duplicate: update the existing file's frontmatter (touch `updated_at`, merge tags) and return — no new file.
4. If CLI unavailable (claudeclaw not running, e.g. pure Claude Code session): log one warn, skip dedupe, write anyway. User accepts minor drift.

## Memory → Vault Mirror

In `src/memory-ingest.ts`:

- Current `onHighImportanceMemory` callback fires at importance ≥ 0.8 (line 141).
- Lower the vault-mirror threshold to 0.7. Keep the 0.8 callback for Telegram/Discord notifications (pin-worthy), but register a second callback at 0.7 for vault mirror.
- New callback registration pattern to avoid collision:
  ```ts
  export function setMirrorCallback(
    cb: (memoryId: number, summary: string, importance: number, topics: string[]) => void,
  ): void;
  ```
- Callback invokes `node <agentic-master>/skills/obsidian-write/bridge.js write --type learning --summary "$S" --topics "$T" --importance "$I" --source memory-mirror --agent-id "$AGENT_ID" --vault-root "$VAULT_ROOT"`.
- Fire-and-forget: bridge runs in a detached child process; never blocks response.

Similar hook in `src/memory-consolidate.ts` for consolidation insights → `06-claudeclaw/reflections/`.

After the bridge writes a file, it calls back: `node <claudeclaw>/dist/memory-dedupe-cli.js set-vault-path --id <memoryId> --path "06-claudeclaw/learnings/foo.md"`. This requires a new `vault_path` column on `memories` (migration 0.1.1). Moses pushed back on this column earlier (claudeclaw reviewer called it redundant); the counter-argument: dedupe wants to know the target path of an existing memory so the bridge can update instead of skip. We either add the column or store the mapping in a separate `memory_vault_links` table. **Decision for this RFC: new table `memory_vault_links(memory_id INTEGER PRIMARY KEY, vault_path TEXT NOT NULL, updated_at INTEGER NOT NULL)` — keeps `memories` schema lean.**

## Extend Read Path (claudeclaw side)

`src/obsidian.ts` today scans for `- [ ]` tasks only. Extend:

1. Additionally scan `05-knowledge/` and `06-claudeclaw/learnings/` for the first H1 + first paragraph as a summary line. Limit to the 20 most-recently-modified files; cache 5 min like today.
2. Always preload `00-inbox/moses-profile.md` content into the `[Obsidian context]` block. Cap at 2k chars.
3. Section the output: `[Obsidian: profile]`, `[Obsidian: active tasks]`, `[Obsidian: knowledge]`, `[Obsidian: learnings]`.

Only surface knowledge/learnings that are tagged `type/{knowledge,learning}` AND `status: active`. Skip everything else.

## The Skill (`~/agentic-master/skills/obsidian-write/SKILL.md`)

Self-contained. Reads `expertise/obsidian-vault.yaml` at invocation for routing. Arguments:

```
obsidian-write --type <type> --title "<title>" --content "<text or file path>"
               [--project <name>] [--agent-id <id>] [--importance <0..1>]
               [--no-dedupe] [--close-task "<task text>"]
```

SKILL.md sections: Runtime Context Loading (reads overrides + expertise + CLAUDE.md), Variables, Workflow (1. resolve target path; 2. check dedupe; 3. apply frontmatter; 4. inject wiki-links; 5. atomic write; 6. update memory link if mirror), Examples, Report Format.

Skill internals delegate to `bridge.ts` — the skill file itself is <200 lines and mostly orchestration.

## Phases

### Phase 2a — `memory_vault_links` table + memory-dedupe-cli

**claudeclaw changes:**
- Migration `0.1.1/add-memory-vault-links.ts`: table + index on `memory_id`.
- `src/db.ts`: add same table to `createSchema()`.
- New `src/memory-vault-links.ts`: `setVaultPath`, `getVaultPath`, `listLinksByTopics`.
- New `src/memory-dedupe-cli.ts`: commands `check` (embed + cosine), `set-vault-path`, `neighbors` (topics-based lookup joining memories + memory_vault_links). Thin wrapper on existing functions in `memory-ingest.ts` + `embeddings.ts`.
- Tests: 8-10 for the new module + CLI smoke tests.
- **No behaviour change yet.** CLI is a pure tool.

### Phase 2b — `expertise/obsidian-vault.yaml` in agentic-master

- New file at `~/agentic-master/expertise/obsidian-vault.yaml` with the schema above.
- Document in `~/agentic-master/docs/primers/obsidian-vault-expertise.md` (brief).
- **No code yet.** Pure config.

### Phase 2c — Bridge CLI in claudeclaw

- New `src/vault-bridge-cli.ts` (compiled to `dist/vault-bridge-cli.js`). Matches the CLI pattern established by `memory-dedupe-cli` in 2a.
- Commands: `write`, `close-task`, `update-backlinks` (appends a wiki-link to another file's `related:` list). `neighbors` is already in `memory-dedupe-cli` from 2a; bridge calls it internally for wiki-link injection rather than reimplementing.
- Reads conventions from `<AGENTIC_MASTER_ROOT>/expertise/obsidian-vault.yaml` (path resolution: env var `AGENTIC_MASTER_ROOT`, default `~/agentic-master`). If the file is missing, falls back to hardcoded defaults matching the schema in the "Vault Conventions" section.
- Templates loaded from `<VAULT_ROOT>/_meta/templates/` if present, else inlined fallbacks.
- Atomic write: write to `.foo.md.tmp` + rename → `foo.md`. Ensures partial reads never happen while Obsidian is watching.
- Refuses to write under `04-projects/<project>/` if the project manifest shows `status: archived`.
- Tests: fixture vault in a tmpdir, 10+ cases covering all subcommands + atomicity + dedupe flow + wiki-link injection + archived-refusal.

### Phase 2d — `obsidian-write` skill SKILL.md in agentic-master

- Write `~/agentic-master/skills/obsidian-write/SKILL.md` per the format of `~/agentic-master/skills/load-ai-docs/SKILL.md` (frontmatter, Runtime Context Loading, Variables, Workflow, Examples).
- Add to `~/agentic-master/library.yaml` under a new "Knowledge Management" category.
- No compiled code — just orchestration markdown that resolves `CLAUDECLAW_ROOT` (default `~/Services/claudeclaw`) and invokes `node $CLAUDECLAW_ROOT/dist/vault-bridge-cli.js ...`.
- Skill fails with a clear error message if the CLI is missing.

### Phase 2e — Memory mirror hook in claudeclaw

- Extend `src/memory-ingest.ts`: add `setMirrorCallback(cb)` with a separate 0.7 threshold.
- In `src/bot.ts` init: register the mirror callback to fire `node <agentic-master>/skills/obsidian-write/bridge.js write --type learning ...` via `child_process.spawn` detached + unref'd.
- Resolve the agentic-master path via new env var `AGENTIC_MASTER_ROOT` (default: `~/agentic-master`). Add to `src/config.ts`.
- Tests: mock the spawn call, assert it fires at importance 0.7 and 0.8, does not fire at 0.69.

### Phase 2f — Consolidation mirror + read-path extension

- `src/memory-consolidate.ts`: at the end of consolidation, invoke bridge `write --type reflection` for each new consolidation with importance ≥ 0.7.
- `src/obsidian.ts`: extend scan to include `05-knowledge/` + `06-claudeclaw/learnings/`, section the output, preload `moses-profile.md`. Keep cache 5min. Only surface `status: active` + correct `type/*` tags.
- Tests: fixture vault with mixed status/types; assert filtering.

### Phase 2g — End-to-end validation + feature flag

- New `.env` flag: `OBSIDIAN_WRITE_ENABLED` (default `false`). Gates both mirror hooks.
- When off: no spawn calls, no mirror writes. Behaviour identical to RFC 1 state.
- Docs: add a section to `docs/rfc-obsidian-write.md` describing the validation checks below.

**Validation (flag on, fresh test):**
1. Send a Discord message worth remembering (importance 0.8+). Within ~5s, a file appears at `~/Documents/Obsidian/ClaudeClaw/06-claudeclaw/learnings/{slug}.md` with correct frontmatter.
2. SQLite: `SELECT memory_id, vault_path FROM memory_vault_links` shows the row.
3. Send a near-duplicate message. No new file; bridge reports `duplicate` and updates `updated_at` on the existing file.
4. Run `obsidian-write --type learning --title "Test" --content "..."` from a Claude Code CLI session. File appears with same conventions.
5. Claude Code session writes a session summary; bridge auto-appends a wiki-link to the project's `context.md` `related:` list.
6. Flip flag to off; send another high-importance message; no file written.

## Rollback

Feature flag `OBSIDIAN_WRITE_ENABLED=false` disables:
- Mirror callbacks (both 0.7 and consolidation)
- Read-path extension for knowledge/learnings (reverts to task-only scan)

The bridge, skill, and expertise file all exist regardless — they're just not invoked.

## Schema Changes

- Migration `0.1.1`: `memory_vault_links` table.
- No changes to `memories`, `consolidations`, `discord_channel_agent_map`.

## Risks

- **Spawning child processes on every memory ingest.** ~100ms overhead per fire. Mitigation: fire-and-forget + detached + unref — never on hot path. Verify with timing in tests.
- **Agentic-master path not installed on a machine.** `AGENTIC_MASTER_ROOT` default `~/agentic-master`. If absent, log once at startup and disable mirror. Don't crash.
- **Vault writes during manual Obsidian edit.** Obsidian tolerates concurrent writes. Atomic rename prevents partial reads. Occasional merge conflict: accept — this is single-machine, single-user.
- **Skill consumed with stale expertise/obsidian-vault.yaml.** Bridge reads it per invocation (no caching), so edits take effect immediately.
- **Duplicate mirror from consolidation + ingest** for the same underlying memory. Mitigation: consolidation writes with `source: consolidation` tag, ingest writes with `source: memory-mirror`. Dedupe by summary cosine still applies across sources. If duplicate detected, we update instead of create.

## Open Questions

1. Do we also want `obsidian-read` as a separate skill (progressive session context loader)? Agentic-master reviewer recommended making it a `session_start.py` hook instead of a skill. **Decision: defer. RFC 3 can address read-side if needed.** For now the bot's extended `obsidian.ts` read path covers the memory-context use case.
2. Bridge in Node (.ts/.js) vs Python? **Decision: Node/TS inside claudeclaw.** agentic-master has no Node/TS toolchain (verified: no package.json, no tsconfig). Putting the bridge in claudeclaw lets it share embeddings + DB access directly and matches the `memory-dedupe-cli` pattern from 2a. Skill in agentic-master shells into `dist/vault-bridge-cli.js`.
3. Should archived manifests' vault folders be made read-only to the bridge? **Decision: yes.** Bridge refuses to write under `04-projects/<project>/` if the project manifest shows `status: archived`. Small check in 2c.

## Execution

Opus wrote this spec. Sonnet executes, one phase per commit, on a new branch `feature/obsidian-write` cut from main (after RFC 1 PR merges, or stacked on the RFC 1 branch if it hasn't).

**Order:** 2a → 2b → 2c → 2d → 2e → 2f → 2g. Phases 2a-2d are pure build-up; 2e-2f wire behaviour behind a flag; 2g validates. Each phase ships green tests before the next starts.
