import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from 'discord.js';
import { DiscordChannel } from './channels/discord.js';
import type { InboundMessage } from './channels/types.js';
import { discordConfig } from './config.js';
import { handleMessage } from './bot.js';
import { setDiscordConnected } from './state.js';
import { registerSlashCommands, wireSlashCommands } from './discord-commands.js';
import { logger } from './logger.js';
import {
  downloadDiscordAttachment,
  buildPhotoMessage,
  buildVideoMessage,
  buildDocumentMessage,
} from './media.js';

const log = logger.child({ name: 'discord-bot' });

export function createDiscordBot(): Client | null {
  if (!discordConfig.enabled) {
    log.info('Discord disabled (no DISCORD_BOT_TOKEN set) — skipping client creation');
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      // DirectMessages is enabled so the intent set is ready for Task 15+ DM support.
      // DM routing is intentionally suppressed now via the guildId filter below.
      GatewayIntentBits.DirectMessages,
    ],
  });

  // Single merged ClientReady handler: logs ready state and registers slash
  // commands. Registration is wrapped in try/catch so a REST failure does not
  // prevent the bot from logging in and handling messages.
  client.once(Events.ClientReady, async (c) => {
    log.info({ tag: c.user.tag }, 'Discord client ready');
    setDiscordConnected(true);
    try {
      await registerSlashCommands(c.user.id);
    } catch (err) {
      log.error({ err }, 'failed to register slash commands');
    }
  });

  client.on(Events.ShardDisconnect, () => setDiscordConnected(false));

  wireSlashCommands(client);

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    // Guild boundary — drop messages from other servers AND DMs (DMs have no guildId).
    // allowedChannelIds filter below is skipped for DMs even if the list were non-empty.
    if (message.guildId !== discordConfig.guildId) return;

    // Channel whitelist — an empty allowedChannelIds means "every channel in the guild".
    // Explicitly populated lists restrict routing to those channel IDs only.
    if (
      discordConfig.allowedChannelIds.length > 0 &&
      !discordConfig.allowedChannelIds.includes(message.channel.id)
    ) {
      return;
    }

    const channel = new DiscordChannel(message.channel as any, message.author);

    // If the user attached a file, download the first one and hand Claude the
    // local path via the same build*Message helpers the Telegram per-type
    // handlers use. Discord allows up to 10 attachments per message; v1 only
    // processes the first. Download failures degrade to plain-text handling.
    let text = message.content;
    const firstAttachment = message.attachments.first();
    if (firstAttachment) {
      try {
        const localPath = await downloadDiscordAttachment(
          firstAttachment.url,
          firstAttachment.name ?? 'file',
        );
        const mime = firstAttachment.contentType ?? '';
        const caption = message.content || undefined;
        if (mime.startsWith('image/')) {
          text = buildPhotoMessage(localPath, caption);
        } else if (mime.startsWith('video/')) {
          text = buildVideoMessage(localPath, caption);
        } else {
          text = buildDocumentMessage(localPath, firstAttachment.name ?? 'file', caption);
        }
      } catch (err) {
        log.error(
          { err, url: firstAttachment.url, chatKey: channel.chatKey },
          'Discord attachment download failed',
        );
      }
    }

    const inbound: InboundMessage = {
      text,
      chatKey: channel.chatKey,
      userLabel: channel.userLabel,
      attachments: [...message.attachments.values()].map((att) => ({
        kind: classifyAttachmentKind(att.contentType),
        url: att.url,
        mimeType: att.contentType ?? undefined,
        filename: att.name,
      })),
      rawMessageId: message.id,
    };

    try {
      await handleMessage(channel, inbound);
    } catch (err) {
      log.error({ err, chatKey: channel.chatKey }, 'discord handleMessage failed');
      try {
        await channel.send('sorry, I hit an error handling that');
      } catch {
        // best-effort: a send failure here (rate limit, destroyed channel) must
        // not surface as an unhandled rejection on the event loop
      }
    }
  });

  return client;
}

function classifyAttachmentKind(
  mime: string | null | undefined,
): 'photo' | 'document' | 'voice' | 'video' {
  if (!mime) return 'document';
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('audio/')) return 'voice';
  if (mime.startsWith('video/')) return 'video';
  return 'document';
}
