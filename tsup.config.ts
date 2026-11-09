import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  splitting: false,
  // Keep node: prefixes: prefix-only builtins like node:sea don't resolve without them.
  removeNodeProtocol: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
