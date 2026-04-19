import { describe, it, expect, vi } from 'vitest';
import { DiscordChannel } from './discord.js';

function makeFakeMessage(channelId = 'C1', userId = 'U1', userName = 'moses') {
  const send = vi.fn(async (_payload: any) => ({ id: 'msg1' }));
  const sendTyping = vi.fn(async () => true);
  return {
    channel: { id: channelId, send, sendTyping, isTextBased: () => true },
    author: { id: userId, username: userName, bot: false },
    content: 'hi',
    id: 'inbound1',
  };
}

describe('DiscordChannel', () => {
  it('uses channel id as chatKey with discord: prefix', () => {
    const msg = makeFakeMessage('C42');
    const ch = new DiscordChannel(msg.channel as any, msg.author as any);
    expect(ch.chatKey).toBe('discord:C42');
  });

  it('userLabel is the username', () => {
    const msg = makeFakeMessage('C1', 'U1', 'mo');
    const ch = new DiscordChannel(msg.channel as any, msg.author as any);
    expect(ch.userLabel).toBe('mo');
  });

  it('maxLength is 2000', () => {
    const msg = makeFakeMessage();
    const ch = new DiscordChannel(msg.channel as any, msg.author as any);
    expect(ch.maxLength).toBe(2000);
  });

  it('send() posts plain text (HTML is stripped because Discord has no parseMode)', async () => {
    const msg = makeFakeMessage();
    const ch = new DiscordChannel(msg.channel as any, msg.author as any);
    await ch.send('<b>hello</b> world');
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '**hello** world' })
    );
  });

  it('send() passes markdown through unchanged when parseMode=Markdown', async () => {
    const msg = makeFakeMessage();
    const ch = new DiscordChannel(msg.channel as any, msg.author as any);
    await ch.send('**bold**', { parseMode: 'Markdown' });
    expect(msg.channel.send).toHaveBeenCalledWith(
      expect.objectContaining({ content: '**bold**' })
    );
  });

  it('showTyping() calls channel.sendTyping', async () => {
    const msg = makeFakeMessage();
    const ch = new DiscordChannel(msg.channel as any, msg.author as any);
    await ch.showTyping();
    expect(msg.channel.sendTyping).toHaveBeenCalled();
  });

  it('sendFile() attaches the file via AttachmentBuilder', async () => {
    const msg = makeFakeMessage();
    const ch = new DiscordChannel(msg.channel as any, msg.author as any);
    await ch.sendFile('/tmp/x.pdf', 'caption here');
    const call = msg.channel.send.mock.calls[0][0];
    expect(call.files).toHaveLength(1);
    expect(call.content).toBe('caption here');
  });
});
