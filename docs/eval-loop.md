# Memrok Evaluation Loop

Memrok has three complementary quality signals. Use all three deliberately; they answer different questions.

## 1. Scrubbed Fixture Evals

Run:

```sh
npm run eval:injector -- --json
```

This runs the seeded critic/eval fixtures in `fixtures/injection-evals/` against the current injector. These fixtures are small, scrubbed, reviewable cases that encode expected-in and expected-out nodes.

Use this before and after injector, hygiene, ranking, or header-formatting changes. It is the CI-safe regression suite.

For before/after comparison:

```sh
npm run eval:injector -- --json --out /tmp/memrok-eval-before.json
# make the change
npm run eval:injector -- --baseline /tmp/memrok-eval-before.json
```

The comparison reports selected-node additions/removals and newly triggered or resolved critic failure modes. Existing known failures may remain in the baseline; the important review question is whether the change improves, preserves, or regresses them.

## 2. Live Probing

Run:

```sh
node scripts/eval-sessions.mjs --recent-sessions 10 --dry-run --headers
node scripts/inspect-header.mjs --recent "Memrok injector ranking regression..." --dry-run
```

Live probing is for local diagnosis against real session history. It is not CI-safe because it depends on private local transcripts and a local Memrok database.

When a live probe exposes a bad header, scrub it into a fixture:

1. Keep only the minimal recent-context query needed to reproduce the topic.
2. Replace private node values with representative synthetic values.
3. Add expected-in and expected-out keys.
4. Run `npm run eval:injector -- --json` and confirm the fixture contributes a useful critic signal.

## 3. Runtime Eval Events

Runtime eval events are opt-in local observation records for real injections. Enable them through the OpenClaw plugin config:

```json
{
  "evalEvents": {
    "enabled": true,
    "maxEvents": 500,
    "maxQueryChars": 1000,
    "maxHeaderChars": 4000,
    "maxNodeValueChars": 220
  }
}
```

Inspect them with:

```sh
npm run eval:events -- --limit 20
```

These events intentionally store bounded excerpts and metadata, not full transcripts. Use them to find recurring runtime failure patterns, then convert representative cases into scrubbed fixtures.

## Release Smoke

Before release, run:

```sh
npm run build
npm run eval:injector -- --json
npm run smoke:packaged-plugin
```

`smoke:packaged-plugin` runs `npm pack` for `packages/openclaw-plugin` and checks the packaged artifact contains the built OpenClaw extension, manifest, README, generated declaration file, and bundled prompts. This is not a full isolated `openclaw plugins install clawhub:memrok` test; that remains the stronger distribution validation path and is tracked separately from this CI smoke.

## CI

GitHub Actions now runs:

- TypeScript project build
- plugin bundle
- workspace tests
- fixture-based injector eval
- packaged-plugin smoke

This keeps the quality loop visible on every PR without turning CI into a full analytics or live-transcript platform.
