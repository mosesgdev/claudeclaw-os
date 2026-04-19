import { Client, ChannelType } from 'discord.js';

import { discordConfig, PROJECT_AGENTS_ENABLED } from './config.js';
import {
  getRegistryEntries,
  initAgentRegistry,
} from './agent-registry.js';
import {
  upsertMapping,
  clearStaleMappings,
  listMappings,
} from './discord-channel-map.js';
import { logger } from './logger.js';

const log = logger.child({ name: 'discord-bootstrap' });

/**
 * Called after Discord client ready. For each manifest-sourced registry entry,
 * resolve (category, channel) by name in the configured guild, upsert into
 * discord_channel_agent_map. Missing categories/channels are logged and skipped.
 * Stale mappings (agent removed or archived) are cleared.
 *
 * No-ops when PROJECT_AGENTS_ENABLED is false.
 */
export async function bootstrapDiscordChannelMap(client: Client): Promise<void> {
  if (!PROJECT_AGENTS_ENABLED) return;

  if (!discordConfig.guildId) {
    log.warn('Discord enabled but DISCORD_GUILD_ID unset; skipping channel map bootstrap');
    return;
  }

  // Ensure registry is populated before we iterate over it.
  initAgentRegistry();

  const guild = await client.guilds.fetch(discordConfig.guildId).catch((err) => {
    log.error({ err, guildId: discordConfig.guildId }, 'Failed to fetch guild');
    return null;
  });
  if (!guild) return;

  const channels = await guild.channels.fetch();

  const entries = getRegistryEntries().filter((e) => e.source === 'manifest' && e.manifest);
  const activeAgentIds: string[] = [];

  for (const entry of entries) {
    const m = entry.manifest!;

    // Find category by name
    const category = [...channels.values()].find(
      (c): c is NonNullable<typeof c> =>
        !!c && c.type === ChannelType.GuildCategory && c.name === m.discord.category,
    );
    if (!category) {
      log.error(
        { project: m.project, category: m.discord.category },
        'Discord category not found; skipping project agent',
      );
      continue;
    }

    // Find text channel by name under that category
    const channel = [...channels.values()].find(
      (c): c is NonNullable<typeof c> =>
        !!c &&
        c.type === ChannelType.GuildText &&
        'parentId' in c &&
        (c as { parentId: string | null }).parentId === category.id &&
        c.name === m.discord.primaryChannel,
    );
    if (!channel) {
      log.error(
        {
          project: m.project,
          channel: m.discord.primaryChannel,
          category: m.discord.category,
        },
        'Discord channel not found under category; skipping',
      );
      continue;
    }

    upsertMapping({
      channelId: channel.id,
      guildId: guild.id,
      agentId: entry.id,
      project: m.project,
      categoryName: m.discord.category,
      channelName: m.discord.primaryChannel,
    });
    activeAgentIds.push(entry.id);
    log.info(
      { project: m.project, agentId: entry.id, channelId: channel.id },
      'Mapped Discord channel to project agent',
    );
  }

  // Preserve yaml-agent mappings (there should be none at this stage, but
  // future-proof: a yaml agent might be explicitly mapped out-of-band).
  const yamlAgentIds = getRegistryEntries()
    .filter((e) => e.source === 'yaml')
    .map((e) => e.id);

  const deleted = clearStaleMappings([...activeAgentIds, ...yamlAgentIds]);
  if (deleted > 0) log.info({ count: deleted }, 'Cleared stale channel mappings');

  log.info(
    { active: activeAgentIds.length, total: listMappings().length },
    'Discord channel map bootstrap complete',
  );
}
