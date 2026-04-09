# Repository Guidelines

## Project Structure & Module Organization
Memrok is a TypeScript monorepo organized under `packages/`. Core packages are `store/` (SQLite-backed graph store), `scribe/` (extraction and reflection logic), `injector/` (relevance scoring and header assembly), `daemon/` (watchers, scheduling, API, CLI), and `openclaw-plugin/` (OpenClaw integration and bundling). Design docs live in `docs/`, assets in `assets/`, and ad hoc developer utilities in `scripts/`.

Source files live in each package’s `src/` directory. Tests are colocated with source using `*.test.ts` names such as `packages/store/src/store.test.ts`.

## Build, Test, and Development Commands
Install dependencies once with `npm install`.

- `npm run build` builds the workspace via TypeScript project references.
- `npm test` runs all workspace tests with Vitest.
- `npm run lint` delegates to per-package lint scripts when present; currently not every package defines one.
- `npm run build --workspace packages/openclaw-plugin` builds the plugin package only.
- `npm run bundle --workspace packages/openclaw-plugin` produces the distributable plugin bundle.
- `npm run test --workspace packages/daemon` runs a single package’s test suite.

## Coding Style & Naming Conventions
Use ESM TypeScript, single quotes, semicolons, and 2-space indentation, matching the existing codebase. Prefer small exported functions and explicit types for public interfaces in `src/types.ts`. Keep package names and imports aligned with the workspace scope, for example `@memrok/store`.

Use `camelCase` for functions and variables, `PascalCase` for classes and interfaces, and `kebab-case` for documentation files. Keep Markdown prompts and specs close to the package that owns them.

## Testing Guidelines
Vitest is the primary test framework. Add colocated `*.test.ts` files beside the module under test and cover both happy paths and failure modes. The `scribe` package also includes small Python helpers; keep those tests targeted and runnable without external services.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commit prefixes such as `feat:` and `chore:`. Continue that format with short, imperative summaries, for example `fix: handle empty transcript chunk`.

Pull requests should explain the user-facing impact, note affected packages, and list verification steps you ran. Link issues when relevant. Include screenshots or sample headers only when UI or output formatting changes.

## Security & Configuration Tips
Do not commit local databases, API keys, or exported memory snapshots. Treat `~/.memrok/memrok.db` and transcript inputs as sensitive. Prefer fixture data over real conversation logs in tests and docs.

## Agent Workflow Notes
For any coding agent working in this repo (Codex, Claude Code, etc.):

- **Verify packaging with a real isolated install before closing install/distribution issues.** The canonical check is an isolated `HOME` run of `openclaw plugins install clawhub:memrok`, not just `npm run build`.
- **Do not treat partial progress notes as completion.** A task is only done when you can name the changed files, the verification steps, and the resulting behavior.
- **Prefer bounded changes over broad rewrites.** Memrok improves best through tight loops: inspect → patch → test/build → evaluate across topics.
- **Cross-topic QA matters.** A ranking tweak that improves the Memrok topic but worsens General/PrioMind/ZHAW is not a good fix.
- **Keep Memrok distinct from OpenClaw’s built-in memory.** Favor graph curation, supersession, expiry, topic-aware judged recall, and inspectability over generic recall duplication.
- **Use the inspection tooling before guessing.** `scripts/inspect-header.mjs`, `scripts/eval-topics.mjs`, `scripts/inspect-reflection.mjs`, `scripts/manual-reflection.mjs`, and `scripts/inspect-lifecycle.mjs` exist to make memory quality and curation behavior visible.
