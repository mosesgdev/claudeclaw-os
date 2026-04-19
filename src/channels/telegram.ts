import type { Context, InputFile as GrammyInputFile } from 'grammy';
import { InputFile } from 'grammy';
import type { MessageChannel, SendOptions } from './types.js';

export class TelegramChannel implements MessageChannel {
  readonly chatKey: string;
  readonly userLabel: string;
  readonly maxLength = 4096;

  constructor(private readonly ctx: Context) {
    const chatId = ctx.chat?.id ?? 0;
    this.chatKey = `telegram:${chatId}`;
    this.userLabel =
      ctx.from?.username ?? ctx.from?.first_name ?? `tg-${chatId}`;
  }

  async send(text: string, options?: SendOptions): Promise<void> {
    const replyOptions: Record<string, unknown> = {};
    const mode = options?.parseMode ?? 'HTML';
    if (mode !== 'none') replyOptions.parse_mode = mode;
    if (options?.replyToMessageId) {
      replyOptions.reply_to_message_id = Number(options.replyToMessageId);
    }
    if (options?.silent) replyOptions.disable_notification = true;
    await this.ctx.reply(text, replyOptions as any);
  }

  async sendFile(filePath: string, caption?: string): Promise<void> {
    const file: GrammyInputFile = new InputFile(filePath);
    await this.ctx.replyWithDocument(file, caption ? { caption } : undefined);
  }

  async showTyping(): Promise<void> {
    await this.ctx.replyWithChatAction('typing');
  }
}
