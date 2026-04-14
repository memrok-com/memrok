#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InjectionEvalFixture, InjectionEvalRun } from '../packages/injector/src/index.js';
import { compareInjectionEvalRuns, runInjectionEvalFixtures } from '../packages/injector/src/index.js';

interface Options {
  fixturesDir: string;
  fixtureIds: string[];
  json: boolean;
  outputPath: string | null;
  baselinePath: string | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    fixturesDir: path.resolve(process.cwd(), 'fixtures/injection-evals'),
    fixtureIds: [],
    json: false,
    outputPath: null,
    baselinePath: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fixtures-dir' && argv[i + 1]) options.fixturesDir = path.resolve(argv[++i]);
    else if (arg === '--fixture' && argv[i + 1]) options.fixtureIds.push(argv[++i]);
    else if (arg === '--json') options.json = true;
    else if (arg === '--out' && argv[i + 1]) options.outputPath = argv[++i];
    else if (arg === '--baseline' && argv[i + 1]) options.baselinePath = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function loadFixtures(fixturesDir: string, fixtureIds: string[]): InjectionEvalFixture[] {
  const fixtures = fs.readdirSync(fixturesDir)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(fs.readFileSync(path.join(fixturesDir, file), 'utf8')) as InjectionEvalFixture);

  if (fixtureIds.length === 0) return fixtures;
  const wanted = new Set(fixtureIds);
  return fixtures.filter((fixture) => wanted.has(fixture.id));
}

function emit(text: string, outputPath: string | null): void {
  if (outputPath) {
    fs.writeFileSync(outputPath, text);
    return;
  }
  process.stdout.write(text);
}

function renderText(run: InjectionEvalRun, baseline: ReturnType<typeof compareInjectionEvalRuns> | null): string {
  const lines: string[] = [];
  lines.push('## Memrok Injection Eval');
  lines.push(`generatedAt: ${run.generatedAt}`);
  lines.push(`cases: ${run.totalCases}`);
  lines.push(`passed: ${run.passedCases}`);
  lines.push(`failed: ${run.failedCases}`);

  for (const result of run.results) {
    lines.push(`\n## ${result.fixtureId}`);
    lines.push(`title: ${result.title}`);
    lines.push(`pass: ${result.critic.pass}`);
    lines.push(`selectedKeys: ${result.selectedKeys.join(', ') || '(none)'}`);
    lines.push(`useful: ${result.critic.usefulNodes.map((node) => node.key).join(', ') || '(none)'}`);
    lines.push(`noise: ${result.critic.noiseNodes.map((node) => node.key).join(', ') || '(none)'}`);
    lines.push(`missing: ${result.critic.missingNodes.map((node) => node.key).join(', ') || '(none)'}`);
    lines.push(
      `failureModes: ${
        result.critic.failureModes
          .filter((mode) => mode.triggered)
          .map((mode) => `${mode.mode}:${mode.confidence}`)
          .join(', ') || '(none)'
      }`
    );
  }

  if (baseline) {
    lines.push('\n## Baseline Compare');
    lines.push(`baselineGeneratedAt: ${baseline.baselineGeneratedAt ?? 'unknown'}`);
    for (const comparison of baseline.cases) {
      lines.push(
        `- ${comparison.fixtureId}: prev=${comparison.previousPass ?? 'none'} current=${comparison.currentPass} ` +
        `added=${comparison.selectedAdded.join(', ') || '(none)'} removed=${comparison.selectedRemoved.join(', ') || '(none)'} ` +
        `newFailures=${comparison.newFailureModes.join(', ') || '(none)'} resolvedFailures=${comparison.resolvedFailureModes.join(', ') || '(none)'}`
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const fixtures = loadFixtures(options.fixturesDir, options.fixtureIds);
  const run = runInjectionEvalFixtures(fixtures);
  const baseline = options.baselinePath
    ? compareInjectionEvalRuns(
      JSON.parse(fs.readFileSync(options.baselinePath, 'utf8')) as InjectionEvalRun,
      run,
    )
    : null;

  if (options.json) {
    emit(`${JSON.stringify({ run, baseline }, null, 2)}\n`, options.outputPath);
    return;
  }

  emit(renderText(run, baseline), options.outputPath);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
