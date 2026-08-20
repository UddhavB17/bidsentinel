import { describe, expect, it } from "vitest";

import {
  ApiErrorResponseSchema,
  ApiHealthResponseSchema,
  ChangeEventListResponseSchema,
  QuarantineListResponseSchema,
  RecoveryEvidenceResponseSchema,
  SourceHealthListResponseSchema,
  TenderDetailResponseSchema,
  TenderListResponseSchema,
  TenderSummarySchema,
} from "./index.js";
import {
  emptyChangeEventListResponseFixture,
  emptyQuarantineListResponseFixture,
  emptySourceHealthListResponseFixture,
  emptyTenderListResponseFixture,
  validApiErrorResponseFixture,
  validApiHealthResponseFixture,
  validChangeEventListResponseFixture,
  validQuarantinedExtractionFixture,
  validQuarantineListResponseFixture,
  validRecoveryEvidenceResponseFixture,
  validSourceHealthFixture,
  validSourceHealthListResponseFixture,
  validTenderChangeEventFixture,
  validTenderDetailResponseFixture,
  validTenderListResponseFixture,
  validTenderSummaryFixture,
} from "./fixtures.js";

describe("API contract acceptance", () => {
  it.each([
    ["health", ApiHealthResponseSchema, validApiHealthResponseFixture],
    ["tender list", TenderListResponseSchema, validTenderListResponseFixture],
    [
      "tender detail",
      TenderDetailResponseSchema,
      validTenderDetailResponseFixture,
    ],
    [
      "change-event list",
      ChangeEventListResponseSchema,
      validChangeEventListResponseFixture,
    ],
    [
      "source-health list",
      SourceHealthListResponseSchema,
      validSourceHealthListResponseFixture,
    ],
    [
      "quarantine list",
      QuarantineListResponseSchema,
      validQuarantineListResponseFixture,
    ],
    [
      "recovery evidence",
      RecoveryEvidenceResponseSchema,
      validRecoveryEvidenceResponseFixture,
    ],
    ["API error", ApiErrorResponseSchema, validApiErrorResponseFixture],
  ])("accepts the %s fixture", (_name, schema, fixture) => {
    expect(schema.safeParse(fixture).success).toBe(true);
  });

  it.each([
    ["tenders", TenderListResponseSchema, emptyTenderListResponseFixture],
    [
      "change events",
      ChangeEventListResponseSchema,
      emptyChangeEventListResponseFixture,
    ],
    [
      "source health",
      SourceHealthListResponseSchema,
      emptySourceHealthListResponseFixture,
    ],
    [
      "quarantines",
      QuarantineListResponseSchema,
      emptyQuarantineListResponseFixture,
    ],
  ])("accepts an empty %s page", (_name, schema, fixture) => {
    expect(schema.safeParse(fixture).success).toBe(true);
  });
});

describe("API contract rejection", () => {
  it("rejects negative tender summary counts", () => {
    expect(
      TenderSummarySchema.safeParse({
        ...validTenderSummaryFixture,
        documentCount: -1,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed tender detail snapshot hashes", () => {
    expect(
      TenderDetailResponseSchema.safeParse({
        ...validTenderDetailResponseFixture,
        data: {
          ...validTenderDetailResponseFixture.data,
          latestSnapshot: {
            ...validTenderDetailResponseFixture.data.latestSnapshot,
            payloadHash: "not-a-sha256-hash",
          },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects list metadata that claims another page after the total", () => {
    expect(
      TenderListResponseSchema.safeParse({
        ...validTenderListResponseFixture,
        pagination: {
          ...validTenderListResponseFixture.pagination,
          hasMore: true,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects change events with timezone-free detection timestamps", () => {
    expect(
      ChangeEventListResponseSchema.safeParse({
        ...validChangeEventListResponseFixture,
        data: [
          {
            ...validTenderChangeEventFixture,
            detectedAt: "2026-08-21T05:00:00",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects a healthy source with an active incident", () => {
    expect(
      SourceHealthListResponseSchema.safeParse({
        ...validSourceHealthListResponseFixture,
        data: [
          {
            ...validSourceHealthFixture,
            activeIncident: {
              incidentId: "ec1ef7d9-f67c-45ab-b4a9-dfcf406564d2",
              openedAt: "2026-08-20T05:05:00.000Z",
              reason: "invalid-extraction",
              detail: "Invalid deadline",
            },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects quarantine records without validation issues", () => {
    expect(
      QuarantineListResponseSchema.safeParse({
        ...validQuarantineListResponseFixture,
        data: [
          {
            ...validQuarantinedExtractionFixture,
            issues: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects recovery evidence completed before it started", () => {
    expect(
      RecoveryEvidenceResponseSchema.safeParse({
        ...validRecoveryEvidenceResponseFixture,
        data: {
          ...validRecoveryEvidenceResponseFixture.data,
          completedAt: "2026-08-20T05:00:00.000Z",
        },
      }).success,
    ).toBe(false);
  });

  it("rejects API error status and code mismatches", () => {
    expect(
      ApiErrorResponseSchema.safeParse({
        ...validApiErrorResponseFixture,
        error: {
          ...validApiErrorResponseFixture.error,
          status: 500,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects generated timestamps without an explicit timezone", () => {
    expect(
      ApiHealthResponseSchema.safeParse({
        ...validApiHealthResponseFixture,
        generatedAt: "2026-08-21T05:15:00",
      }).success,
    ).toBe(false);
  });
});
