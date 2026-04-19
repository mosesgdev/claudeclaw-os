import { describe, it, expectTypeOf } from 'vitest';
import type { MessageChannel, InboundMessage } from './types.js';

describe('MessageChannel interface', () => {
  it('exposes the six core methods', () => {
    expectTypeOf<MessageChannel>().toHaveProperty('send').toBeFunction();
    expectTypeOf<MessageChannel>().toHaveProperty('sendFile').toBeFunction();
    expectTypeOf<MessageChannel>().toHaveProperty('showTyping').toBeFunction();
    expectTypeOf<MessageChannel>().toHaveProperty('chatKey').toBeString();
    expectTypeOf<MessageChannel>().toHaveProperty('userLabel').toBeString();
    expectTypeOf<MessageChannel>().toHaveProperty('maxLength').toBeNumber();
  });

  it('InboundMessage carries text, optional attachments, and chat identity', () => {
    expectTypeOf<InboundMessage>().toHaveProperty('text').toBeString();
    expectTypeOf<InboundMessage>().toHaveProperty('chatKey').toBeString();
    expectTypeOf<InboundMessage>().toHaveProperty('userLabel').toBeString();
    expectTypeOf<InboundMessage>().toHaveProperty('attachments');
  });
});
