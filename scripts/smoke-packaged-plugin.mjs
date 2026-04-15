#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = new URL('..', import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), 'memrok-plugin-pack-'));

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

try {
  const packOutput = run('npm', [
    'pack',
    '--workspace',
    'packages/openclaw-plugin',
    '--pack-destination',
    tmp,
  ]);
  const tarballName = packOutput.trim().split('\n').at(-1);
  assert(tarballName, 'npm pack did not report a tarball name');
  const tarballPath = join(tmp, tarballName);

  const listing = run('tar', ['-tzf', tarballPath]).trim().split('\n').sort();
  const requiredEntries = [
    'package/README.md',
    'package/dist/index.d.ts',
    'package/dist/index.js',
    'package/dist/reflection-prompt.md',
    'package/dist/system-prompt.md',
    'package/openclaw.plugin.json',
    'package/package.json',
  ];

  for (const entry of requiredEntries) {
    assert(listing.includes(entry), `Packaged plugin missing ${entry}`);
  }

  assert(
    !listing.some((entry) => entry.startsWith('package/src/')),
    'Packaged plugin unexpectedly includes src/ files',
  );

  run('tar', ['-xzf', tarballPath, '-C', tmp]);
  const pkg = JSON.parse(readFileSync(join(tmp, 'package', 'package.json'), 'utf8'));
  const manifest = JSON.parse(readFileSync(join(tmp, 'package', 'openclaw.plugin.json'), 'utf8'));

  assert(pkg.name === 'memrok', `Unexpected package name: ${pkg.name}`);
  assert(pkg.main === 'dist/index.js', `Unexpected package main: ${pkg.main}`);
  assert(pkg.openclaw?.extensions?.includes('./dist/index.js'), 'package.json missing OpenClaw extension entry');
  assert(manifest.id === 'memrok', `Unexpected plugin manifest id: ${manifest.id}`);
  assert(manifest.configSchema?.properties?.evalEvents, 'Plugin manifest missing evalEvents config schema');

  console.log('## Memrok Packaged Plugin Smoke');
  console.log(`tarball: ${tarballName}`);
  console.log(`entries: ${listing.length}`);
  console.log('status: pass');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
