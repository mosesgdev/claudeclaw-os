# RFC: Project Agents — Vault-Driven Multi-Agent Routing

**Status:** Proposed
**Author:** Moses (planned by Opus, to be executed by Sonnet)
**Date:** 2026-04-19

## Problem

claudeclaw today runs one agent per OS process. The agent identity, Discord bot, Obsidian config, memory namespace, and system prompt are module-level globals set once via `setAgentOverrides()` in `src/config.ts:48-73` and read by ~12 files. Running agents in parallel requires separate launchd services, each with its own Discord bot token.

Moses wants per-project manager agents (e.g., an archisell PM agent) that live alongside the existing `main/research/comms/content/ops` roster. Each PM must:
- Read/write a scoped Obsidian vault folder
- Own a scoped memory namespace
- Be addressable from a specific Discord channel
- Load only the skills/experts relevant to its project — no context bloat at boot

Running one launchd service + one Discord bot per project is ugly and does not scale. The right shape is **one process, one Discord bot, N agent contexts routed by channel.**

## Goal

Single Discord bot routes messages to the correct agent context based on the channel the message arrived in. Agent contexts are sourced from two places:

1. **Static agents** — `agents/<id>/agent.yaml` + `CLAUDE.md` (today's pattern; unchanged)
2. **Project agents** — frontmatter on `<vault>/04-projects/<project>/context.md` (new)

Telegram behaviour is unchanged (single agent per process, via `setAgentOverrides()`). This RFC is about Discord.

## Non-Goals

- Vault writes (obsidian-write skill, vault-bridge-cli) — covered by separate RFC.
- Lazy skill body loading / progressive context disclosure — covered separately.
- Migrating existing static agents to the new context pattern — they keep working as-is.
- Auto-creating Discord channels/categories from manifests — out of scope; channels must pre-exist, bot fails loudly if missing.

## Design

### AgentContext (new)

`src/agent-context.ts` (new file):

```ts
export interface AgentContext {
  agentId: string;            // stable identifier; used as memory agent_id
  name: string;               // display name
  source: 'yaml' | 'manifest';
  botToken?: string;          // telegram bot token if applicable
  cwd: string;
  model?: string;
  mcpServers?: string[];
  obsidian?: { vault: string; folders: string[]; readOnly?: string[] };
  systemPrompt?: string;      // CLAUDE.md or context.md body
  allowedSkills?: string[];   // optional whitelist (enforcement in later phase)
  project?: string;           // set for manifest-sourced agents
  vaultRoot?: string;         // e.g. "04-projects/archisell"
}
```

All consumers (bot, memory, agent runner, orchestrator) take `AgentContext` as a parameter instead of reading `config.ts` globals.

`setAgentOverrides()` stays as a compatibility shim that builds a default `AgentContext` from env/launchd and stashes it in a module-level `defaultAgentContext`. Code paths that cannot thread the context (scheduler cron fires, mission CLI) read `defaultAgentContext` with a log warning.

### Project manifest schema

Frontmatter on `<VAULT>/04-projects/<project>/context.md`:

```yaml
---
project: archisell            # required, unique slug, used as agent_id
status: active | archived     # required; only 'active' spawns
vault_root: 04-projects/archisell  # required, relative to vault root
memory_namespace: archisell   # required; usually == project
discord:
  category: archisell         # required; Discord category name
  primary_channel: pm-archisell  # required; channel name under that category
skills: [gmail, google-calendar, obsidian-write]  # optional; whitelist
experts: [archisell-domain]   # optional; resolved against vault 05-knowledge/experts/
hooks: []                     # optional; resolved against agentic-master/hooks/
---

# Archisell — Project Context

(human-readable body; used as systemPrompt for the agent)
```

No data lives in agentic-master; the repo only ships `docs/primers/project-manifest-schema.md` documenting this contract.

### discord_channel_agent_map (new table)

```sql
CREATE TABLE discord_channel_agent_map (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  project TEXT,
  category_name TEXT,
  channel_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_dcam_agent ON discord_channel_agent_map(agent_id);
```

At boot, for each active manifest, resolve `(guild, category_name, channel_name)` → `channel_id` via Discord API and upsert. If a channel is missing, log an error and skip that project (do not crash).

### Routing flow

1. Discord message arrives in `discord-bot.ts:71`.
2. Guild check unchanged.
3. Channel whitelist check becomes: `SELECT agent_id FROM discord_channel_agent_map WHERE channel_id = ?`. If absent, fall back to the default context (`main` agent) **only** if the channel is in `DISCORD_ALLOWED_CHANNEL_IDS`. Otherwise drop.
4. Build `AgentContext` for the resolved `agent_id` from the registry.
5. Call `handleMessage(channel, inbound, ctx)` with the context.

### Unified agent registry

`src/agent-registry.ts` (new; replaces the registry logic in `orchestrator.ts:40-62`):

- Scans `agents/<id>/agent.yaml` + `CLAUDECLAW_CONFIG/agents/<id>/agent.yaml` for static agents.
- Scans `<VAULT>/04-projects/*/context.md` for manifest agents.
- Returns `AgentContext[]`. Manifest agents win on `agentId` conflict (logged).
- Exposes `getContext(agentId)` for lookups.
- Watches the vault folder with `chokidar`; re-scans on change and emits `agents:changed`.

### handleMessage refactor

`src/bot.ts:handleMessage(channel, inbound)` → `handleMessage(channel, inbound, ctx: AgentContext)`.

Every read of a global (`AGENT_ID`, `agentDefaultModel`, `agentSystemPrompt`, `agentObsidianConfig`, `agentMcpAllowlist`) is replaced by the field on `ctx`. The compatibility shim ensures single-agent Telegram paths that didn't previously pass a context receive the default context.

Same thread-through applies in:
- `src/agent.ts` (runAgent) — accept `ctx` or at minimum agentId + mcpServers + model
- `src/memory.ts`, `src/memory-ingest.ts`, `src/memory-consolidate.ts` — pass `ctx.agentId` explicitly (already supported, currently default to `'main'`)
- `src/orchestrator.ts:delegateToAgent` — build sub-agent context from registry, not globals
- `src/dashboard.ts` — read default context instead of globals
- `src/scheduler.ts`, `src/schedule-cli.ts`, `src/mission-cli.ts` — read default context

## Phases

### Phase 1a — Manifest loader (pure, isolated)

**Files:**
- New: `src/project-manifests.ts`
- New: `src/project-manifests.test.ts`
- Modify: `src/config.ts` — add `VAULT_PROJECTS_ROOT` env (default `~/Documents/Obsidian/ClaudeClaw/04-projects`)
- Modify: `package.json` — add `gray-matter` dep if not present

**API:**
```ts
export interface ProjectManifest {
  project: string;
  status: 'active' | 'archived';
  vaultRoot: string;
  memoryNamespace: string;
  discord: { category: string; primaryChannel: string };
  skills: string[];
  experts: string[];
  hooks: string[];
  systemPrompt: string; // body after frontmatter
  sourcePath: string;
}
export function scanProjectManifests(rootDir?: string): ProjectManifest[];
export function parseManifest(filePath: string): ProjectManifest | null;
```

**Tests:**
- Parses a well-formed context.md.
- Skips `status: archived`.
- Returns null on malformed frontmatter with logged warning; caller unaffected.
- Skips files missing required fields.
- Handles missing `04-projects` dir (returns []).

**Validation:** Unit tests pass. Nothing else wired. Safe to merge.

### Phase 1b — Optional telegram token in agent.yaml

**Files:**
- Modify: `src/agent-config.ts:71-73` — `botTokenEnv` optional; only require it if agent is meant for Telegram
- Modify: `src/agent-config.ts:56-112` — skip token resolution gracefully when `telegram_bot_token_env` absent

**Rationale:** A Discord-only project agent has no Telegram token. Existing static agents keep `telegram_bot_token_env` and are unaffected.

**Tests:** Load an agent.yaml without `telegram_bot_token_env`; assert `botToken` is undefined and no throw.

### Phase 1c — discord_channel_agent_map migration + seed

**Files:**
- New: `migrations/<version>/up.sql` creating the table + index
- Modify: `migrations/version.json` — register the new version
- New: `src/discord-channel-map.ts` — `upsertMapping`, `lookupAgentForChannel`, `listMappings`, `clearStaleMappings(activeAgentIds: string[])`
- Tests: `src/discord-channel-map.test.ts`

**Seeding:** Deferred to 1e (requires registry + Discord API lookup). This phase only lands the table.

### Phase 1d — AgentContext refactor

The keystone. Do it as a single, reviewable change.

**Files:**
- New: `src/agent-context.ts` — `AgentContext` type, `buildDefaultContext()`, `buildContextFromYaml(agentId)`, `buildContextFromManifest(m: ProjectManifest)`, `defaultAgentContext` module-level
- Modify: `src/config.ts` — `setAgentOverrides()` now calls `buildDefaultContext()` and stores in `defaultAgentContext`; keep the named exports as deprecated getters that read from `defaultAgentContext`
- Modify: `src/bot.ts:handleMessage` — accept `ctx: AgentContext` as 3rd arg; thread everywhere in the function; update call sites in Telegram handler + Discord handler to pass `ctx`
- Modify: `src/agent.ts` — add `ctx?: AgentContext` parameter to `runAgent`/`runAgentWithRetry`; use `ctx` fields preferentially over globals
- Modify: `src/memory.ts`, `src/memory-ingest.ts`, `src/memory-consolidate.ts` — ensure every call receives an explicit `agentId` (mostly already the case; audit)
- Modify: `src/orchestrator.ts` — `delegateToAgent` resolves target via registry, builds context, passes to `runAgent`
- Modify: `src/dashboard.ts`, `src/scheduler.ts`, `src/schedule-cli.ts`, `src/mission-cli.ts`, `src/agent-create.ts` — replace global reads with `defaultAgentContext` reads via helper

**Backwards compatibility:** All 12 files listed in the Grep audit above must still compile and behave identically under the single-agent Telegram path. The shim in `setAgentOverrides` ensures globals + `defaultAgentContext` agree.

**Tests:**
- Existing `bot.test.ts`, `agent.test.ts`, `schedule-cli.test.ts` must pass unchanged.
- New `agent-context.test.ts` validates builders.

### Phase 1e — Unified registry + Discord routing

**Files:**
- New: `src/agent-registry.ts` — merges yaml + manifest sources into `AgentContext[]`, watches vault, emits change events
- Modify: `src/orchestrator.ts` — delegate registry reads to `agent-registry.ts`; keep delegation logic
- Modify: `src/discord-bot.ts:71-85` — look up channel in `discord_channel_agent_map`; build ctx from registry; pass to `handleMessage`; fall back to default context if `DISCORD_ALLOWED_CHANNEL_IDS` matches and no mapping exists
- New: `src/discord-bootstrap.ts` — on Discord ready, iterate active manifests, resolve category/channel by name via Discord API, upsert into `discord_channel_agent_map`. Missing channels → error log + skip
- Modify: `src/index.ts` — wire registry init + discord-bootstrap after client ready

**Validation criteria (end-to-end):**
1. Create `~/Documents/Obsidian/ClaudeClaw/04-projects/archisell/context.md` with valid frontmatter. Create Discord category `archisell` + channel `pm-archisell` in the configured guild. Restart.
2. Log line: `Spawned project agent: archisell → #pm-archisell (channel_id=...)`.
3. Post a message in `#pm-archisell`. The archisell agent responds with its scoped `vaultRoot` obsidian context and `memory_namespace: archisell`.
4. Post in `#general`. Main agent responds. No cross-namespace bleed.
5. `sqlite3 store/claudeclaw.db "SELECT DISTINCT agent_id FROM memories"` includes `archisell` after a few exchanges.
6. Flip archisell frontmatter to `status: archived`, save. Within ~5s, registry re-scan unbinds; posting in `#pm-archisell` falls back to default context (or is dropped if whitelist is empty).

### Phase 1f — Per-agent skill whitelist enforcement (deferred)

Out of scope for this RFC. Tracked separately. Placeholder field `allowedSkills` on `AgentContext` exists but is not enforced yet.

## Rollback

Feature-gated by `PROJECT_AGENTS_ENABLED=true` in `.env`.
- When false: `scanProjectManifests` returns `[]`, discord-bootstrap is a no-op, registry only returns yaml agents, channel lookup always returns null → default context. Identical behaviour to today.
- When true: all of the above activates.

Default: **false** during rollout. Flip to true after phase 1e validation passes.

## Schema changes

1. `discord_channel_agent_map` table (phase 1c).
2. No changes to `memories` table — existing `agent_id` column already scopes correctly.
3. `vault_path` column on `memories` deferred to the obsidian-write RFC; not needed here.

## Risks

- **Global deprecation blast radius.** 12 files read globals today. Missed call sites will silently use stale default. Mitigation: compile-time switch to getter functions that log first access after refactor; smoke test by running Telegram single-agent path end-to-end.
- **Discord bot permissions.** Bot must have `View Channels` + `Read Message History` + `Send Messages` in the project category. Document in setup.
- **Manifest malformed by user.** Do not crash. Log, skip, continue. Surface in dashboard.
- **Channel renamed in Discord.** Mapping stale until rescan. Mitigation: store `channel_id` once resolved; re-resolve only if bootstrap explicitly fails.
- **Two processes running (Telegram + Discord via launchd).** Each has its own default context; do not share `defaultAgentContext` state across processes. Registry is per-process.

## Open Questions

1. Should project agents participate in `delegateToAgent` (i.e., can `main` delegate to `archisell`)? Yes, if registered. Follow registry. No special casing.
2. Should archived manifests appear in dashboard? Yes, greyed out. Dashboard change out of scope for this RFC.
3. What happens if two processes both try to bootstrap Discord channel mappings? Last writer wins; UPSERT is idempotent.

## Dependencies

- `gray-matter` (frontmatter parsing) — add in 1a
- `chokidar` (file watching) — already in deps? Check in 1e
- Discord.js — existing

## Execution

Opus wrote this spec. Sonnet executes, one phase per PR/commit. Phase 1a first, behind no feature flag (pure library code). Phase 1b–1c next, still dormant. Phase 1d is the keystone refactor — ship with tests green, single-agent behaviour unchanged. Phase 1e flips `PROJECT_AGENTS_ENABLED=true` and validates end-to-end.
