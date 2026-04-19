import type { Message } from 'discord.js';

/**
 * Resolve the channel ID to use for agent lookup and the whitelist check.
 *
 * For thread messages, Discord fires MessageCreate with the thread as the
 * channel. The thread's parentId is the actual text channel the thread lives
 * under — which is what's stored in discord_channel_agent_map. So we route on
 * parentId for threads and on channel.id for top-level messages.
 */
export function resolveRoutingChannelId(message: Pick<Message, 'channel'>): string {
  const ch = message.channel as {
    id: string;
    isThread?: () => boolean;
    parentId?: string | null;
  };
  const isThread = typeof ch.isThread === 'function' && ch.isThread() === true;
  if (isThread && ch.parentId) {
    return ch.parentId;
  }
  return ch.id;
}

/**
 * Compute the chatKey for an inbound Discord message.
 *
 * - Thread:       discord:thread:<threadId>
 * - Top-level:   discord:channel:<channelId>
 *
 * Keeping both prefixes explicit avoids collisions between a thread and a
 * top-level channel that happen to share the same snowflake (impossible in
 * practice but defensive).
 */
export function resolveDiscordChatKey(message: Pick<Message, 'channel'>): string {
  const ch = message.channel as {
    id: string;
    isThread?: () => boolean;
  };
  const isThread = typeof ch.isThread === 'function' && ch.isThread() === true;
  return isThread ? `discord:thread:${ch.id}` : `discord:channel:${ch.id}`;
}
