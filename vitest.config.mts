import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    alias: { obsidian: fileURLToPath(new URL('./tests/helpers/obsidian.ts', import.meta.url)) },
  },
});
