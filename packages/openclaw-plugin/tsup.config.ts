export default {
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node18',
  bundle: true,
  dts: false,
  outDir: 'dist',
  external: ['better-sqlite3', 'chokidar'],
  noExternal: [/^@memrok\//],
  clean: true,
  onSuccess: 'cp ../scribe/src/system-prompt.md ../scribe/src/reflection-prompt.md dist/',
};
