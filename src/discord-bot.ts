import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
} from 'discord.js';
import { DiscordChannel } from './channels/discord.js';
import type { InboundMessage } from './channels/types.js';
import { discordConfig, PROJECT_AGENTS_ENABLED, SUBAGENT_ENABLED } from './config.js';
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
import { lookupAgentForChannel } from './discord-channel-map.js';
import { getRegistryContext } from './agent-registry.js';
import { resolveRoutingChannelId, resolveDiscordChatKey } from './discord-routing.js';
import type { AgentContext } from './agent-context.js';
import { getByThreadId } from './subagent-sessions.js';
import * as cmux from './cmux.js';
import { pollUntilStable } from './cmux-command.js';

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

  // Track websocket connectivity across the whole shard lifecycle, not just
  // the initial login — ClientReady fires exactly once, so a mid-runtime drop
  // needs ShardReady / ShardResume to flip the indicator back to connected.
  client.on(Events.ShardDisconnect, (_event, shardId) => {
    log.warn({ shardId }, 'Discord shard disconnected');
    setDiscordConnected(false);
  });
  client.on(Events.ShardReady, (shardId) => {
    log.info({ shardId }, 'Discord shard ready');
    setDiscordConnected(true);
  });
  client.on(Events.ShardResume, (shardId) => {
    log.info({ shardId }, 'Discord shard resumed');
    setDiscordConnected(true);
  });

  wireSlashCommands(client);

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;

    // Guild boundary — drop messages from other servers AND DMs (DMs have no guildId).
    // allowedChannelIds filter below is skipped for DMs even if the list were non-empty.
    if (message.guildId !== discordConfig.guildId) return;

    // ── Routing precedence: subagent > PM thread > default ────────────────────
    // 1. If the channel is a thread AND SUBAGENT_ENABLED AND the thread is
    //    tracked as a running subagent session, send to the subagent's cmux
    //    workspace and return early — do NOT fall through to PM routing or runAgent.
    // 2. If the session exists but is not running, fall through (treat as normal thread).
    // 3. If not a subagent thread, or flag off, continue with existing routing.
    if (SUBAGENT_ENABLED && message.channel.isThread()) {
      const subSession = getByThreadId(message.channel.id);
      if (subSession) {
        if (subSession.status === 'running') {
          const text = message.content;
          try {
            await cmux.send(subSession.workspaceId, text);
            await cmux.sendKey(subSession.workspaceId, 'enter');
            const screen = await pollUntilStable(subSession.workspaceId, 60_000);
            const capped = screen.slice(-1900);
            await message.channel.send('```\n' + capped + '\n```');
          } catch (err) {
            log.error({ err, workspaceId: subSession.workspaceId }, 'subagent cmux routing failed');
            try {
              await message.channel.send('subagent error — check logs');
            } catch {
              // best-effort
            }
          }
          return;
        } else {
          log.debug(
            { threadId: message.channel.id, status: subSession.status },
            'subagent thread exists but not running — falling through to normal routing',
          );
        }
      }
    }

    // Resolve the channel ID to use for agent lookup. For thread messages,
    // this is the parent text channel's ID (the one stored in the map).
    const routingChannelId = resolveRoutingChannelId(message);

    // Project-agent channel routing (feature-gated).
    // If the incoming channel (or its thread parent) is mapped to a project
    // agent, use that agent's context instead of the default. The mapping IS
    // the ACL — no additional allowedChannelIds check is needed for routed channels.
    let overrideCtx: AgentContext | undefined;
    if (PROJECT_AGENTS_ENABLED) {
      const routedAgentId = lookupAgentForChannel(routingChannelId);
      if (routedAgentId) {
        const ctx = getRegistryContext(routedAgentId);
        if (ctx) {
          overrideCtx = ctx;
        } else {
          log.warn(
            { channelId: routingChannelId, agentId: routedAgentId },
            'Channel mapped to unknown agent; falling back to default',
          );
        }
      }
    }

    // If NOT routed via project agent, enforce the existing channel whitelist.
    // Threads inherit the parent's whitelist membership.
    if (!overrideCtx) {
      if (
        discordConfig.allowedChannelIds.length > 0 &&
        !discordConfig.allowedChannelIds.includes(routingChannelId)
      ) {
        return;
      }
    }

    const chatKey = resolveDiscordChatKey(message);
    const channel = new DiscordChannel(message.channel as any, message.author, chatKey);

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
      await handleMessage(channel, inbound, false, false, overrideCtx);
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
