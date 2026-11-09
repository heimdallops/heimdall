import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'index.sea': 'src/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: false,
  sourcemap: false,
  dts: false,
  splitting: false,
  // Keep node: prefixes: prefix-only builtins like node:sea don't resolve without them.
  removeNodeProtocol: false,
  noExternal: [/.*/],
  shims: true,
});
