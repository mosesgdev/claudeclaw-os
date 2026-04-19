import {
  AttachmentBuilder,
  type TextBasedChannel,
  type User,
} from 'discord.js';
import type { MessageChannel, SendOptions } from './types.js';

export class DiscordChannel implements MessageChannel {
  readonly chatKey: string;
  readonly userLabel: string;
  readonly maxLength = 2000;

  constructor(
    private readonly channel: TextBasedChannel,
    private readonly author: User,
  ) {
    this.chatKey = `discord:${channel.id}`;
    this.userLabel = author.username;
  }

  async send(text: string, options?: SendOptions): Promise<void> {
    const mode = options?.parseMode ?? 'HTML';
    const body = mode === 'HTML' ? htmlToDiscordMarkdown(text) : text;
    await (this.channel as any).send({ content: body });
  }

  async sendFile(filePath: string, caption?: string): Promise<void> {
    const attachment = new AttachmentBuilder(filePath);
    await (this.channel as any).send({
      content: caption ?? '',
      files: [attachment],
    });
  }

  async showTyping(): Promise<void> {
    await (this.channel as any).sendTyping();
  }
}

/**
 * Minimal HTML -> Discord-flavored Markdown conversion.
 * Ported from legacy src/discord-bot.ts:46-97.
 *
 * Handles: <b>, <strong>, <i>, <em>, <code>, <pre>, <a href>, <br>
 * Remaining tags are stripped with the final catch-all regex.
 *
 * Known gaps (deferred to Task 10+):
 * // TODO(task 10+): <u> underline has no Discord equivalent — currently stripped
 * // TODO(task 10+): HTML entities (&amp; &lt; &gt; etc.) are not decoded
 * // TODO(task 10+): <s> strikethrough from legacy formatForDiscord is not included
 */
export function htmlToDiscordMarkdown(html: string): string {
  return html
    .replace(/<b>([\s\S]*?)<\/b>/g, '**$1**')
    .replace(/<strong>([\s\S]*?)<\/strong>/g, '**$1**')
    .replace(/<i>([\s\S]*?)<\/i>/g, '*$1*')
    .replace(/<em>([\s\S]*?)<\/em>/g, '*$1*')
    .replace(/<code>([\s\S]*?)<\/code>/g, '`$1`')
    .replace(/<pre>([\s\S]*?)<\/pre>/g, '```\n$1\n```')
    .replace(/<a href="([^"]+)">([\s\S]*?)<\/a>/g, '[$2]($1)')
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/?[^>]+>/g, '');
}
