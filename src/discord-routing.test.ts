import { describe, it, expect } from 'vitest';
import { resolveRoutingChannelId, resolveDiscordChatKey } from './discord-routing.js';

function makeMessage(opts: {
  channelId: string;
  isThread?: boolean;
  parentId?: string | null;
}) {
  return {
    channel: {
      id: opts.channelId,
      isThread: opts.isThread !== undefined ? () => opts.isThread! : undefined,
      parentId: opts.parentId ?? null,
    },
  };
}

describe('resolveRoutingChannelId', () => {
  it('returns channel.id for a non-thread message', () => {
    const msg = makeMessage({ channelId: 'C1', isThread: false });
    expect(resolveRoutingChannelId(msg as any)).toBe('C1');
  });

  it('returns parentId for a thread message', () => {
    const msg = makeMessage({ channelId: 'T1', isThread: true, parentId: 'C1' });
    expect(resolveRoutingChannelId(msg as any)).toBe('C1');
  });

  it('falls back to channel.id when isThread is true but parentId is null', () => {
    const msg = makeMessage({ channelId: 'T1', isThread: true, parentId: null });
    expect(resolveRoutingChannelId(msg as any)).toBe('T1');
  });

  it('returns channel.id when isThread method is absent', () => {
    const msg = makeMessage({ channelId: 'C1' }); // no isThread
    expect(resolveRoutingChannelId(msg as any)).toBe('C1');
  });
});

describe('resolveDiscordChatKey', () => {
  it('produces discord:channel:<id> for a top-level message', () => {
    const msg = makeMessage({ channelId: 'C42', isThread: false });
    expect(resolveDiscordChatKey(msg as any)).toBe('discord:channel:C42');
  });

  it('produces discord:thread:<id> for a thread message', () => {
    const msg = makeMessage({ channelId: 'T99', isThread: true, parentId: 'C42' });
    expect(resolveDiscordChatKey(msg as any)).toBe('discord:thread:T99');
  });

  it('produces discord:channel:<id> when isThread is absent', () => {
    const msg = makeMessage({ channelId: 'C1' });
    expect(resolveDiscordChatKey(msg as any)).toBe('discord:channel:C1');
  });
});
