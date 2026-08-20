import { describe, expect, it } from "vitest";

import {
  QuarantinedExtractionSchema,
  RecoveryEvidenceSchema,
  SemanticDiffResultSchema,
  SnapshotSourceHealthSchema,
  SourceHealthSchema,
  TenderSchema,
  TenderSnapshotSchema,
} from "./index.js";
import {
  recoveryEvidenceFixture,
  validSourceHealthFixture,
  validTenderFixture,
  validTenderSnapshotFixture,
} from "./fixtures.js";

describe("TenderSchema", () => {
  it("accepts the canonical fixture", () => {
    expect(TenderSchema.parse(validTenderFixture)).toEqual(validTenderFixture);
  });

  it("rejects a deadline without an explicit timezone", () => {
    const result = TenderSchema.safeParse({
      ...validTenderFixture,
      submissionDeadline: "2026-09-15T12:00:00",
    });

    expect(result.success).toBe(false);
  });

  it("rejects unknown extraction fields", () => {
    const result = TenderSchema.safeParse({
      ...validTenderFixture,
      sourceSpecificStatus: "ACTIVE",
    });

    expect(result.success).toBe(false);
  });
});

describe("TenderSnapshotSchema", () => {
  it("accepts a versioned snapshot", () => {
    expect(
      TenderSnapshotSchema.safeParse(validTenderSnapshotFixture).success,
    ).toBe(true);
  });

  it("rejects a snapshot whose source does not match its tender", () => {
    const result = TenderSnapshotSchema.safeParse({
      ...validTenderSnapshotFixture,
      sourceId: "another-source",
    });

    expect(result.success).toBe(false);
  });
});

describe("source health and recovery contracts", () => {
  it("accepts recovery evidence and a recovered healthy source", () => {
    expect(
      RecoveryEvidenceSchema.safeParse(recoveryEvidenceFixture).success,
    ).toBe(true);
    expect(SourceHealthSchema.safeParse(validSourceHealthFixture).success).toBe(
      true,
    );
  });

  it("rejects a healthy source with an active incident", () => {
    const result = SourceHealthSchema.safeParse({
      ...validSourceHealthFixture,
      activeIncident: {
        incidentId: "ec1ef7d9-f67c-45ab-b4a9-dfcf406564d2",
        openedAt: "2026-08-20T05:05:00.000Z",
        reason: "invalid-extraction",
        detail: "Invalid deadline",
      },
    });

    expect(result.success).toBe(false);
  });

  it("requires quarantine records to include validation issues", () => {
    const result = QuarantinedExtractionSchema.safeParse({
      schemaVersion: 1,
      quarantineId: "0db38b22-1595-4e1d-b66c-58aebf5ca387",
      sourceId: "gem",
      extractorVersion: "fixture-v1",
      observedAt: "2026-08-20T05:00:00.000Z",
      payloadHash: "c".repeat(64),
      rawPayload: {},
      issues: [],
    });

    expect(result.success).toBe(false);
  });
});

describe("semantic diff contracts", () => {
  it("accepts source-health metadata used by snapshot decisions", () => {
    expect(
      SnapshotSourceHealthSchema.safeParse({
        schemaVersion: 1,
        sourceId: "gem",
        state: "healthy",
        checkedAt: "2026-08-21T05:00:00.000Z",
        previousRecordCount: 100,
        currentRecordCount: 99,
        consecutiveEmptyResults: 0,
        consecutiveTenderAbsences: 1,
      }).success,
    ).toBe(true);
  });

  it("forbids accepting a snapshot that emitted invalid_snapshot", () => {
    const result = SemanticDiffResultSchema.safeParse({
      decision: "accept_current",
      lastVerifiedSnapshot: validTenderSnapshotFixture,
      events: [
        {
          kind: "invalid_snapshot",
          tenderId: validTenderSnapshotFixture.tenderId,
          issues: [
            {
              code: "duplicate_reference",
              path: ["current", "tender", "documents", 1],
              message: "Duplicate document reference",
            },
          ],
          evidence: {
            engineVersion: "semantic-diff-v1",
            rule: "snapshot_rejected",
            sourceId: "gem",
            observedAt: "2026-08-21T05:00:00.000Z",
            previousSnapshotId: validTenderSnapshotFixture.snapshotId,
            currentSnapshotId: null,
            facts: { reasonCodes: ["duplicate_reference"] },
          },
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
