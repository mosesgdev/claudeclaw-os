import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerTransport, clearTransports, notifyUser } from './notify.js';

describe('notifyUser', () => {
  beforeEach(() => clearTransports());

  it('sends the same text to every registered transport', async () => {
    const tg = vi.fn(async () => {});
    const dc = vi.fn(async () => {});
    registerTransport('telegram', tg);
    registerTransport('discord', dc);

    await notifyUser('hello');

    expect(tg).toHaveBeenCalledWith('hello');
    expect(dc).toHaveBeenCalledWith('hello');
  });

  it('tolerates one transport failing without aborting the other', async () => {
    const tg = vi.fn(async () => {
      throw new Error('telegram down');
    });
    const dc = vi.fn(async () => {});
    registerTransport('telegram', tg);
    registerTransport('discord', dc);

    await notifyUser('hi');
    expect(dc).toHaveBeenCalledWith('hi');
  });

  it('is a no-op when no transports are registered', async () => {
    await expect(notifyUser('silent')).resolves.toBeUndefined();
  });

  it('tolerates a sender that throws synchronously (non-async body)', async () => {
    const bad = (() => { throw new Error('sync boom'); }) as unknown as (t: string) => Promise<void>;
    const good = vi.fn(async () => {});
    registerTransport('bad', bad);
    registerTransport('good', good);

    await expect(notifyUser('x')).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledWith('x');
  });
});
