import type {
  RecoveryEvidence,
  SourceHealth,
  Tender,
  TenderSnapshot,
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

export const recoveryEvidenceFixture = {
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

export const validSourceHealthFixture = {
  schemaVersion: 1,
  sourceId: "gem",
  state: "healthy",
  checkedAt: "2026-08-20T05:10:00.000Z",
  lastSuccessfulAt: "2026-08-20T05:10:00.000Z",
  consecutiveFailures: 0,
  recentFailureRate: 0.1,
  activeIncident: null,
  latestRecoveryEvidence: recoveryEvidenceFixture,
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
