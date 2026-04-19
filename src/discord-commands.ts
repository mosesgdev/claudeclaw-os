import {
  Client,
  Events,
  REST,
  Routes,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { discordConfig } from './config.js';
import { clearSession, listMemories, forgetMemory } from './session-ops.js';
import { logger } from './logger.js';

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
