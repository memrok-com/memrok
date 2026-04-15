# Contributing to Memrok

Thanks for contributing.

Memrok is not just a retrieval plugin. It is trying to become a **memory curation layer with judgment**. That means changes should be evaluated not only for correctness, but for whether they improve memory quality, inspectability, and operator trust.

## Development setup

```sh
git clone https://github.com/memrok-com/memrok.git
cd memrok
npm install
npm run build
```

## Quality loop

Use these tools at the right moments:

### 1. Live probing
Inspect real headers without writing normal runtime traces back into Memrok state.

```sh
node scripts/eval-sessions.mjs --recent-sessions 10 --dry-run --headers
node scripts/eval-sessions.mjs --session-id <session-id> --dry-run --json
```

### 2. Fixture evals
Run the portable regression suite before and after injector / retrieval changes.

```sh
npm run eval:injector -- --json
npm run eval:injector -- --json --out /tmp/memrok-eval-baseline.json
npm run eval:injector -- --baseline /tmp/memrok-eval-baseline.json
```

The fixture suite under `fixtures/injection-evals/` must stay **synthetic and portable**. Seed cases can be inspired by real failures, but they should not leak private/local project details or depend on a personal Memrok DB dump.

### 3. Runtime eval events
Inspect bounded local observation records for real injections and explicit probes.

```sh
npm run eval:events -- --limit 20
node scripts/inspect-header.mjs --session-id <session-id> --log-eval-event
```

Runtime event logging is opt-in through the OpenClaw plugin config under `evalEvents`. These records are for diagnosis and fixture creation, not for building a shadow transcript archive.

## Packaged-plugin smoke path

Do not trust only the dev-mounted plugin path.

Before release work, or whenever packaging changes matter, run:

```sh
npm run smoke:packaged-plugin
```

This checks the packaged OpenClaw plugin artifact rather than only the local repo-mounted plugin.

## Release discipline

For Memrok quality-sensitive changes:

1. run the relevant tests
2. run `npm run eval:injector -- --json`
3. use live probing if the change is meant to fix a real bad header
4. add or update a scrubbed fixture when a live failure should become a regression case
5. run `npm run smoke:packaged-plugin` before release work

## Design expectations

- prefer inspectability over mystery
- prefer bounded observation over silent mutation
- keep privacy boundaries explicit
- do not let “smartness” outrun operator control

## Useful docs

- [README](./README.md)
- [docs/eval-loop.md](./docs/eval-loop.md)
- [docs/architecture.md](./docs/architecture.md)
- [AGENTS.md](./AGENTS.md)
