# RFC 3: Discord Project Channels — `#project-manager` + `#logs` + Threads

**Status:** Proposed
**Author:** Moses (planned by Opus, to be executed by Sonnet)
**Date:** 2026-04-19
**Depends on:** RFC 1 (merged), RFC 2 (merged)

## Problem

RFC 1 shipped channel → agent routing: one Discord channel can map to one project PM agent. But the guild today is flat — the PM agent has nowhere to route logs, and the user has no structural way to work on individual features without polluting the main channel.

Moses's target layout (per project):

```
immoautomation (category)
├── # project-manager         ← PM agent responds here
│   └── feature thread        ← user-created thread; PM agent responds inside it
└── # logs                    ← PM posts structured events; no user replies expected
```

One category per project. Two channels. Threads spawned under `#project-manager` for individual work items (features, tickets, meetings, incidents). No per-project research/comms channels — those agents stay global and are addressable via slash commands. No voice channels.

## Goal

After this RFC:
- Each active project manifest maps to a Discord **category** containing a PM channel and a logs channel.
- The PM agent responds in the PM channel AND in any thread spawned under it. Each thread has its own conversation session (chatKey) so contexts don't bleed, but memory stays project-scoped.
- The logs channel receives structured posts from the bot — memory saves, scheduled task fires, mission task results, errors, vault writes — without triggering agent responses.
- A `/ask <agent>` slash command works from any channel, delegating to the named global agent (main, research, comms, content, ops).

## Non-Goals

- Per-project research/comms/content/ops channels. Those agents remain global; cross-agent work flows via slash commands.
- Voice channels / War Room / Pika (not in use).
- DM routing (deferred — optional phase 3d if Moses wants it later).
- Rich embeds / buttons / custom components. Plain markdown for now.
- Auto-creating Discord categories/channels from manifests. Moses creates them; bootstrap resolves by name and fails loudly if missing (same contract as RFC 1).

## Design

### Manifest schema extension

Add to `04-projects/<project>/context.md` frontmatter:

```yaml
discord:
  category: immoautomation
  primary_channel: project-manager   # existing; the PM's chat channel
  logs_channel: logs                 # NEW; optional, default "logs"
```

Parsing: `ProjectManifest.discord` gains `logsChannel?: string`. `parseManifest` defaults to `"logs"` if omitted. No migration.

### Thread routing

Discord.js fires `MessageCreate` for messages in threads. The thread has:
- `message.channel.isThread() === true`
- `message.channel.parentId` = the parent text channel's ID

`discord-bot.ts` routing:
1. If `message.channel.isThread()`, look up `parentId` in `discord_channel_agent_map` (NOT the thread's own ID).
2. If parent is mapped, the thread inherits the parent's `agentId`.
3. `chatKey` for the thread: `discord:thread:${message.channel.id}` (vs `discord:channel:${channelId}` for top-level). Distinct session per thread.
4. Post the response inside the thread.

The PM agent's memory namespace is the project (e.g. `archisell`). Threads share that memory namespace but have isolated conversation sessions. A PM reading the memory context sees facts from the whole project; each thread's conversation-history recall stays within the thread.

### Logs channel

New module `src/project-logs.ts`:

```ts
export interface ProjectLogsMap {
  [agentId: string]: string;  // agent_id → logs_channel_id
}
export function setProjectLogsMap(map: ProjectLogsMap): void;
export function getProjectLogsChannelId(agentId: string): string | null;
export function sendProjectLog(
  agentId: string,
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
): Promise<void>;
```

Populated at Discord bootstrap: for each active manifest, resolve `<category>/<logs_channel>` and store `agent_id → channel_id`.

`sendProjectLog` sends a compact message via the Discord client. Format:

```
ℹ️ [memory] Saved: "Moses prefers…" (importance 0.82)
⚠️ [scheduled-task] Task "daily-digest" failed: timeout after 15m
🔴 [error] orchestrator.delegateToAgent: agent "research" not found
```

Emoji map: `info` → ℹ️, `warn` → ⚠️, `error` → 🔴. Keep Moses's preferences: no decorative emoji outside the log-prefix convention; elsewhere respect his "no emojis unless asked" rule.

If no logs channel is mapped for the agent, swallow silently (do not crash).

### Callers of `sendProjectLog`

Wire from these existing pathways, only when `PROJECT_AGENTS_ENABLED=true` and the agent has a mapped logs channel:

| Caller | Existing hook | Log content |
|---|---|---|
| Memory save (importance ≥ 0.8) | `setHighImportanceCallback` in `memory-ingest.ts` | `[memory] Saved: "<summary>" (importance N)` |
| Vault mirror success | post-spawn in `vault-mirror.ts` | `[vault] Wrote <path>` (optional — only if we can hook post-spawn; may defer) |
| Scheduled task fire start/end | `scheduler.ts` | `[scheduled] <task-name> running` / `[scheduled] <task-name> done (Ns)` |
| Mission task complete | `orchestrator.ts:delegateToAgent` completion path | `[mission] Delegated to <agent>: <summary>` |
| Unhandled error in handleMessage | catch in `bot.ts` | `[error] <message>` |

Each site should be a one-line addition that guards on `getProjectLogsChannelId(agentId)` before emitting. Never throw.

### `/ask <agent>` slash command

Cross-channel, non-channel-bound delegation:

```
/ask <agent> <prompt>
```

Where `<agent>` is a known agent id (main, research, comms, content, ops, or any project agent). Uses existing `orchestrator.parseDelegation` + `delegateToAgent`. Response goes back in the channel/thread the command was invoked from. Rate-limit the same way as existing slash commands.

Also: extend `parseDelegation` or add a parallel Discord slash handler. The existing `@agent:` prefix parser stays — slash is the preferred Discord UX, prefix is for quick typing.

### Discord bootstrap changes (src/discord-bootstrap.ts)

1. Keep existing PM-channel resolution + upsert to `discord_channel_agent_map`.
2. Additionally resolve the `<category>/<logs_channel>` channel. If present, add to the in-memory `ProjectLogsMap`. If absent, log a warn and continue (PM still works).
3. Emit a single summary log line per project: `Mapped project "archisell" → #project-manager (primary) + #logs (logs)`.

No DB migration. Logs map is in-memory, rebuilt on every bootstrap / `/reload-agents`.

## Phases

### Phase 3a — Manifest + routing + thread handling

**Files:**
- `src/project-manifests.ts`: add `logsChannel?: string` to interface, default to `"logs"` in `parseManifest`.
- `src/discord-bootstrap.ts`: resolve both channels, populate `ProjectLogsMap` alongside the existing channel-agent map.
- `src/project-logs.ts` (new): types + in-memory map + `sendProjectLog` (no callers yet — just the API surface).
- `src/discord-bot.ts`: MessageCreate handler checks `message.channel.isThread()`, looks up `parentId` instead of `channel.id` for routing. Thread-scoped `chatKey`.
- `src/agent-registry.ts`: `buildContextFromManifest` unchanged — the PM agent ctx is the same regardless of whether the user is in the channel or a thread.
- `src/index.ts`: wire `setProjectLogsMap` population after Discord ready (similar to the existing bootstrap call).

**Tests:**
- Parse a manifest with explicit `logs_channel` and without (default "logs").
- Unit test for `project-logs.ts` map set/get.
- Mock the Discord client and verify bootstrap populates both maps.
- Mock a thread message: routing returns the parent's agent, chatKey prefix is `discord:thread:...`.

### Phase 3b — Logs emitters wired to events

**Files:**
- `src/project-logs.ts`: implement `sendProjectLog` (send via the Discord client singleton; requires a way to reach the client — either export from `discord-bot.ts` or pass at bootstrap time).
- `src/memory-ingest.ts` high-importance callback: emit a log (in addition to the existing Telegram notification).
- `src/scheduler.ts`: emit `[scheduled] <task> start` and `[scheduled] <task> done` with duration.
- `src/orchestrator.ts`: emit `[mission] Delegated to <agent>` on `delegateToAgent` completion.
- `src/bot.ts` error catch: emit `[error] <msg>`.
- Only fires when `PROJECT_AGENTS_ENABLED` is true AND `getProjectLogsChannelId(agentId)` returns a channel.

**Tests:**
- Mock the Discord send function; assert each caller produces the expected prefix + format.
- When no logs channel is mapped: `sendProjectLog` returns without throwing.
- When Discord send fails: caller is not affected.

### Phase 3c — `/ask <agent>` slash command

**Files:**
- `src/discord-commands.ts`: register `/ask` with two args: `agent` (autocomplete from `getAvailableAgents()`), `prompt` (required string).
- Handler invokes `delegateToAgent` with `fromAgent = 'main'` (or the channel-mapped agent if inside a project channel, so the project PM can delegate to global research from its own channel).
- Response posted in the same channel/thread.

**Tests:**
- Mock slash interaction with a valid agent → delegateToAgent called with correct args.
- Unknown agent → friendly error reply.
- Thread interaction → reply goes in thread (`interaction.reply` handles it).

### Phase 3d — DM routing (optional, deferred if time-limited)

Defer unless Moses asks. Keep the existing suppression in `discord-bot.ts`.

### Phase 3e — Docs

- Update `CHANGELOG.md` Unreleased section (or open a new Unreleased block below the merged RFC 2 bits).
- Update `.env.example` if any new env vars are introduced (none planned — RFC 3 is pure routing + logging).
- Short section in README or `docs/` showing the immoautomation example layout (PM channel + feature thread + logs channel).

## Rollback

All new behaviour gated behind the existing `PROJECT_AGENTS_ENABLED` flag:
- When off: bootstrap doesn't populate logs map; thread routing doesn't apply (no project channels in the map anyway); `/ask` still works (it's a general delegation command, independent of project agents).
- When on: everything described above.

No new feature flag needed.

## Risks

- **Thread explosion.** Users might spawn dozens of threads; each has its own session. Memory namespace stays project-scoped so semantic retrieval still works. Session-log pruning (`pruneConversationLog`) is already in place and keys on `chatKey`, so per-thread conversation logs will be pruned independently. Acceptable.
- **Logs channel spam.** Every high-importance memory save + scheduled task fire posts a message. For a busy project this could be 10+ messages per hour. Mitigation: batch events within a 60s window (not in this RFC — defer if it becomes a problem). For now, one message per event, non-batched, clearly prefixed.
- **Permission drift.** The bot must have `View Channels + Read Message History + Send Messages` in the new category. If the bot was added before Moses creates a new project category, permissions usually inherit from the category, but Moses needs to verify once per project. Document in setup guide.
- **Thread parent resolution fails.** If `parentId` is null (shouldn't happen for thread messages) or the parent isn't in the map, fall back to default context / drop per RFC 1 behaviour.
- **Slash command collision.** Discord has a per-guild slash command limit (100). Currently claudeclaw uses `/newchat /memory /forget /reload-agents`. Adding `/ask` puts us at 5. Far from the limit.

## Open Questions

1. Should the PM agent auto-suggest thread titles when the user opens a new thread without one? **Decision: no.** Discord auto-generates titles from the opening message. Skip.
2. Should `/ask` also work as `/delegate`? **Decision: pick one.** Use `/ask` — shorter, matches Moses's instinct ("have research look into X"). Keep `/delegate` as an alias if discord.js makes it free; otherwise don't.
3. When a user sends a message in `#logs`, should the PM agent respond? **Decision: no.** The logs channel is one-way. If the user types there, silently ignore (or emit a single gentle `[info] logs channel is append-only; message ignored` reply once per user per session — probably overkill; just ignore).
4. Should archived project categories be auto-removed from Discord? **No.** Bridge refuses writes already; channels staying visible is fine and doesn't affect correctness.

## Execution

Opus wrote this spec. Sonnet executes phases 3a → 3b → 3c on branch `feature/discord-project-channels` (cut from main after RFC 2 merge). Each phase ships green tests before the next starts. Opus merges the branch after 3c validates.
