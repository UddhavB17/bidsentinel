import type {
  ApiErrorResponse,
  ApiHealthResponse,
  ChangeEventListResponse,
  Pagination,
  QuarantinedExtraction,
  QuarantineListResponse,
  RecoveryEvidence,
  RecoveryEvidenceResponse,
  SourceHealth,
  SourceHealthListResponse,
  Tender,
  TenderChangeEvent,
  TenderDetail,
  TenderDetailResponse,
  TenderListResponse,
  TenderSnapshot,
  TenderSummary,
} from "./index.js";

export const validTenderFixture = {
  schemaVersion: 1,
  tenderId: "gem:2026-rail-signalling-001",
  sourceId: "gem",
  externalId: "2026-rail-signalling-001",
  title: "Supply and maintenance of railway signalling equipment",
  description: "A public tender for signalling equipment and support.",
  buyer: {
    name: "National Rail Infrastructure Authority",
    countryCode: "IN",
  },
  status: "open",
  publishedAt: "2026-08-18T04:30:00.000Z",
  submissionDeadline: "2026-09-15T12:00:00.000Z",
  url: "https://example.gov.test/tenders/2026-rail-signalling-001",
  estimatedValue: {
    amount: 125_000_000,
    currency: "INR",
  },
  documents: [
    {
      id: "notice-v1",
      title: "Tender notice",
      url: "https://example.gov.test/documents/notice-v1.pdf",
      publishedAt: "2026-08-18T04:30:00.000Z",
    },
  ],
  corrigenda: [],
  observedAt: "2026-08-20T05:00:00.000Z",
} satisfies Tender;

export const tenderWithCorrigendumFixture = {
  ...validTenderFixture,
  submissionDeadline: "2026-09-22T12:00:00.000Z",
  observedAt: "2026-08-21T05:00:00.000Z",
  corrigenda: [
    {
      id: "corrigendum-1",
      title: "Submission deadline extension",
      description: "The submission deadline has been extended by seven days.",
      publishedAt: "2026-08-21T03:30:00.000Z",
      url: "https://example.gov.test/tenders/2026-rail-signalling-001/corrigenda/1",
    },
  ],
} satisfies Tender;

export const validRecoveryEvidenceFixture = {
  schemaVersion: 1,
  recoveryEvidenceId: "a75cb389-875d-4d1a-9df3-8cc2ebd98f89",
  incidentId: "ec1ef7d9-f67c-45ab-b4a9-dfcf406564d2",
  sourceId: "gem",
  strategy: "next-poll-revalidation",
  startedAt: "2026-08-20T05:05:00.000Z",
  completedAt: "2026-08-20T05:10:00.000Z",
  outcome: "recovered",
  actions: ["Accepted a schema-valid payload on the next scheduled poll"],
  verification: {
    validTenderCount: 1,
    quarantinedCount: 1,
    sampleTenderIds: [validTenderFixture.tenderId],
    payloadHashes: ["a".repeat(64)],
  },
} satisfies RecoveryEvidence;

export const recoveryEvidenceFixture = validRecoveryEvidenceFixture;

export const validSourceHealthFixture = {
  schemaVersion: 1,
  sourceId: "gem",
  state: "healthy",
  checkedAt: "2026-08-20T05:10:00.000Z",
  lastSuccessfulAt: "2026-08-20T05:10:00.000Z",
  consecutiveFailures: 0,
  recentFailureRate: 0.1,
  activeIncident: null,
  latestRecoveryEvidence: validRecoveryEvidenceFixture,
} satisfies SourceHealth;

export const validTenderSnapshotFixture = {
  schemaVersion: 1,
  snapshotId: "7b4b518c-24a6-423b-b083-5e53e46f9082",
  tenderId: validTenderFixture.tenderId,
  sourceId: validTenderFixture.sourceId,
  version: 1,
  observedAt: validTenderFixture.observedAt,
  payloadHash: "b".repeat(64),
  tender: validTenderFixture,
} satisfies TenderSnapshot;

export const validTenderSummaryFixture = {
  schemaVersion: 1,
  tenderId: validTenderFixture.tenderId,
  sourceId: validTenderFixture.sourceId,
  externalId: validTenderFixture.externalId,
  title: validTenderFixture.title,
  buyer: validTenderFixture.buyer,
  status: validTenderFixture.status,
  publishedAt: validTenderFixture.publishedAt,
  submissionDeadline: validTenderFixture.submissionDeadline,
  url: validTenderFixture.url,
  estimatedValue: validTenderFixture.estimatedValue,
  observedAt: validTenderFixture.observedAt,
  latestSnapshot: {
    snapshotId: validTenderSnapshotFixture.snapshotId,
    version: validTenderSnapshotFixture.version,
  },
  documentCount: validTenderFixture.documents.length,
  corrigendumCount: validTenderFixture.corrigenda.length,
} satisfies TenderSummary;

export const validTenderDetailFixture = {
  ...validTenderFixture,
  latestSnapshot: {
    snapshotId: validTenderSnapshotFixture.snapshotId,
    version: validTenderSnapshotFixture.version,
    payloadHash: validTenderSnapshotFixture.payloadHash,
  },
} satisfies TenderDetail;

export const validTenderChangeEventFixture = {
  schemaVersion: 1,
  changeEventId: "8ebbd601-b247-44e8-89ee-928164ebfad9",
  tenderId: validTenderFixture.tenderId,
  sourceId: validTenderFixture.sourceId,
  fromSnapshotId: validTenderSnapshotFixture.snapshotId,
  toSnapshotId: "56f00f0d-f6f1-47a3-8693-1578423dc6b1",
  detectedAt: "2026-08-21T05:00:00.000Z",
  changes: [
    {
      kind: "deadline",
      before: validTenderFixture.submissionDeadline,
      after: tenderWithCorrigendumFixture.submissionDeadline,
    },
  ],
} satisfies TenderChangeEvent;

export const validQuarantinedExtractionFixture = {
  schemaVersion: 1,
  quarantineId: "0db38b22-1595-4e1d-b66c-58aebf5ca387",
  sourceId: validTenderFixture.sourceId,
  extractorVersion: "fixture-v1",
  observedAt: "2026-08-20T05:05:00.000Z",
  payloadHash: "c".repeat(64),
  rawPayload: {
    ...validTenderFixture,
    submissionDeadline: "tomorrow",
  },
  issues: [
    {
      code: "invalid_string",
      path: ["submissionDeadline"],
      message: "Invalid datetime",
    },
  ],
} satisfies QuarantinedExtraction;

export const firstPagePaginationFixture = {
  limit: 50,
  offset: 0,
  total: 1,
  hasMore: false,
} satisfies Pagination;

export const emptyPaginationFixture = {
  limit: 50,
  offset: 0,
  total: 0,
  hasMore: false,
} satisfies Pagination;

const responseGeneratedAt = "2026-08-21T05:15:00.000Z";

export const validApiHealthResponseFixture = {
  data: {
    schemaVersion: 1,
    service: "bidsentinel-api",
    status: "ok",
  },
  generatedAt: responseGeneratedAt,
} satisfies ApiHealthResponse;

export const validTenderListResponseFixture = {
  data: [validTenderSummaryFixture],
  pagination: firstPagePaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies TenderListResponse;

export const emptyTenderListResponseFixture = {
  data: [],
  pagination: emptyPaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies TenderListResponse;

export const validTenderDetailResponseFixture = {
  data: validTenderDetailFixture,
  generatedAt: responseGeneratedAt,
} satisfies TenderDetailResponse;

export const validChangeEventListResponseFixture = {
  data: [validTenderChangeEventFixture],
  pagination: firstPagePaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies ChangeEventListResponse;

export const emptyChangeEventListResponseFixture = {
  data: [],
  pagination: emptyPaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies ChangeEventListResponse;

export const validSourceHealthListResponseFixture = {
  data: [validSourceHealthFixture],
  pagination: firstPagePaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies SourceHealthListResponse;

export const emptySourceHealthListResponseFixture = {
  data: [],
  pagination: emptyPaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies SourceHealthListResponse;

export const validQuarantineListResponseFixture = {
  data: [validQuarantinedExtractionFixture],
  pagination: firstPagePaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies QuarantineListResponse;

export const emptyQuarantineListResponseFixture = {
  data: [],
  pagination: emptyPaginationFixture,
  generatedAt: responseGeneratedAt,
} satisfies QuarantineListResponse;

export const validRecoveryEvidenceResponseFixture = {
  data: validRecoveryEvidenceFixture,
  generatedAt: responseGeneratedAt,
} satisfies RecoveryEvidenceResponse;

export const validApiErrorResponseFixture = {
  error: {
    code: "not_found",
    status: 404,
    message: "Tender gem:missing was not found",
    requestId: "req-01k32nq4xdmkhkdxj8c86v9a8w",
    details: [],
  },
  generatedAt: responseGeneratedAt,
} satisfies ApiErrorResponse;
