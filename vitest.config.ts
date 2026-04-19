import { defineConfig } from 'vitest/config';

// Integration tests (*.integration.test.ts) hit real external services
// (Telegram Bot API, etc.) and are excluded from the default `vitest run`.
// Run them explicitly: `vitest run src/<name>.integration.test.ts`
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/**/*.integration.test.ts'],
  },
});
