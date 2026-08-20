# BidSentinel

BidSentinel is a TypeScript monorepo for monitoring public tender listings. This
initial MVP defines strict contracts, versions material tender state, detects
deadline/status/corrigendum changes, quarantines invalid extraction, and keeps
evidence when a source recovers on a later poll.

The repository deliberately has no database, queue, scraper, or external API
integration yet. The collector uses in-memory stores so the domain behavior is
testable before infrastructure choices harden the design.

## Requirements

- Node.js 22 or newer
- pnpm 11 (Corepack is fine)

## Install and verify

```bash
pnpm install
pnpm check
```

`pnpm check` runs lint, type checking, unit tests, and production builds for the
whole workspace.

## Workspace map

| Workspace                   | Purpose                                                                             | Run it                                                      |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/web`                  | Vite dashboard shell backed by typed fixture data                                   | `pnpm --filter @bidsentinel/web dev`                        |
| `apps/chaos-source`         | Local HTTP fixture source with valid and intentionally broken modes                 | `pnpm --filter @bidsentinel/chaos-source dev`               |
| `services/collector-worker` | In-memory validation, snapshot, change detection, quarantine, and recovery pipeline | `pnpm --filter @bidsentinel/collector-worker demo`          |
| `packages/contracts`        | Canonical Zod schemas, inferred TypeScript types, and fixtures                      | `pnpm --filter @bidsentinel/contracts test`                 |
| `packages/validation`       | Extraction validation, stable hashing, and quarantine record creation               | `pnpm --filter @bidsentinel/validation test`                |
| `packages/brightdata`       | Fail-closed provider boundary; no external integration                              | `pnpm --filter @bidsentinel/brightdata test`                |
| `docs`                      | Architecture and local workflow notes                                               | Read `docs/architecture.md` and `docs/local-development.md` |

Root shortcuts:

```bash
pnpm dev:web
pnpm dev:chaos-source
pnpm demo:collector
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Chaos source

The local server listens on `http://127.0.0.1:4311` by default.

```bash
curl 'http://127.0.0.1:4311/health'
curl 'http://127.0.0.1:4311/tenders?mode=valid'
curl 'http://127.0.0.1:4311/tenders?mode=deadline-shift'
curl 'http://127.0.0.1:4311/tenders?mode=status-closed'
curl 'http://127.0.0.1:4311/tenders?mode=corrigendum-added'
curl 'http://127.0.0.1:4311/tenders?mode=invalid-deadline'
curl 'http://127.0.0.1:4311/tenders?mode=invalid-shape'
```

Set `PORT` to use a different port. No process calls this service automatically;
it is a deterministic local source for the next integration step.

## Data behavior

- Canonical tender and source-health payloads are strict Zod objects. Unknown
  fields fail validation instead of leaking source-specific data downstream.
- Snapshot fingerprints exclude `observedAt`, so an unchanged re-poll does not
  create a fake state version.
- Material state changes create a new immutable snapshot. Deadline, status, and
  corrigendum differences additionally emit a typed change event.
- The deterministic semantic diff engine emits only `new_tender`,
  `deadline_changed`, `status_changed`, `corrigendum_added`, `tender_removed`,
  `no_change`, or `invalid_snapshot`, with evidence attached to every event.
- Temporary empty results, duplicate references, unhealthy sources, and record
  count collapses retain the last verified snapshot.
- Invalid payloads are retained with their raw value, SHA-256 hash, extractor
  version, and normalized validation issues.
- A valid poll following an active quarantine incident closes the incident and
  records the recovery strategy, actions, timing, payload hash, and verification
  counts.

See [docs/architecture.md](docs/architecture.md) for boundaries and explicit MVP
limits, and [docs/semantic-diff.md](docs/semantic-diff.md) for the exact snapshot
acceptance rules.
