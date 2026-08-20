# BidSentinel

BidSentinel is a self-healing tender monitor. It runs a Bright Data Scraper
Studio collector, validates every extraction, protects the last verified
snapshot when a page layout breaks, requests a same-collector repair, and
requires a schema-valid preview plus human approval before saving the repair.
After the repaired collector reruns, real deadline, status, and corrigendum
changes are emitted as evidence-backed events.

The default local experience is an explicitly labelled deterministic mock. Live
mode is selected only when all three Bright Data values are configured; live
collection and healing mutations additionally require an operator flag and a
private token. State is intentionally in memory for the hackathon MVP.

## Requirements

- Node.js 22 or newer
- pnpm 11 (Corepack is fine)

## Install and verify

```bash
pnpm install
pnpm check
```

`pnpm check` runs lint, type checking, unit tests, production builds, and the
collector demo for the whole workspace.

## Workspace map

| Workspace                   | Purpose                                                                            | Run it                                                      |
| --------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/web`                  | Judge-facing dashboard for collection, quarantine, approval, recovery, and changes | `pnpm --filter @bidsentinel/web dev`                        |
| `apps/chaos-source`         | Stable public HTML target with controllable layout and business-data changes       | `pnpm --filter @bidsentinel/chaos-source dev`               |
| `services/collector-worker` | API, Bright Data runtime bridge, validation, snapshots, diffing, and recovery      | `pnpm --filter @bidsentinel/collector-worker start`         |
| `packages/contracts`        | Canonical Zod schemas, inferred TypeScript types, and fixtures                     | `pnpm --filter @bidsentinel/contracts test`                 |
| `packages/validation`       | Extraction validation, stable hashing, and quarantine record creation              | `pnpm --filter @bidsentinel/validation test`                |
| `packages/brightdata`       | Scraper Studio trigger/poll adapter and same-collector healing adapter             | `pnpm --filter @bidsentinel/brightdata test`                |
| `docs`                      | Architecture and local workflow notes                                              | Read `docs/architecture.md` and `docs/local-development.md` |

Root shortcuts:

```bash
pnpm dev:web
pnpm dev:chaos-source
pnpm start:api
pnpm collect
pnpm demo:collector
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Run the deterministic judge demo

Use three terminals:

```bash
pnpm dev:chaos-source
pnpm start:api
pnpm dev:web
```

Open `http://127.0.0.1:4173`. The API defaults to safe mock mode when Bright
Data credentials are absent. Follow the six numbered dashboard actions to show:

1. a verified baseline;
2. structural drift quarantined without corrupting that baseline;
3. a same-collector healing request and preview;
4. contract validation before the human approval gate;
5. a successful rerun with recovery evidence; and
6. a real deadline/corrigendum amendment detected after recovery.

See [docs/demo-runbook.md](docs/demo-runbook.md) for the judge script and the
separate live-evidence procedure.

## Chaos source

The local server listens on `http://127.0.0.1:4311` by default.

```bash
curl 'http://127.0.0.1:4311/health'
curl 'http://127.0.0.1:4311/tenders'
curl 'http://127.0.0.1:4311/__control'
curl -X POST -H 'accept: application/json' \
  -d 'mode=layout-cards' 'http://127.0.0.1:4311/__control'
curl -X POST -H 'accept: application/json' \
  -d 'mode=amended' 'http://127.0.0.1:4311/__control'
```

`/tenders` is the stable scraper target. `baseline-table` and `layout-cards`
contain the same business data in different HTML structures; `amended` changes
the deadline and adds a corrigendum. The control route is local demo tooling and
must not be exposed publicly without protection.

## Live Bright Data mode

Copy `.env.example` to an untracked `.env` or export the variables in your
shell. Configure a real `c_*` collector and use the stable chaos `/tenders` URL
as its target. The trigger/poll adapter follows Scraper Studio's `dca` contract.
Healing keeps the same collector ID, validates the returned preview, waits for
human approval, resumes the job, polls it to `done`, and reruns that collector.

All live mutation endpoints fail closed unless
`BIDSENTINEL_ENABLE_LIVE_MUTATIONS=true` and a private 32+ character
`BIDSENTINEL_OPERATOR_TOKEN` is supplied in the
`X-BidSentinel-Operator-Token` header. Never commit or show the token.

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
