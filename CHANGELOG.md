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

## [v1.1.1] - 2026-03-06

### Added
- Migration system with versioned migration files
- `add-migration` Claude skill for scaffolding new versioned migrations
