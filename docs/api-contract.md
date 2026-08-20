# BidSentinel API contract

Status: implemented MVP. `services/collector-worker/src/server.ts` serves these
typed read endpoints from in-memory stores. It also exposes runtime/healing
status plus guarded demo/operator mutations described below.

## Conventions

- Responses use `application/json`.
- Successful list responses contain `data`, `pagination`, and `generatedAt`.
- Successful detail responses contain `data` and `generatedAt`.
- Schemas are strict. Undocumented response fields fail contract validation.
- `schemaVersion` is the version of the domain record, currently `1`.
- Tender IDs are opaque. Clients must URL-encode them when used as a path
  segment; for example, `gem:2026-rail-signalling-001` becomes
  `gem%3A2026-rail-signalling-001`.

### Timestamps

All timestamps are ISO 8601 strings with an explicit timezone offset. The API
should emit UTC using the `YYYY-MM-DDTHH:mm:ss.sssZ` form. It must not emit local
times without an offset.

- `generatedAt`: when the response representation was built.
- `observedAt`: when the source payload was observed.
- `detectedAt`: when a material change was detected.
- `checkedAt` and `lastSuccessfulAt`: source-health check times.
- `startedAt` and `completedAt`: recovery attempt boundaries. Completion cannot
  precede start.
- `publishedAt` and `submissionDeadline` can be `null` when the source does not
  provide a trustworthy value.

### Pagination

The first API uses offset pagination because the current stores are in memory
and the expected MVP result sets are small.

| Query parameter | Default | Constraint                     |
| --------------- | ------- | ------------------------------ |
| `limit`         | `50`    | Integer from `1` through `100` |
| `offset`        | `0`     | Non-negative integer           |

`total` is the full result count before `limit` and `offset` are applied.
`hasMore` is true exactly when `offset + data.length < total`. Invalid pagination
parameters return `400 invalid_request`. Unknown query parameters should also
return `400` so client mistakes do not silently change behavior.

Ordering must be stable before pagination:

| Collection  | Order                                                   |
| ----------- | ------------------------------------------------------- |
| Tenders     | `observedAt` descending, then `tenderId` ascending      |
| Changes     | `detectedAt` descending, then `changeEventId` ascending |
| Sources     | `sourceId` ascending                                    |
| Quarantines | `observedAt` descending, then `quarantineId` ascending  |

Offset pagination can skip or repeat records if data changes between requests.
That tradeoff is accepted for the MVP; a cursor contract should replace it
before these collections become large or heavily updated.

## Endpoints

Additional implemented endpoints:

- `GET /api/runtime` reports explicit `mock` or `live` mode and configuration
  readiness without returning credentials.
- `GET /api/healing/{sourceId}` reports the healing state, preview count, and
  redacted recovery evidence.
- `POST /api/dev/collect?mode=valid|drift|amended|live` runs one demo or live
  collection cycle.
- `POST /api/dev/heal-progress` polls the active same-collector repair.
- `POST /api/dev/validate-preview` runs the returned preview through the frozen
  schema/count gate.
- `POST /api/dev/approve` accepts `{ "approve": true|false }`; approval is a
  `409` unless the preview is valid.

When the runtime is live, every mutation above is denied unless live mutations
are explicitly enabled and `X-BidSentinel-Operator-Token` matches the private
operator token. These are hackathon control surfaces and should remain local or
behind proper production authentication.

### `GET /health`

Returns `200` when the API process is ready to serve requests. A failed readiness
check returns the standard `503 service_unavailable` error body.

```json
{
  "data": {
    "schemaVersion": 1,
    "service": "bidsentinel-api",
    "status": "ok"
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

Contract: `ApiHealthResponseSchema` / `ApiHealthResponse`.

### `GET /api/tenders`

Returns current tender summaries. Descriptions, documents, corrigenda, and the
snapshot payload hash are intentionally omitted from this collection view.

```json
{
  "data": [
    {
      "schemaVersion": 1,
      "tenderId": "gem:2026-rail-signalling-001",
      "sourceId": "gem",
      "externalId": "2026-rail-signalling-001",
      "title": "Supply and maintenance of railway signalling equipment",
      "buyer": {
        "name": "National Rail Infrastructure Authority",
        "countryCode": "IN"
      },
      "status": "open",
      "publishedAt": "2026-08-18T04:30:00.000Z",
      "submissionDeadline": "2026-09-15T12:00:00.000Z",
      "url": "https://example.gov.test/tenders/2026-rail-signalling-001",
      "estimatedValue": {
        "amount": 125000000,
        "currency": "INR"
      },
      "observedAt": "2026-08-20T05:00:00.000Z",
      "latestSnapshot": {
        "snapshotId": "7b4b518c-24a6-423b-b083-5e53e46f9082",
        "version": 1
      },
      "documentCount": 1,
      "corrigendumCount": 0
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1,
    "hasMore": false
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

Contracts: `TenderSummarySchema` / `TenderSummary` and
`TenderListResponseSchema` / `TenderListResponse`.

### `GET /api/tenders/{tenderId}`

Returns the latest verified tender state and snapshot metadata. This is the
tender-detail interpretation of the requested `GET /api/tenders/` route; the
identifier is required after the trailing slash.

Example request:

```text
GET /api/tenders/gem%3A2026-rail-signalling-001
```

```json
{
  "data": {
    "schemaVersion": 1,
    "tenderId": "gem:2026-rail-signalling-001",
    "sourceId": "gem",
    "externalId": "2026-rail-signalling-001",
    "title": "Supply and maintenance of railway signalling equipment",
    "description": "A public tender for signalling equipment and support.",
    "buyer": {
      "name": "National Rail Infrastructure Authority",
      "countryCode": "IN"
    },
    "status": "open",
    "publishedAt": "2026-08-18T04:30:00.000Z",
    "submissionDeadline": "2026-09-15T12:00:00.000Z",
    "url": "https://example.gov.test/tenders/2026-rail-signalling-001",
    "estimatedValue": {
      "amount": 125000000,
      "currency": "INR"
    },
    "documents": [
      {
        "id": "notice-v1",
        "title": "Tender notice",
        "url": "https://example.gov.test/documents/notice-v1.pdf",
        "publishedAt": "2026-08-18T04:30:00.000Z"
      }
    ],
    "corrigenda": [],
    "observedAt": "2026-08-20T05:00:00.000Z",
    "latestSnapshot": {
      "snapshotId": "7b4b518c-24a6-423b-b083-5e53e46f9082",
      "version": 1,
      "payloadHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

A missing tender returns `404 not_found`; it does not return `200` with `null`.

Contracts: `TenderDetailSchema` / `TenderDetail` and
`TenderDetailResponseSchema` / `TenderDetailResponse`.

### `GET /api/changes`

Returns material `TenderChangeEvent` records. This endpoint uses the existing
status/deadline/corrigendum event contract; it does not expose internal
`SemanticDiffEvent` safety-gate decisions.

```json
{
  "data": [
    {
      "schemaVersion": 1,
      "changeEventId": "8ebbd601-b247-44e8-89ee-928164ebfad9",
      "tenderId": "gem:2026-rail-signalling-001",
      "sourceId": "gem",
      "fromSnapshotId": "7b4b518c-24a6-423b-b083-5e53e46f9082",
      "toSnapshotId": "56f00f0d-f6f1-47a3-8693-1578423dc6b1",
      "detectedAt": "2026-08-21T05:00:00.000Z",
      "changes": [
        {
          "kind": "deadline",
          "before": "2026-09-15T12:00:00.000Z",
          "after": "2026-09-22T12:00:00.000Z"
        }
      ]
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1,
    "hasMore": false
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

Contract: `ChangeEventListResponseSchema` / `ChangeEventListResponse`.

### `GET /api/sources`

Returns current source-health records. `latestRecoveryEvidence` is `null` until
a recovery has been verified; otherwise it contains the complete recovery
evidence record.

```json
{
  "data": [
    {
      "schemaVersion": 1,
      "sourceId": "gem",
      "state": "healthy",
      "checkedAt": "2026-08-20T05:10:00.000Z",
      "lastSuccessfulAt": "2026-08-20T05:10:00.000Z",
      "consecutiveFailures": 0,
      "recentFailureRate": 0.1,
      "activeIncident": null,
      "latestRecoveryEvidence": {
        "schemaVersion": 1,
        "recoveryEvidenceId": "a75cb389-875d-4d1a-9df3-8cc2ebd98f89",
        "incidentId": "ec1ef7d9-f67c-45ab-b4a9-dfcf406564d2",
        "sourceId": "gem",
        "strategy": "next-poll-revalidation",
        "startedAt": "2026-08-20T05:05:00.000Z",
        "completedAt": "2026-08-20T05:10:00.000Z",
        "outcome": "recovered",
        "actions": [
          "Accepted a schema-valid payload on the next scheduled poll"
        ],
        "verification": {
          "validTenderCount": 1,
          "quarantinedCount": 1,
          "sampleTenderIds": ["gem:2026-rail-signalling-001"],
          "payloadHashes": [
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
          ]
        }
      }
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1,
    "hasMore": false
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

Contracts: `SourceHealthListResponseSchema` / `SourceHealthListResponse` and
`RecoveryEvidenceSchema` / `RecoveryEvidence`. A reusable
`RecoveryEvidenceResponseSchema` / `RecoveryEvidenceResponse` envelope is also
defined, but no standalone recovery endpoint is proposed in this handoff.

### `GET /api/quarantines`

Returns invalid extractions with the original raw payload, hash, extractor
version, and normalized validation issues.

```json
{
  "data": [
    {
      "schemaVersion": 1,
      "quarantineId": "0db38b22-1595-4e1d-b66c-58aebf5ca387",
      "sourceId": "gem",
      "extractorVersion": "fixture-v1",
      "observedAt": "2026-08-20T05:05:00.000Z",
      "payloadHash": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      "rawPayload": {
        "tenderId": "gem:2026-rail-signalling-001",
        "submissionDeadline": "tomorrow"
      },
      "issues": [
        {
          "code": "invalid_string",
          "path": ["submissionDeadline"],
          "message": "Invalid datetime"
        }
      ]
    }
  ],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 1,
    "hasMore": false
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

Contract: `QuarantineListResponseSchema` / `QuarantineListResponse`.

## Empty states

All collection endpoints return `200` with an empty array when there are no
records. They never return `404` merely because a collection is empty.

```json
{
  "data": [],
  "pagination": {
    "limit": 50,
    "offset": 0,
    "total": 0,
    "hasMore": false
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

An offset beyond the end also returns `200` with `data: []`, the real `total`,
and `hasMore: false`. A missing tender detail is different and returns `404`.
Nullable domain values remain explicit `null`; fields are not omitted.

## Errors and status codes

Every non-2xx JSON response uses `ApiErrorResponseSchema`. `requestId` is an
opaque correlation identifier. `details` is always an array and is empty when
there are no field-level details.

```json
{
  "error": {
    "code": "not_found",
    "status": 404,
    "message": "Tender gem:missing was not found",
    "requestId": "req-01k32nq4xdmkhkdxj8c86v9a8w",
    "details": []
  },
  "generatedAt": "2026-08-21T05:15:00.000Z"
}
```

The body status and symbolic code are coupled by the schema:

| HTTP status | Error code            | Use                                                  |
| ----------- | --------------------- | ---------------------------------------------------- |
| `400`       | `invalid_request`     | Invalid path/query syntax or unknown query parameter |
| `404`       | `not_found`           | Tender detail does not exist                         |
| `405`       | `method_not_allowed`  | Route exists but does not support the HTTP method    |
| `409`       | `conflict`            | Reserved for future conditional writes               |
| `422`       | `validation_failed`   | Reserved for future request-body validation          |
| `429`       | `rate_limited`        | Request throttled                                    |
| `500`       | `internal_error`      | Unexpected server failure                            |
| `503`       | `service_unavailable` | Readiness/dependency failure                         |

Endpoint behavior:

| Endpoint                      | Success | Expected errors                          |
| ----------------------------- | ------- | ---------------------------------------- |
| `GET /health`                 | `200`   | `405`, `503`                             |
| `GET /api/tenders`            | `200`   | `400`, `405`, `429`, `500`, `503`        |
| `GET /api/tenders/{tenderId}` | `200`   | `400`, `404`, `405`, `429`, `500`, `503` |
| `GET /api/changes`            | `200`   | `400`, `405`, `429`, `500`, `503`        |
| `GET /api/sources`            | `200`   | `400`, `405`, `429`, `500`, `503`        |
| `GET /api/quarantines`        | `200`   | `400`, `405`, `429`, `500`, `503`        |

Authentication is intentionally outside this contract task, so `401` and `403`
are not currently claimed.
