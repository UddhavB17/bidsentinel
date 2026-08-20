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

## Run the complete local demo

```bash
pnpm dev:chaos-source
pnpm start:api
pnpm dev:web
```

Run each command in its own terminal, then open `http://127.0.0.1:4173`. With no
Bright Data credentials, the API and dashboard clearly identify themselves as
mock mode. Use the six numbered actions in order.

The chaos source is at `http://127.0.0.1:4311`. Its stable public target is
`/tenders`; use `/__control` to switch among `baseline-table`, `layout-cards`,
`amended`, and `unavailable`.

## Run live collection

```bash
cp .env.example .env
# Fill the three BRIGHT_DATA_* values and BIDSENTINEL_SOURCE_ID privately.
pnpm collect
```

The API enters live mode only when the token, collector ID, and target URL are
all present in its process environment. Live API mutations also require
`BIDSENTINEL_ENABLE_LIVE_MUTATIONS=true`, a private 32+ character operator
token, and the matching header on every mutating request. Keep the flag false
for read-only inspection.

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
