# Snapshot validation and semantic diff rules

`diffTenderSnapshots` is a pure, deterministic function. It accepts:

- a previous `TenderSnapshot` or `null`;
- a current `TenderSnapshot` or `null` when the tender was absent; and
- `SnapshotSourceHealth` metadata for the two collection results.

It returns a decision, the last verified snapshot, and one or more evidence-backed
events. It performs no network calls and uses no probabilistic or LLM behavior.

## Decisions

| Decision          | Meaning                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `accept_current`  | The current snapshot is structurally and operationally trusted.                |
| `retain_previous` | The current input is invalid, absent but unconfirmed, or there is no snapshot. |
| `mark_removed`    | A healthy non-empty source confirmed the tender's absence twice.               |

An `invalid_snapshot` event is only valid with `retain_previous`. The result
contract enforces that invariant, and the engine returns the previous verified
snapshot unchanged.

## Validation order

1. Parse snapshots and source-health metadata with strict Zod schemas.
2. Reject duplicate document or corrigendum IDs and URLs.
3. Reject unhealthy source states and source/tender identity mismatches.
4. Reject non-monotonic versions and observation-time regressions.
5. Reject temporary empty results and suspicious record-count collapse.
6. Reject removal or mutation of a previously verified corrigendum.
7. Compare deadline instants, status values, and newly added corrigendum IDs.

## Fixed default thresholds

- A record-count collapse check starts when the previous result had at least 10
  records.
- A drop greater than 50% is `invalid_snapshot`.
- A zero-record result after a non-zero result is `invalid_snapshot`, not
  `tender_removed`.
- `tender_removed` requires two consecutive tender absences, a healthy source,
  a non-empty current result, and no record-count collapse.

Deadline comparison uses epoch milliseconds. Two ISO timestamps that represent
the same instant do not emit `deadline_changed`, even if their offsets differ.

## Events

The engine emits exactly the supported event vocabulary:

- `new_tender`
- `deadline_changed`
- `status_changed`
- `corrigendum_added`
- `tender_removed`
- `no_change`
- `invalid_snapshot`

Every event contains `semantic-diff-v1` evidence with the rule, source,
observation time, previous/current snapshot IDs, and rule-specific facts.
