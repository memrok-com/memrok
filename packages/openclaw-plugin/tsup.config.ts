import { copyFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

const __dirname = dirname(fileURLToPath(import.meta.url));

const workspaceAliases = {
  '@memrok/store': resolve(__dirname, '../store/src/index.ts'),
  '@memrok/injector': resolve(__dirname, '../injector/src/index.ts'),
  '@memrok/scribe': resolve(__dirname, '../scribe/src/index.ts'),
  '@memrok/daemon': resolve(__dirname, '../daemon/src/index.ts'),
};

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  bundle: true,
  dts: false,
  outDir: 'dist',
  skipNodeModulesBundle: false,
  external: ['node:sqlite'],
  noExternal: ['chokidar', /^@memrok\//],
  clean: true,
  onSuccess: async () => {
    copyFileSync(
      resolve(__dirname, '../scribe/src/system-prompt.md'),
      resolve(__dirname, 'dist/system-prompt.md'),
    );
    copyFileSync(
      resolve(__dirname, '../scribe/src/reflection-prompt.md'),
      resolve(__dirname, 'dist/reflection-prompt.md'),
    );
  },
  esbuildOptions(options) {
    options.alias = {
      ...(options.alias ?? {}),
      ...workspaceAliases,
    };
  },
});
