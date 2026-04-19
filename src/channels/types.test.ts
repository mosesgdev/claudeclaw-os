import { describe, it, expectTypeOf } from 'vitest';
import type { Attachment, MessageChannel, InboundMessage, SendOptions } from './types.js';

describe('MessageChannel interface', () => {
  it('exposes the six core methods with exact signatures', () => {
    expectTypeOf<MessageChannel>().toHaveProperty('chatKey').toBeString();
    expectTypeOf<MessageChannel>().toHaveProperty('userLabel').toBeString();
    expectTypeOf<MessageChannel>().toHaveProperty('maxLength').toBeNumber();
    expectTypeOf<MessageChannel['send']>().parameters.toEqualTypeOf<[text: string, options?: SendOptions]>();
    expectTypeOf<MessageChannel['send']>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<MessageChannel['sendFile']>().parameters.toEqualTypeOf<[filePath: string, caption?: string]>();
    expectTypeOf<MessageChannel['sendFile']>().returns.toEqualTypeOf<Promise<void>>();
    expectTypeOf<MessageChannel['showTyping']>().parameters.toEqualTypeOf<[]>();
    expectTypeOf<MessageChannel['showTyping']>().returns.toEqualTypeOf<Promise<void>>();
  });

  it('InboundMessage carries text, attachments, and chat identity', () => {
    expectTypeOf<InboundMessage>().toHaveProperty('text').toBeString();
    expectTypeOf<InboundMessage>().toHaveProperty('chatKey').toBeString();
    expectTypeOf<InboundMessage>().toHaveProperty('userLabel').toBeString();
    expectTypeOf<InboundMessage>().toHaveProperty('attachments').toEqualTypeOf<Attachment[]>();
  });
});
