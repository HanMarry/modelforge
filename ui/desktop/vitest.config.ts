/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const cfg = {
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // Script tests load the CommonJS scripts through `createRequire` and declare
    // `// @vitest-environment node`; src/test/setup.ts skips its DOM mocks for them.
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}', 'scripts/**/*.test.{js,mjs}'],
  },
} satisfies Record<string, any>;

export default defineConfig(cfg as any);
