import {
  SemanticDiffResultSchema,
  SnapshotSourceHealthSchema,
  TenderSnapshotSchema,
  type SemanticDiffEvidence,
  type SemanticDiffIssue,
  type SemanticDiffResult,
  type SnapshotSourceHealth,
  type TenderSnapshot,
} from "@bidsentinel/contracts";
import { stableStringify } from "@bidsentinel/validation";

export interface SnapshotDiffInput {
  previous: unknown;
  current: unknown;
  sourceHealth: unknown;
}

export interface SemanticDiffPolicy {
  minimumAbsenceConfirmations: number;
  minimumRecordCountForCollapseCheck: number;
  maximumRecordCountDropRatio: number;
}

export const DEFAULT_SEMANTIC_DIFF_POLICY = {
  minimumAbsenceConfirmations: 2,
  minimumRecordCountForCollapseCheck: 10,
  maximumRecordCountDropRatio: 0.5,
} as const satisfies SemanticDiffPolicy;

type EvidenceRule = SemanticDiffEvidence["rule"];
type EvidenceFacts = SemanticDiffEvidence["facts"];

interface SnapshotCheck {
  candidate: TenderSnapshot | null;
  issues: SemanticDiffIssue[];
}

function prefixIssues(
  prefix: string,
  issues: ReadonlyArray<{
    code: string;
    path: Array<string | number>;
    message: string;
  }>,
): SemanticDiffIssue[] {
  return issues.map((issue) => ({
    code: issue.code,
    path: [prefix, ...issue.path],
    message: issue.message,
  }));
}

function duplicateIssues(
  snapshot: TenderSnapshot,
  prefix: "previous" | "current",
): SemanticDiffIssue[] {
  const issues: SemanticDiffIssue[] = [];

  const inspect = (
    values: Array<string | null>,
    collection: "documents" | "corrigenda",
    field: "id" | "url",
  ): void => {
    const firstIndex = new Map<string, number>();
    values.forEach((value, index) => {
      if (value === null) {
        return;
      }

      const seenAt = firstIndex.get(value);
      if (seenAt === undefined) {
        firstIndex.set(value, index);
        return;
      }

      issues.push({
        code: "duplicate_reference",
        path: [prefix, "tender", collection, index, field],
        message: `Reference ${value} duplicates index ${seenAt}`,
      });
    });
  };

  inspect(
    snapshot.tender.documents.map((document) => document.id),
    "documents",
    "id",
  );
  inspect(
    snapshot.tender.documents.map((document) => document.url),
    "documents",
    "url",
  );
  inspect(
    snapshot.tender.corrigenda.map((corrigendum) => corrigendum.id),
    "corrigenda",
    "id",
  );
  inspect(
    snapshot.tender.corrigenda.map((corrigendum) => corrigendum.url),
    "corrigenda",
    "url",
  );

  return issues;
}

function validateSnapshot(
  value: unknown,
  prefix: "previous" | "current",
): SnapshotCheck {
  if (value === null) {
    return { candidate: null, issues: [] };
  }

  const parsed = TenderSnapshotSchema.safeParse(value);
  if (!parsed.success) {
    return {
      candidate: null,
      issues: prefixIssues(prefix, parsed.error.issues),
    };
  }

  return {
    candidate: parsed.data,
    issues: duplicateIssues(parsed.data, prefix),
  };
}

function fallbackSourceId(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return "unknown";
  }

  const candidate = Reflect.get(value, "sourceId");
  return typeof candidate === "string" &&
    /^[a-z0-9][a-z0-9._-]*$/.test(candidate)
    ? candidate
    : "unknown";
}

function evidenceContext(
  sourceHealth: SnapshotSourceHealth | null,
  rawSourceHealth: unknown,
  previous: TenderSnapshot | null,
  current: TenderSnapshot | null,
): { sourceId: string; observedAt: string } {
  return {
    sourceId:
      sourceHealth?.sourceId ??
      current?.sourceId ??
      previous?.sourceId ??
      fallbackSourceId(rawSourceHealth),
    observedAt:
      sourceHealth?.checkedAt ??
      current?.observedAt ??
      previous?.observedAt ??
      "1970-01-01T00:00:00.000Z",
  };
}

function createEvidence(
  rule: EvidenceRule,
  context: { sourceId: string; observedAt: string },
  previous: TenderSnapshot | null,
  current: TenderSnapshot | null,
  facts: EvidenceFacts,
): SemanticDiffEvidence {
  return {
    engineVersion: "semantic-diff-v1",
    rule,
    sourceId: context.sourceId,
    observedAt: context.observedAt,
    previousSnapshotId: previous?.snapshotId ?? null,
    currentSnapshotId: current?.snapshotId ?? null,
    facts,
  };
}

function invalidResult(
  issues: SemanticDiffIssue[],
  previous: TenderSnapshot | null,
  current: TenderSnapshot | null,
  context: { sourceId: string; observedAt: string },
  health: SnapshotSourceHealth | null,
): SemanticDiffResult {
  const reasonCodes = [...new Set(issues.map((issue) => issue.code))];
  const facts: EvidenceFacts = { reasonCodes };
  if (health !== null) {
    Object.assign(facts, {
      sourceState: health.state,
      previousRecordCount: health.previousRecordCount,
      currentRecordCount: health.currentRecordCount,
      consecutiveEmptyResults: health.consecutiveEmptyResults,
      consecutiveTenderAbsences: health.consecutiveTenderAbsences,
    });
  }

  return SemanticDiffResultSchema.parse({
    decision: "retain_previous",
    lastVerifiedSnapshot: previous,
    events: [
      {
        kind: "invalid_snapshot",
        tenderId: current?.tenderId ?? previous?.tenderId ?? null,
        issues,
        evidence: createEvidence(
          "snapshot_rejected",
          context,
          previous,
          current,
          facts,
        ),
      },
    ],
  });
}

function sourceHealthIssues(
  health: SnapshotSourceHealth,
  previous: TenderSnapshot | null,
  current: TenderSnapshot | null,
  policy: SemanticDiffPolicy,
): SemanticDiffIssue[] {
  const issues: SemanticDiffIssue[] = [];

  if (health.state !== "healthy") {
    issues.push({
      code: "source_not_healthy",
      path: ["sourceHealth", "state"],
      message: `Source state ${health.state} is not trusted for snapshot replacement`,
    });
  }

  for (const [label, snapshot] of [
    ["previous", previous],
    ["current", current],
  ] as const) {
    if (snapshot !== null && snapshot.sourceId !== health.sourceId) {
      issues.push({
        code: "source_id_mismatch",
        path: [label, "sourceId"],
        message: `Snapshot source ${snapshot.sourceId} does not match health source ${health.sourceId}`,
      });
    }
  }

  if (previous !== null && health.previousRecordCount === 0) {
    issues.push({
      code: "record_count_snapshot_mismatch",
      path: ["sourceHealth", "previousRecordCount"],
      message: "A previous snapshot cannot belong to a zero-record result",
    });
  }

  if (current !== null && health.currentRecordCount === 0) {
    issues.push({
      code: "record_count_snapshot_mismatch",
      path: ["sourceHealth", "currentRecordCount"],
      message: "A current snapshot cannot belong to a zero-record result",
    });
  }

  if (
    previous !== null &&
    current === null &&
    health.previousRecordCount > 0 &&
    health.currentRecordCount === 0
  ) {
    issues.push({
      code: "temporary_empty_result",
      path: ["sourceHealth", "currentRecordCount"],
      message: "An empty collection result cannot prove tender removal",
    });
  } else if (
    health.previousRecordCount >= policy.minimumRecordCountForCollapseCheck &&
    health.currentRecordCount > 0
  ) {
    const dropRatio =
      (health.previousRecordCount - health.currentRecordCount) /
      health.previousRecordCount;
    if (dropRatio > policy.maximumRecordCountDropRatio) {
      issues.push({
        code: "record_count_collapse",
        path: ["sourceHealth", "currentRecordCount"],
        message: `Record count dropped by ${(dropRatio * 100).toFixed(2)}%, above the ${(policy.maximumRecordCountDropRatio * 100).toFixed(2)}% limit`,
      });
    }
  }

  return issues;
}

function identityAndChronologyIssues(
  previous: TenderSnapshot | null,
  current: TenderSnapshot | null,
): SemanticDiffIssue[] {
  if (previous === null || current === null) {
    return [];
  }

  const issues: SemanticDiffIssue[] = [];
  if (previous.tenderId !== current.tenderId) {
    issues.push({
      code: "tender_id_mismatch",
      path: ["current", "tenderId"],
      message: "Cannot diff snapshots for different tenders",
    });
  }

  if (current.version <= previous.version) {
    issues.push({
      code: "non_monotonic_snapshot_version",
      path: ["current", "version"],
      message:
        "Current snapshot version must be greater than the previous version",
    });
  }

  if (Date.parse(current.observedAt) < Date.parse(previous.observedAt)) {
    issues.push({
      code: "snapshot_time_regression",
      path: ["current", "observedAt"],
      message: "Current snapshot cannot predate the previous snapshot",
    });
  }

  return issues;
}

function corrigendumRegressionIssues(
  previous: TenderSnapshot | null,
  current: TenderSnapshot | null,
): SemanticDiffIssue[] {
  if (previous === null || current === null) {
    return [];
  }

  const currentById = new Map(
    current.tender.corrigenda.map((corrigendum) => [
      corrigendum.id,
      corrigendum,
    ]),
  );

  return previous.tender.corrigenda.flatMap((previousCorrigendum, index) => {
    const currentCorrigendum = currentById.get(previousCorrigendum.id);
    if (currentCorrigendum === undefined) {
      return [
        {
          code: "corrigendum_reference_removed",
          path: ["current", "tender", "corrigenda", index],
          message: `Previously verified corrigendum ${previousCorrigendum.id} is missing`,
        },
      ];
    }

    if (
      stableStringify(previousCorrigendum) !==
      stableStringify(currentCorrigendum)
    ) {
      return [
        {
          code: "corrigendum_reference_changed",
          path: ["current", "tender", "corrigenda", index],
          message: `Previously verified corrigendum ${previousCorrigendum.id} changed`,
        },
      ];
    }

    return [];
  });
}

export function diffTenderSnapshots(
  input: SnapshotDiffInput,
  policy: SemanticDiffPolicy = DEFAULT_SEMANTIC_DIFF_POLICY,
): SemanticDiffResult {
  const previousCheck = validateSnapshot(input.previous, "previous");
  const currentCheck = validateSnapshot(input.current, "current");
  const healthCheck = SnapshotSourceHealthSchema.safeParse(input.sourceHealth);
  const healthIssues = healthCheck.success
    ? []
    : prefixIssues("sourceHealth", healthCheck.error.issues);
  const previous =
    previousCheck.issues.length === 0 ? previousCheck.candidate : null;
  const current =
    currentCheck.issues.length === 0 ? currentCheck.candidate : null;
  const health = healthCheck.success ? healthCheck.data : null;
  const context = evidenceContext(
    health,
    input.sourceHealth,
    previousCheck.candidate,
    currentCheck.candidate,
  );

  const issues = [
    ...previousCheck.issues,
    ...currentCheck.issues,
    ...healthIssues,
  ];
  if (issues.length > 0 || health === null) {
    return invalidResult(
      issues,
      previous,
      currentCheck.candidate,
      context,
      health,
    );
  }

  issues.push(
    ...sourceHealthIssues(health, previous, current, policy),
    ...identityAndChronologyIssues(previous, current),
    ...corrigendumRegressionIssues(previous, current),
  );
  if (issues.length > 0) {
    return invalidResult(issues, previous, current, context, health);
  }

  if (previous === null && current === null) {
    return SemanticDiffResultSchema.parse({
      decision: "retain_previous",
      lastVerifiedSnapshot: null,
      events: [
        {
          kind: "no_change",
          tenderId: null,
          reason: "no_baseline_or_current",
          evidence: createEvidence(
            "no_baseline_or_current",
            context,
            null,
            null,
            {
              previousRecordCount: health.previousRecordCount,
              currentRecordCount: health.currentRecordCount,
            },
          ),
        },
      ],
    });
  }

  if (previous === null && current !== null) {
    return SemanticDiffResultSchema.parse({
      decision: "accept_current",
      lastVerifiedSnapshot: current,
      events: [
        {
          kind: "new_tender",
          tenderId: current.tenderId,
          evidence: createEvidence(
            "first_verified_snapshot",
            context,
            null,
            current,
            {
              currentVersion: current.version,
              externalId: current.tender.externalId,
            },
          ),
        },
      ],
    });
  }

  if (previous !== null && current === null) {
    if (
      health.consecutiveTenderAbsences >= policy.minimumAbsenceConfirmations
    ) {
      return SemanticDiffResultSchema.parse({
        decision: "mark_removed",
        lastVerifiedSnapshot: previous,
        events: [
          {
            kind: "tender_removed",
            tenderId: previous.tenderId,
            evidence: createEvidence(
              "confirmed_tender_absence",
              context,
              previous,
              null,
              {
                absenceConfirmations: health.consecutiveTenderAbsences,
                requiredConfirmations: policy.minimumAbsenceConfirmations,
                previousRecordCount: health.previousRecordCount,
                currentRecordCount: health.currentRecordCount,
              },
            ),
          },
        ],
      });
    }

    return SemanticDiffResultSchema.parse({
      decision: "retain_previous",
      lastVerifiedSnapshot: previous,
      events: [
        {
          kind: "no_change",
          tenderId: previous.tenderId,
          reason: "absence_unconfirmed",
          evidence: createEvidence(
            "absence_unconfirmed",
            context,
            previous,
            null,
            {
              absenceConfirmations: health.consecutiveTenderAbsences,
              requiredConfirmations: policy.minimumAbsenceConfirmations,
            },
          ),
        },
      ],
    });
  }

  if (previous === null || current === null) {
    throw new Error("Unreachable snapshot state");
  }

  const events: SemanticDiffResult["events"] = [];
  const previousDeadline = previous.tender.submissionDeadline;
  const currentDeadline = current.tender.submissionDeadline;
  const previousDeadlineEpoch =
    previousDeadline === null ? null : Date.parse(previousDeadline);
  const currentDeadlineEpoch =
    currentDeadline === null ? null : Date.parse(currentDeadline);

  if (previousDeadlineEpoch !== currentDeadlineEpoch) {
    events.push({
      kind: "deadline_changed",
      tenderId: current.tenderId,
      before: previousDeadline,
      after: currentDeadline,
      evidence: createEvidence(
        "deadline_instant_changed",
        context,
        previous,
        current,
        {
          beforeEpochMs: previousDeadlineEpoch,
          afterEpochMs: currentDeadlineEpoch,
        },
      ),
    });
  }

  if (previous.tender.status !== current.tender.status) {
    events.push({
      kind: "status_changed",
      tenderId: current.tenderId,
      before: previous.tender.status,
      after: current.tender.status,
      evidence: createEvidence(
        "status_value_changed",
        context,
        previous,
        current,
        {
          beforeStatus: previous.tender.status,
          afterStatus: current.tender.status,
        },
      ),
    });
  }

  const previousCorrigendumIds = new Set(
    previous.tender.corrigenda.map((corrigendum) => corrigendum.id),
  );
  for (const corrigendum of current.tender.corrigenda) {
    if (!previousCorrigendumIds.has(corrigendum.id)) {
      events.push({
        kind: "corrigendum_added",
        tenderId: current.tenderId,
        corrigendum,
        evidence: createEvidence(
          "new_corrigendum_reference",
          context,
          previous,
          current,
          {
            corrigendumId: corrigendum.id,
            publishedAt: corrigendum.publishedAt,
          },
        ),
      });
    }
  }

  if (events.length === 0) {
    events.push({
      kind: "no_change",
      tenderId: current.tenderId,
      reason: "semantic_state_unchanged",
      evidence: createEvidence(
        "semantic_state_unchanged",
        context,
        previous,
        current,
        {
          deadlineEpochMs: currentDeadlineEpoch,
          status: current.tender.status,
          corrigendumIds: current.tender.corrigenda.map(
            (corrigendum) => corrigendum.id,
          ),
        },
      ),
    });
  }

  return SemanticDiffResultSchema.parse({
    decision: "accept_current",
    lastVerifiedSnapshot: current,
    events,
  });
}
