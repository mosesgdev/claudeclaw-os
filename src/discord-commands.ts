import {
  Client,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type AutocompleteInteraction,
} from 'discord.js';
import { discordConfig, PROJECT_AGENTS_ENABLED } from './config.js';
import { clearSession, listMemories, forgetMemory } from './session-ops.js';
import { logger } from './logger.js';
import { rebuildRegistry } from './agent-registry.js';
import { bootstrapDiscordChannelMap } from './discord-bootstrap.js';
import { delegateToAgent, getAvailableAgents } from './orchestrator.js';
import { lookupAgentForChannel } from './discord-channel-map.js';

const log = logger.child({ name: 'discord-commands' });

export const slashCommands = [
  new SlashCommandBuilder()
    .setName('newchat')
    .setDescription('Reset the current Claude session for this channel'),
  new SlashCommandBuilder()
    .setName('memory')
    .setDescription('List recent memories for this chat'),
  new SlashCommandBuilder()
    .setName('forget')
    .setDescription('Forget a specific memory by id')
    .addStringOption((o) =>
      o.setName('id').setDescription('Memory id').setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('reload-agents')
    .setDescription('Rescan project manifests and re-map Discord channels (requires PROJECT_AGENTS_ENABLED)'),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask a named agent a question')
    .addStringOption((o) =>
      o
        .setName('agent')
        .setDescription('Agent id (main, research, comms, content, ops, or a project agent)')
        .setRequired(true)
        .setAutocomplete(true),
    )
    .addStringOption((o) =>
      o
        .setName('prompt')
        .setDescription('What to ask the agent')
        .setRequired(true),
    ),
].map((c) => c.toJSON());

export async function registerSlashCommands(clientId: string): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(discordConfig.botToken);
  await rest.put(
    Routes.applicationGuildCommands(clientId, discordConfig.guildId),
    { body: slashCommands },
  );
  log.info({ count: slashCommands.length }, 'slash commands registered');
}

export function wireSlashCommands(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    // Handle autocomplete for /ask agent option
    if (interaction.isAutocomplete()) {
      await handleAutocomplete(interaction as AutocompleteInteraction);
      return;
    }

    if (!interaction.isChatInputCommand()) return;

    // Guild boundary — drop interactions from other servers or DMs.
    if (interaction.guildId !== discordConfig.guildId) {
      await interaction.reply({ content: 'not allowed here', ephemeral: true });
      return;
    }

    // Channel whitelist — empty allowedChannelIds means "every channel in the guild".
    if (
      discordConfig.allowedChannelIds.length > 0 &&
      !discordConfig.allowedChannelIds.includes(interaction.channelId)
    ) {
      await interaction.reply({ content: 'not allowed here', ephemeral: true });
      return;
    }

    try {
      switch (interaction.commandName) {
        case 'newchat':
          return await onNewChat(interaction);
        case 'memory':
          return await onMemory(interaction);
        case 'forget':
          return await onForget(interaction);
        case 'reload-agents':
          return await onReloadAgents(interaction, interaction.client);
        case 'ask':
          return await onAsk(interaction);
      }
    } catch (err) {
      log.error({ err, cmd: interaction.commandName }, 'slash command failed');
      try {
        await interaction.reply({ content: 'command failed — check logs', ephemeral: true });
      } catch {
        // best-effort: interaction may have already been replied to
      }
    }
  });
}

async function onNewChat(i: ChatInputCommandInteraction): Promise<void> {
  const chatKey = `discord:${i.channelId}`;
  clearSession(chatKey);
  await i.reply({ content: 'new chat — session cleared' });
}

async function onMemory(i: ChatInputCommandInteraction): Promise<void> {
  const chatKey = `discord:${i.channelId}`;
  const memories = listMemories(chatKey);
  if (memories.length === 0) {
    await i.reply({ content: 'no memories yet' });
    return;
  }
  const lines = memories
    .slice(0, 10)
    .map((m) => `• \`${m.id}\` — ${m.content}`);
  // Truncate at the last newline before 2000 chars so we never slice mid-line
  // and orphan a backtick pair, which Discord renders as broken inline code.
  const joined = lines.join('\n');
  const content =
    joined.length <= 1990
      ? joined
      : joined.slice(0, joined.lastIndexOf('\n', 1990));
  await i.reply({ content });
}

async function onForget(i: ChatInputCommandInteraction): Promise<void> {
  const id = i.options.getString('id', true);
  const deleted = forgetMemory(id);
  await i.reply({
    content: deleted
      ? `forgot memory \`${id}\``
      : `no memory with id \`${id}\``,
  });
}

async function onReloadAgents(i: ChatInputCommandInteraction, client: Client): Promise<void> {
  if (!PROJECT_AGENTS_ENABLED) {
    await i.reply({ content: 'PROJECT_AGENTS_ENABLED is false — nothing to reload', ephemeral: true });
    return;
  }
  await i.deferReply({ ephemeral: true });
  try {
    rebuildRegistry();
    await bootstrapDiscordChannelMap(client);
    await i.editReply('Agent registry rebuilt and Discord channel map refreshed.');
  } catch (err) {
    log.error({ err }, 'reload-agents failed');
    await i.editReply('Reload failed — check logs for details.');
  }
}

async function handleAutocomplete(interaction: AutocompleteInteraction): Promise<void> {
  if (interaction.commandName !== 'ask') return;

  const focused = interaction.options.getFocused();
  const agents = getAvailableAgents();
  const focusedLower = focused.toLowerCase();

  const choices = agents
    .filter((a) => a.id.toLowerCase().startsWith(focusedLower))
    .slice(0, 25)
    .map((a) => ({ name: a.id, value: a.id }));

  await interaction.respond(choices);
}

async function onAsk(i: ChatInputCommandInteraction): Promise<void> {
  const agentId = i.options.getString('agent', true);
  const prompt = i.options.getString('prompt', true);

  // Acknowledge quickly — delegation may take many seconds
  await i.deferReply();

  if (!i.channel) {
    await i.editReply('could not resolve channel — try again');
    return;
  }

  // Resolve chatKey matching the channel/thread the command came from.
  // Threads: discord:thread:<threadId>; channels: discord:channel:<channelId>
  const isThread = i.channel.isThread?.() === true;
  const chatKey = isThread
    ? `discord:thread:${i.channel.id}`
    : `discord:channel:${i.channel.id}`;

  // fromAgent: if the channel is mapped to a project agent, delegate from that agent;
  // otherwise default to 'main'. Use lookupAgentForChannel with the routing channel id.
  const routingChannelId =
    isThread && (i.channel as { parentId?: string | null }).parentId
      ? (i.channel as { parentId: string }).parentId
      : i.channel.id;
  const fromAgent = lookupAgentForChannel(routingChannelId) ?? 'main';

  try {
    const result = await delegateToAgent(agentId, prompt, chatKey, fromAgent);
    const text = result.text ?? '(no response)';
    const truncated = text.length > 1900 ? text.slice(0, 1900) + '...' : text;
    await i.editReply(truncated);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await i.editReply(`ask failed: ${msg}`.slice(0, 1900));
  }
}
