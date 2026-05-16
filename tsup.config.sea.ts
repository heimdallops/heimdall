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
  noExternal: [/.*/],
});
