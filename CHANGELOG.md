# Changelog

All notable changes to ClaudeClaw will be documented here.

## [Unreleased]

### Added — RFC 1: Project Agents (merged)
- `AgentContext` type threaded through the hot path (`bot.ts`, `agent.ts`, `orchestrator.ts`).
- Vault-driven project manifests read from `<vault>/04-projects/<project>/context.md` frontmatter.
- `discord_channel_agent_map` table + bootstrap that resolves category/channel by name.
- `/reload-agents` Discord slash command.
- Feature flag: `PROJECT_AGENTS_ENABLED` (default false). `VAULT_PROJECTS_ROOT` env var.

### Added — RFC 2: Obsidian Write + Vault Bridge
- `memory_vault_links` table + `memory-dedupe-cli` (check / set-vault-path / neighbors).
- `vault-bridge-cli` (write / close-task / update-backlinks) with atomic writes, frontmatter, wiki-link injection via memory-graph neighbors, dedupe at 0.85 cosine.
- Memory mirror hook: memories ≥ 0.7 importance mirrored to `06-claudeclaw/learnings/` via the bridge.
- Consolidation mirror hook: consolidation insights ≥ 0.7 mirrored to `06-claudeclaw/reflections/`.
- Extended `obsidian.ts` read path: surfaces `moses-profile.md`, `05-knowledge/`, and `06-claudeclaw/learnings/` summaries into agent context when enabled.
- Companion skill: `~/agentic-master/skills/obsidian-write/` (shells into the bridge) + `~/agentic-master/expertise/obsidian-vault.yaml`.
- Feature flag: `OBSIDIAN_WRITE_ENABLED` (default false). `AGENTIC_MASTER_ROOT` env var.

### Added — RFC 3: Discord Project Channels
- Manifest frontmatter accepts `discord.logs_channel` (default `"logs"`).
- Thread routing: messages in a thread under a mapped channel inherit the parent's agent and get a `discord:thread:<id>` chatKey so conversation sessions stay isolated per thread while memory remains project-scoped.
- Logs channel: structured bot events (memory saves, scheduled task start/done/fail, mission delegations, handleMessage errors) posted to the project's `#logs` channel via `sendProjectLog`.
- `/ask <agent> <prompt>` slash command with autocomplete for cross-agent delegation.

### Added — cmux streamline
- `src/cmux-command.ts` channel-agnostic handler for `/cmux` (Telegram + Discord).
- `pollUntilStable` replaces the fixed 6s sleep: reads the screen every 1.5s, returns on two identical reads or after a 45s hard cap.
- Per-agent workspace titles (`claudeclaw-<agent>-<chat>`) so project PMs each own a workspace.
- Discord `/cmux <prompt?>` slash command.
- Feature flag: `CMUX_ENABLED` (default false).

### Added — RFC 5: PM Cockpit + Fresh-Context Subagents
- PM cockpit: persistent cmux workspace per project agent. When `PROJECT_AGENTS_ENABLED && CMUX_ENABLED`, messages in the project's PM channel go to the cockpit instead of `runAgent`.
- `subagent_sessions` table + spawn primitive (`src/subagent-spawn.ts`) that fetches a GitHub issue via `gh`, creates a Discord thread, creates a cmux workspace, composes a briefing prompt, and persists the session.
- Subagent thread routing: messages in a tracked subagent thread go to the subagent's cmux workspace, with subagent > PM thread > default routing precedence.
- New slash commands: `/issues`, `/work <number>`, `/work-done`, `/work-cancel`.
- Manifest extensions: `working_dir` and `github.repo`.
- Feature flag: `SUBAGENT_ENABLED` (default false). Requires `CMUX_ENABLED` + `PROJECT_AGENTS_ENABLED`.

## [v1.1.1] - 2026-03-06

### Added
- Migration system with versioned migration files
- `add-migration` Claude skill for scaffolding new versioned migrations
