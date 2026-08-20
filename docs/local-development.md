# Local development

## One-time setup

```bash
corepack enable
pnpm install
```

If pnpm is already installed, `corepack enable` is unnecessary.

## Work on contracts first

```bash
pnpm --filter @bidsentinel/contracts test
pnpm --filter @bidsentinel/contracts typecheck
```

Fixtures live in `packages/contracts/src/fixtures.ts`. Contract changes should
add an acceptance fixture and a rejection test where applicable.

## Run the collector scenario

```bash
pnpm demo:collector
```

The demo processes a valid tender, an invalid deadline, then a recovered tender
with a deadline extension and corrigendum. It prints snapshot versions, change
kinds, quarantine count, recovery evidence count, and final source state.

## Run the local source

```bash
pnpm dev:chaos-source
```

Use the query modes listed in the root README. The server watch process restarts
when its TypeScript source changes.

## Run the web shell

```bash
pnpm dev:web
```

Open `http://127.0.0.1:4173`. The web app currently renders typed fixture data;
it does not fetch the chaos source.

## Full verification

```bash
pnpm check
```

For a focused workspace, replace the root command with:

```bash
pnpm --filter <workspace-name> test
pnpm --filter <workspace-name> typecheck
pnpm --filter <workspace-name> build
```
