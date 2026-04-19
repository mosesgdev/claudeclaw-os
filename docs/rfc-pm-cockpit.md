# RFC 5: PM Cockpit + Fresh-Context Subagents for Git Issues

**Status:** Proposed
**Author:** Moses (planned by Opus, to be executed by Sonnet)
**Date:** 2026-04-19
**Depends on:** RFC 1 (project agents), RFC 2 (vault bridge), RFC 3 (Discord channels/threads), PR #4 (cmux streamline)

## Problem

Today every Discord/Telegram turn spawns a fresh `runAgent` call. That's fine for Q&A but wrong for sustained coding work:

- No persistent editor state, no live REPL, no incremental task context across turns.
- The PM agent is stateless between turns — each message reconstructs context from memory + obsidian.
- When Moses wants the PM to tackle a GitHub issue, there's no clean way to hand off to a focused worker: the issue's context bleeds into the PM's general project conversation.

The cmux bridge (PR #4) gives us per-chat interactive `claude` sessions. RFC 5 builds on it.

## Goal

Two cockpit shapes per project:

1. **PM cockpit** — a single persistent cmux workspace per project agent. Always running, owns the project's "control room" — reads the project context.md, surfaces issue backlogs, briefs subagents, observes their output. Lives in `#project-manager` and is driven by messages there.

2. **Subagent cockpits** — spawned on demand, one per GitHub issue. Each gets its own fresh cmux workspace + fresh Claude session (zero prior conversation history, minimal preamble). Briefed by the PM with a structured prompt that carries *exactly* the context needed for that issue. Lives in a dedicated Discord thread under `#project-manager`. Dies on issue close / PR merge.

The PM is the orchestrator; subagents are the hands. Fresh context on the subagent side is a feature, not a bug: prevents cross-issue pollution and keeps each session's prompt cache hot on one narrow task.

## Non-Goals

- No war room, no voice, no pika meetings (per standing preference).
- No replacing the existing `runAgent` path for non-coding turns. Messages in the PM channel that aren't issue-work still go through the standard path.
- No custom GitHub app / webhooks in the first cut — polling via `gh` CLI is enough.
- No automatic issue assignment detection in v1. Moses or the PM explicitly triggers subagent spawn.
- No cross-project subagent coordination. Each subagent is project-scoped.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  #project-manager          (Discord text channel)               │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │ PM cockpit (cmux workspace: claudeclaw-pm-<project>)      │  │
│  │   • persistent interactive claude                          │  │
│  │   • has project context.md, vault, memory                  │  │
│  │   • responds to channel messages                           │  │
│  │   • spawns subagents on /work <issue>                      │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ├── Thread: "feat: add OAuth #42"                               │
│  │   ┌────────────────────────────────────────────────────┐     │
│  │   │ Subagent cockpit                                    │     │
│  │   │   (workspace: claudeclaw-sub-<project>-<issue>)     │     │
│  │   │   • fresh claude session                             │     │
│  │   │   • briefed once at spawn                            │     │
│  │   │   • responds only inside this thread                 │     │
│  │   │   • dies on issue close / PR merge                   │     │
│  │   └────────────────────────────────────────────────────┘     │
│  │                                                                │
│  └── Thread: "fix: login redirect loop #43"                      │
│      (another subagent)                                          │
│                                                                  │
│  #logs                     (bot posts lifecycle events here)     │
└─────────────────────────────────────────────────────────────────┘
```

## Design Detail

### PM cockpit lifecycle

- On startup (when `PROJECT_AGENTS_ENABLED=true && CMUX_ENABLED=true`), for each active project manifest the bot calls `ensureWorkspace('claudeclaw-pm-<project>', { cwd: <project_cwd>, command: 'claude' })`.
- Same workspace reused across bot restarts (title is stable). cmux keeps the workspace alive as long as its app is running.
- PM receives messages: instead of `runAgent`, the bot sends the user's message to the PM's cmux workspace via `cmux.send` + `sendKey('enter')`, then polls until stable, replies with the rendered screen.
- `project_cwd` defaults to `PROJECT_ROOT` (the claudeclaw repo) unless the manifest sets `working_dir` (new optional manifest field) pointing at the actual project repo on disk (e.g. `~/Projects/archisell`).
- PM agents with no cmux cockpit (CMUX_ENABLED off) continue through the existing `runAgent` path unchanged.

### Subagent spawn — the briefing

The PM (or Moses directly) runs `/work <issue-number>` in the project channel. The bot:

1. Fetches the issue via `gh issue view <number> --repo <owner/repo> --json title,body,labels,author,comments,url`.
2. Creates a Discord thread under `#project-manager` named `<label-prefix> <title> #<number>` (e.g. `feat: add OAuth #42`).
3. Creates a fresh cmux workspace `claudeclaw-sub-<project>-<issue>` with `cwd: project_cwd, command: claude`.
4. Composes the **briefing prompt** (template below), sends it to the workspace, waits for the initial "got it" stabilisation.
5. Upserts a row in a new `subagent_sessions` table linking `{issue_number, thread_id, workspace_id, project, agent_id, started_at, status: 'running'}`.
6. Registers the thread in the Discord channel map so normal MessageCreate routing picks it up (but routes to the subagent, not the PM).

### The briefing prompt template

Deliberately minimal — fresh context is the point. Sourced from:

```
You are working on a specific GitHub issue for the <project> project.

## Issue #<number>: <title>
<body>

## Project context
<first-2k-chars of context.md>

## Repository
Working directory: <project_cwd>
Branch: <current-branch-or-issue/<number>>

## Constraints
- Match existing conventions. Don't add new dependencies without checking.
- Use `/compact` if context feels full.
- When done, write a PR description draft and pause.

## How to report progress
Short status updates back in this thread. When you have a question or hit
a decision point, ask. When the work is done, open a PR via `gh pr create`
and post the URL here.
```

The briefing is **one-shot** — the prompt is injected when the session starts, then the subagent works off it. PM can send follow-up briefings later via `/brief <more-context>` if Moses asks (phase 5d).

### Subagent routing

Discord messages in a subagent thread route to the subagent's cmux workspace, not the PM's. The routing uses the `subagent_sessions` table:

```
MessageCreate → isThread? → parentId matches #project-manager?
  → lookup subagent_sessions by thread_id
    → found + status=running: send to subagent workspace
    → not found: route to PM (normal thread routing from RFC 3)
```

### Subagent lifecycle

- **Start:** `/work <issue>` → row inserted with `status: running`.
- **Running:** messages in thread → sent to subagent workspace.
- **Done:** `/work-done` in thread (or auto-detect when a PR is posted with `gh pr create`) → `status: completed`, workspace killed via `cmux.closeWorkspace` (if cmux supports — else mark dormant), thread archived.
- **Aborted:** `/work-cancel` → `status: aborted`, workspace killed, thread renamed `[cancelled] <title>`.
- **Issue closed externally:** a periodic (5-min) reconciler polls `gh issue view` for the tracked issues; if closed, flips status to `completed` and kills the workspace.

### Subagent identity in the agent registry

Subagents do NOT get registered as full `AgentContext` entries in the registry. They're ephemeral. Memory writes from subagent sessions use `agent_id = '<project>-sub-<issue>'` so they're namespaced but not surfacing in the main PM's retrieval by default. When the issue closes, the PM can optionally consolidate the subagent's memories into the project namespace (phase 5e).

### `#logs` lifecycle events

Every subagent state change emits a log via `sendProjectLog`:

```
ℹ️ [subagent] spawned for #42 "feat: add OAuth" → thread <url> (workspace:12)
ℹ️ [subagent] #42 opened PR https://github.com/…/pull/99
ℹ️ [subagent] #42 completed — workspace killed, thread archived
⚠️ [subagent] #43 aborted by user
🔴 [subagent] #44 failed: cmux workspace died unexpectedly
```

### PM-to-subagent interaction

The PM can inspect and send to any of its subagents' workspaces via `/ask <subagent-id> "<question>"`. The subagent responds in its thread; the PM sees it via Discord the same way Moses does. This keeps the PM in the loop without creating a separate comms channel.

### GitHub issue integration

Minimal — use the `gh` CLI already installed on the machine. No new deps.

- `/issues` — lists open issues for the project's repo (from manifest field `github.repo`).
- `/work <number>` — spawn subagent for a specific issue.
- `/work-done`, `/work-cancel` — lifecycle controls inside a subagent thread.
- Periodic reconciler polls every 5 min to detect externally-closed issues and clean up.

New manifest field:
```yaml
github:
  repo: moses/archisell   # optional; when absent, /issues and /work disabled
```

## Phases

### Phase 5a — PM cockpit

**Files:**
- `src/project-manifests.ts`: add `workingDir?: string` (from YAML `working_dir`) and `github?: { repo: string }` to the interface and parser. Defaults: workingDir → PROJECT_ROOT; github → undefined.
- `src/pm-cockpit.ts` (new): `ensurePmCockpit(agentId, projectCwd)` called at bootstrap per active manifest. Returns the workspace id. On failure, log warn and continue (PM falls back to runAgent path).
- `src/bot.ts` or a new routing helper: when a message arrives in a channel mapped to a project agent AND CMUX_ENABLED AND the PM cockpit exists for that agent → send the message text to the cockpit, poll, reply. Else fall back to the existing `runAgent` path.
- `src/index.ts`: call `ensurePmCockpit` for each active manifest after `bootstrapDiscordChannelMap`.
- Tests: cockpit ensures are idempotent; cockpit failure falls back to runAgent; messages route to cockpit when both enabled.

### Phase 5b — Subagent spawn primitive

**Files:**
- Migration `0.1.2/add-subagent-sessions.ts` + entry in `version.json` + `createSchema` in `db.ts`:
  ```sql
  CREATE TABLE IF NOT EXISTS subagent_sessions (
    id TEXT PRIMARY KEY,             -- uuid
    project TEXT NOT NULL,
    agent_id TEXT NOT NULL,          -- the subagent id, e.g. "archisell-sub-42"
    issue_number INTEGER NOT NULL,
    issue_title TEXT NOT NULL,
    issue_url TEXT NOT NULL,
    thread_id TEXT NOT NULL UNIQUE,
    workspace_id TEXT NOT NULL,
    status TEXT NOT NULL,            -- running | completed | aborted | failed
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX idx_subagent_status ON subagent_sessions(status);
  CREATE INDEX idx_subagent_thread ON subagent_sessions(thread_id);
  ```
- `src/subagent-sessions.ts`: typed CRUD (`create`, `getByThreadId`, `getByIssueNumber`, `updateStatus`, `listRunning`).
- `src/subagent-spawn.ts`: `spawnSubagent({project, agentId, issueNumber, client}) → SubagentSession`. Fetches the issue via `gh`, creates the Discord thread, creates the cmux workspace, composes + sends the briefing prompt, inserts the DB row, returns the session.
- `src/subagent-briefing.ts` (optional helper): builds the briefing prompt from the template above, reads project context.md from the vault.
- Tests: briefing template renders correctly; spawn writes the DB row; spawn handles gh failure gracefully; mocked cmux/Discord integration.

### Phase 5c — `/work` + `/issues` + subagent routing

**Files:**
- `src/discord-commands.ts`: register `/work <number>`, `/work-done` (thread-only), `/work-cancel` (thread-only), `/issues`.
- Routing: extend `discord-bot.ts` message handler. Before the existing PM routing, check `subagent_sessions.getByThreadId(channelId)`. If found and running, route to subagent workspace.
- `#logs` emitters for spawn / completion / abort.
- Tests: `/work` creates session, subsequent thread messages route to the subagent workspace.

### Phase 5d — Reconciler + auto-complete

**Files:**
- `src/subagent-reconciler.ts`: every 5 min, loop running sessions, `gh issue view <n> --json state,closed`. If closed: mark completed, kill workspace, archive thread, emit log.
- Also detect PR openings from the subagent's own messages (via posted URL pattern) and annotate the session row.
- Tests: reconciler flips status when gh returns closed; safe when gh fails.

### Phase 5e — Memory consolidation on completion (optional; defer if time-bound)

- When a subagent completes, optionally run the existing consolidation flow on its memories and roll the result into the project namespace. Keeps the project's second brain growing without polluting the live namespace during work.

### Phase 5f — Docs + .env.example entries

- Update `CHANGELOG.md` Unreleased section.
- Document the manifest extensions + feature flags in `.env.example` and the project README (or a small section in `docs/`).

## Feature flags

- `PROJECT_AGENTS_ENABLED` (existing) gates the PM cockpit lifecycle.
- `CMUX_ENABLED` (existing) gates the actual cmux workspace creation. When off, the PM falls back to `runAgent`.
- `SUBAGENT_ENABLED` (new, default `false`) gates the `/work` flow. When off, `/work` and the reconciler no-op with a friendly message.

## Rollback

Flip `SUBAGENT_ENABLED=false` to kill the subagent workflow without affecting PM cockpit. Flip `CMUX_ENABLED=false` to kill both and revert to the RFC 1-3 experience. Flip `PROJECT_AGENTS_ENABLED=false` to revert to pre-RFC behaviour entirely.

## Risks

- **cmux workspace leak.** If the reconciler doesn't catch closed issues, workspaces accumulate. Mitigation: reconciler also prunes sessions older than 14 days regardless of status.
- **Briefing prompt size.** context.md + issue body can be large. Cap context.md at 2k chars (already enforced in `obsidian.ts`). Log a warning if briefing exceeds 10k chars.
- **Subagent goes rogue.** The subagent runs interactive `claude` — same permissions as the PM. Constraints in the briefing aren't enforced code-side; they're persuasion. Acceptable: it's Moses's machine.
- **Fresh context means no memory of prior issues.** That's the design. If the PM needs to share learnings, it does so in the briefing or by posting follow-ups in the thread.
- **gh authentication.** Must be logged in via `gh auth login`. Document in setup.

## Open Questions

1. Should subagents be registered as proper agents in the registry so `/ask` works on them? **Decision: no in v1.** Keep them ephemeral. PM uses `/brief <thread-url> <more-context>` to send follow-up context (phase 5d+). Moses messages directly in the thread.
2. Should the `/work` command accept a free-form prompt instead of an issue number? **Decision: no.** Fresh-context sessions without an issue anchor are what threads already do via RFC 3. `/work` is specifically the "bind this session to an issue with lifecycle tracking" command.
3. Should the subagent workspace close when the Discord thread is archived by a user? **Decision: yes**, treat archive as abort. Detect via `ThreadUpdate` event.

## Execution

Opus wrote this spec. Sonnet executes 5a → 5b → 5c sequentially; 5d and 5e are follow-ups. Each phase ships green tests before the next starts. Opus merges after 5c validates end-to-end.
