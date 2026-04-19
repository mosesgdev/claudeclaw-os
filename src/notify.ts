import pino from 'pino';

const log = pino({ name: 'notify' });

type Sender = (text: string) => Promise<void>;
const transports = new Map<string, Sender>();

export function registerTransport(name: string, sender: Sender): void {
  transports.set(name, sender);
}

export function clearTransports(): void {
  transports.clear();
}

export async function notifyUser(text: string): Promise<void> {
  if (transports.size === 0) return;
  await Promise.all(
    [...transports.entries()].map(async ([name, send]) => {
      try {
        await send(text);
      } catch (err) {
        log.error({ err, transport: name }, 'notifyUser transport failed');
      }
    }),
  );
}
