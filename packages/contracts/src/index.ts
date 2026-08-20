import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

export const IsoDateTimeSchema = z
  .string()
  .datetime({ offset: true })
  .describe("ISO 8601 timestamp with an explicit timezone offset");

export const SourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const TenderStatusSchema = z.enum([
  "announced",
  "open",
  "closed",
  "awarded",
  "cancelled",
  "unknown",
]);

export const TenderDocumentSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    url: z.string().url(),
    publishedAt: IsoDateTimeSchema.nullable(),
  })
  .strict();

export const CorrigendumSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().min(1).max(10_000).nullable(),
    publishedAt: IsoDateTimeSchema,
    url: z.string().url().nullable(),
  })
  .strict();

export const TenderSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    tenderId: z.string().trim().min(1).max(250),
    sourceId: SourceIdSchema,
    externalId: z.string().trim().min(1).max(200),
    title: z.string().trim().min(1).max(1_000),
    description: z.string().trim().min(1).max(50_000).nullable(),
    buyer: z
      .object({
        name: z.string().trim().min(1).max(500),
        countryCode: z
          .string()
          .regex(/^[A-Z]{2}$/)
          .nullable(),
      })
      .strict(),
    status: TenderStatusSchema,
    publishedAt: IsoDateTimeSchema.nullable(),
    submissionDeadline: IsoDateTimeSchema.nullable(),
    url: z.string().url(),
    estimatedValue: z
      .object({
        amount: z.number().finite().nonnegative(),
        currency: z.string().regex(/^[A-Z]{3}$/),
      })
      .strict()
      .nullable(),
    documents: z.array(TenderDocumentSchema),
    corrigenda: z.array(CorrigendumSchema),
    observedAt: IsoDateTimeSchema,
  })
  .strict();

export const TenderSnapshotSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    snapshotId: z.string().uuid(),
    tenderId: z.string().trim().min(1).max(250),
    sourceId: SourceIdSchema,
    version: z.number().int().positive(),
    observedAt: IsoDateTimeSchema,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    tender: TenderSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.tenderId !== snapshot.tender.tenderId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Snapshot and tender IDs must match",
        path: ["tenderId"],
      });
    }

    if (snapshot.sourceId !== snapshot.tender.sourceId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Snapshot and tender source IDs must match",
        path: ["sourceId"],
      });
    }
  });

const StatusChangeSchema = z
  .object({
    kind: z.literal("status"),
    before: TenderStatusSchema,
    after: TenderStatusSchema,
  })
  .strict();

const DeadlineChangeSchema = z
  .object({
    kind: z.literal("deadline"),
    before: IsoDateTimeSchema.nullable(),
    after: IsoDateTimeSchema.nullable(),
  })
  .strict();

const CorrigendumUpdateSchema = z
  .object({
    before: CorrigendumSchema,
    after: CorrigendumSchema,
  })
  .strict();

const CorrigendumChangeSchema = z
  .object({
    kind: z.literal("corrigendum"),
    added: z.array(CorrigendumSchema),
    removed: z.array(CorrigendumSchema),
    updated: z.array(CorrigendumUpdateSchema),
  })
  .strict();

export const TenderChangeSchema = z
  .discriminatedUnion("kind", [
    StatusChangeSchema,
    DeadlineChangeSchema,
    CorrigendumChangeSchema,
  ])
  .superRefine((change, context) => {
    if (
      change.kind === "corrigendum" &&
      change.added.length === 0 &&
      change.removed.length === 0 &&
      change.updated.length === 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A corrigendum change must include at least one difference",
      });
    }
  });

export const TenderChangeEventSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    changeEventId: z.string().uuid(),
    tenderId: z.string().trim().min(1).max(250),
    sourceId: SourceIdSchema,
    fromSnapshotId: z.string().uuid(),
    toSnapshotId: z.string().uuid(),
    detectedAt: IsoDateTimeSchema,
    changes: z.array(TenderChangeSchema).min(1),
  })
  .strict();

export const SourceIncidentReasonSchema = z.enum([
  "invalid-extraction",
  "network-error",
  "rate-limited",
  "schema-drift",
  "unknown",
]);

export const RecoveryStrategySchema = z.enum([
  "next-poll-revalidation",
  "retry-with-backoff",
  "alternate-parser",
  "manual-intervention",
]);

export const RecoveryEvidenceSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    recoveryEvidenceId: z.string().uuid(),
    incidentId: z.string().uuid(),
    sourceId: SourceIdSchema,
    strategy: RecoveryStrategySchema,
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
    outcome: z.enum(["recovered", "failed"]),
    actions: z.array(z.string().trim().min(1).max(500)).min(1),
    verification: z
      .object({
        validTenderCount: z.number().int().nonnegative(),
        quarantinedCount: z.number().int().nonnegative(),
        sampleTenderIds: z.array(z.string().trim().min(1).max(250)).max(20),
        payloadHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(20),
      })
      .strict(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (Date.parse(evidence.completedAt) < Date.parse(evidence.startedAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Recovery cannot complete before it starts",
        path: ["completedAt"],
      });
    }
  });

export const SourceHealthStateSchema = z.enum([
  "healthy",
  "degraded",
  "quarantined",
  "recovering",
]);

export const SourceHealthSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    sourceId: SourceIdSchema,
    state: SourceHealthStateSchema,
    checkedAt: IsoDateTimeSchema,
    lastSuccessfulAt: IsoDateTimeSchema.nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    recentFailureRate: z.number().min(0).max(1),
    activeIncident: z
      .object({
        incidentId: z.string().uuid(),
        openedAt: IsoDateTimeSchema,
        reason: SourceIncidentReasonSchema,
        detail: z.string().trim().min(1).max(2_000),
      })
      .strict()
      .nullable(),
    latestRecoveryEvidence: RecoveryEvidenceSchema.nullable(),
  })
  .strict()
  .superRefine((health, context) => {
    if (health.state === "healthy" && health.activeIncident !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A healthy source cannot have an active incident",
        path: ["activeIncident"],
      });
    }

    if (health.state !== "healthy" && health.activeIncident === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An unhealthy source must reference an active incident",
        path: ["activeIncident"],
      });
    }
  });

export const QuarantinedExtractionSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    quarantineId: z.string().uuid(),
    sourceId: SourceIdSchema,
    extractorVersion: z.string().trim().min(1).max(100),
    observedAt: IsoDateTimeSchema,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    rawPayload: z.unknown(),
    issues: z
      .array(
        z
          .object({
            code: z.string().trim().min(1),
            path: z.array(z.union([z.string(), z.number().int()])),
            message: z.string().trim().min(1),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const SnapshotSourceHealthSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    sourceId: SourceIdSchema,
    state: SourceHealthStateSchema,
    checkedAt: IsoDateTimeSchema,
    previousRecordCount: z.number().int().nonnegative(),
    currentRecordCount: z.number().int().nonnegative(),
    consecutiveEmptyResults: z.number().int().nonnegative(),
    consecutiveTenderAbsences: z.number().int().nonnegative(),
  })
  .strict();

const SemanticEvidenceFactScalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

const SemanticEvidenceFactSchema = z.union([
  SemanticEvidenceFactScalarSchema,
  z.array(SemanticEvidenceFactScalarSchema),
]);

export const SemanticDiffEvidenceSchema = z
  .object({
    engineVersion: z.literal("semantic-diff-v1"),
    rule: z.enum([
      "first_verified_snapshot",
      "deadline_instant_changed",
      "status_value_changed",
      "new_corrigendum_reference",
      "confirmed_tender_absence",
      "semantic_state_unchanged",
      "absence_unconfirmed",
      "no_baseline_or_current",
      "snapshot_rejected",
    ]),
    sourceId: SourceIdSchema,
    observedAt: IsoDateTimeSchema,
    previousSnapshotId: z.string().uuid().nullable(),
    currentSnapshotId: z.string().uuid().nullable(),
    facts: z.record(SemanticEvidenceFactSchema),
  })
  .strict();

export const SemanticDiffIssueSchema = z
  .object({
    code: z.string().trim().min(1).max(100),
    path: z.array(z.union([z.string(), z.number().int()])),
    message: z.string().trim().min(1).max(2_000),
  })
  .strict();

const SemanticTenderIdSchema = z.string().trim().min(1).max(250);

const NewTenderSemanticEventSchema = z
  .object({
    kind: z.literal("new_tender"),
    tenderId: SemanticTenderIdSchema,
    evidence: SemanticDiffEvidenceSchema,
  })
  .strict();

const DeadlineChangedSemanticEventSchema = z
  .object({
    kind: z.literal("deadline_changed"),
    tenderId: SemanticTenderIdSchema,
    before: IsoDateTimeSchema.nullable(),
    after: IsoDateTimeSchema.nullable(),
    evidence: SemanticDiffEvidenceSchema,
  })
  .strict();

const StatusChangedSemanticEventSchema = z
  .object({
    kind: z.literal("status_changed"),
    tenderId: SemanticTenderIdSchema,
    before: TenderStatusSchema,
    after: TenderStatusSchema,
    evidence: SemanticDiffEvidenceSchema,
  })
  .strict();

const CorrigendumAddedSemanticEventSchema = z
  .object({
    kind: z.literal("corrigendum_added"),
    tenderId: SemanticTenderIdSchema,
    corrigendum: CorrigendumSchema,
    evidence: SemanticDiffEvidenceSchema,
  })
  .strict();

const TenderRemovedSemanticEventSchema = z
  .object({
    kind: z.literal("tender_removed"),
    tenderId: SemanticTenderIdSchema,
    evidence: SemanticDiffEvidenceSchema,
  })
  .strict();

const NoChangeSemanticEventSchema = z
  .object({
    kind: z.literal("no_change"),
    tenderId: SemanticTenderIdSchema.nullable(),
    reason: z.enum([
      "semantic_state_unchanged",
      "absence_unconfirmed",
      "no_baseline_or_current",
    ]),
    evidence: SemanticDiffEvidenceSchema,
  })
  .strict();

const InvalidSnapshotSemanticEventSchema = z
  .object({
    kind: z.literal("invalid_snapshot"),
    tenderId: SemanticTenderIdSchema.nullable(),
    issues: z.array(SemanticDiffIssueSchema).min(1),
    evidence: SemanticDiffEvidenceSchema,
  })
  .strict();

export const SemanticDiffEventSchema = z.discriminatedUnion("kind", [
  NewTenderSemanticEventSchema,
  DeadlineChangedSemanticEventSchema,
  StatusChangedSemanticEventSchema,
  CorrigendumAddedSemanticEventSchema,
  TenderRemovedSemanticEventSchema,
  NoChangeSemanticEventSchema,
  InvalidSnapshotSemanticEventSchema,
]);

export const SemanticDiffResultSchema = z
  .object({
    decision: z.enum(["accept_current", "retain_previous", "mark_removed"]),
    lastVerifiedSnapshot: TenderSnapshotSchema.nullable(),
    events: z.array(SemanticDiffEventSchema).min(1),
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.decision === "accept_current" &&
      result.lastVerifiedSnapshot === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Accepting the current snapshot requires a verified snapshot",
        path: ["lastVerifiedSnapshot"],
      });
    }

    if (
      result.decision === "mark_removed" &&
      !result.events.some((event) => event.kind === "tender_removed")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A removal decision requires tender_removed evidence",
        path: ["events"],
      });
    }

    if (
      result.events.some((event) => event.kind === "invalid_snapshot") &&
      result.decision !== "retain_previous"
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid snapshots must retain the previous verified snapshot",
        path: ["decision"],
      });
    }
  });

export type Corrigendum = z.infer<typeof CorrigendumSchema>;
export type QuarantinedExtraction = z.infer<typeof QuarantinedExtractionSchema>;
export type RecoveryEvidence = z.infer<typeof RecoveryEvidenceSchema>;
export type SemanticDiffEvent = z.infer<typeof SemanticDiffEventSchema>;
export type SemanticDiffEvidence = z.infer<typeof SemanticDiffEvidenceSchema>;
export type SemanticDiffIssue = z.infer<typeof SemanticDiffIssueSchema>;
export type SemanticDiffResult = z.infer<typeof SemanticDiffResultSchema>;
export type SnapshotSourceHealth = z.infer<typeof SnapshotSourceHealthSchema>;
export type SourceHealth = z.infer<typeof SourceHealthSchema>;
export type Tender = z.infer<typeof TenderSchema>;
export type TenderChange = z.infer<typeof TenderChangeSchema>;
export type TenderChangeEvent = z.infer<typeof TenderChangeEventSchema>;
export type TenderSnapshot = z.infer<typeof TenderSnapshotSchema>;
