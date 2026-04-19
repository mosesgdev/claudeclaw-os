import { describe, it, expect, vi } from 'vitest';
import { TelegramChannel } from './telegram.js';

function makeFakeCtx(chatId = 12345, userName = 'moses') {
  const reply = vi.fn(async (_text: string, _opts?: any) => ({ message_id: 1 }));
  const replyWithDocument = vi.fn(async () => ({ message_id: 2 }));
  const replyWithChatAction = vi.fn(async () => true);
  return {
    chat: { id: chatId, type: 'private' },
    from: { username: userName, first_name: 'Moses' },
    reply,
    replyWithDocument,
    replyWithChatAction,
  };
}

describe('TelegramChannel', () => {
  it('uses chat id as chatKey with telegram: prefix', () => {
    const ctx = makeFakeCtx(77);
    const ch = new TelegramChannel(ctx as any);
    expect(ch.chatKey).toBe('telegram:77');
  });

  it('prefers username over first_name for userLabel', () => {
    const ctx = makeFakeCtx(77, 'mo');
    const ch = new TelegramChannel(ctx as any);
    expect(ch.userLabel).toBe('mo');
  });

  it('maxLength is 4096', () => {
    const ch = new TelegramChannel(makeFakeCtx() as any);
    expect(ch.maxLength).toBe(4096);
  });

  it('send() forwards text to ctx.reply with HTML parse_mode by default', async () => {
    const ctx = makeFakeCtx();
    const ch = new TelegramChannel(ctx as any);
    await ch.send('hello');
    expect(ctx.reply).toHaveBeenCalledWith('hello', expect.objectContaining({ parse_mode: 'HTML' }));
  });

  it('send() respects parseMode=none by omitting parse_mode', async () => {
    const ctx = makeFakeCtx();
    const ch = new TelegramChannel(ctx as any);
    await ch.send('raw', { parseMode: 'none' });
    expect(ctx.reply).toHaveBeenCalledWith('raw', expect.not.objectContaining({ parse_mode: expect.anything() }));
  });

  it('showTyping() issues a chat_action=typing', async () => {
    const ctx = makeFakeCtx();
    const ch = new TelegramChannel(ctx as any);
    await ch.showTyping();
    expect(ctx.replyWithChatAction).toHaveBeenCalledWith('typing');
  });

  it('sendFile() forwards to replyWithDocument with caption', async () => {
    const ctx = makeFakeCtx();
    const ch = new TelegramChannel(ctx as any);
    await ch.sendFile('/tmp/x.pdf', 'look at this');
    expect(ctx.replyWithDocument).toHaveBeenCalled();
  });
});
