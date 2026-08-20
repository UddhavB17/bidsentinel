import { randomUUID } from "node:crypto";

import {
  QuarantinedExtractionSchema,
  RecoveryEvidenceSchema,
  SourceHealthSchema,
  TenderSnapshotSchema,
  type QuarantinedExtraction,
  type RecoveryEvidence,
  type SourceHealth,
  type Tender,
  type TenderChangeEvent,
  type TenderSnapshot,
} from "@bidsentinel/contracts";
import {
  hashPayload,
  validateTenderExtraction,
  type ExtractionContext,
} from "@bidsentinel/validation";

import { detectTenderChanges } from "./change-detection.js";
import { diffTenderSnapshots } from "./semantic-diff.js";
import {
  InMemoryChangeEventStore,
  InMemoryQuarantineStore,
  InMemoryRecoveryEvidenceStore,
  InMemorySnapshotStore,
  InMemorySourceHealthStore,
} from "./stores.js";

export type ProcessingResult =
  | {
      outcome: "accepted";
      tender: Tender;
      snapshot: TenderSnapshot | null;
      changeEvent: TenderChangeEvent | null;
      recoveryEvidence: RecoveryEvidence | null;
      health: SourceHealth;
    }
  | {
      outcome: "quarantined";
      quarantine: QuarantinedExtraction;
      health: SourceHealth;
    };

function tenderStateForHash(tender: Tender): Omit<Tender, "observedAt"> {
  const { observedAt: _observedAt, ...state } = tender;
  return state;
}

function incidentReasonFor(
  quarantine: QuarantinedExtraction,
): "invalid-extraction" | "schema-drift" {
  const hasStructuralFailure = quarantine.issues.some(
    (issue) =>
      issue.code === "unrecognized_keys" ||
      (issue.code === "invalid_type" && issue.message === "Required"),
  );

  return hasStructuralFailure ? "schema-drift" : "invalid-extraction";
}

export class BidSentinelPipeline {
  readonly snapshots = new InMemorySnapshotStore();
  readonly quarantines = new InMemoryQuarantineStore();
  readonly changeEvents = new InMemoryChangeEventStore();
  readonly recoveryEvidence = new InMemoryRecoveryEvidenceStore();
  readonly sourceHealth = new InMemorySourceHealthStore();
  readonly #attempts = new Map<string, boolean[]>();

  process(input: unknown, context: ExtractionContext): ProcessingResult {
    const validation = validateTenderExtraction(input, context);

    if (!validation.ok) {
      return this.quarantine(
        validation.quarantine,
        context,
        incidentReasonFor(validation.quarantine),
      );
    }

    const tender = validation.value;
    const previousHealth = this.sourceHealth.get(context.sourceId);
    const previousSnapshot = this.snapshots.latest(tender.tenderId);
    const payloadHash = hashPayload(tenderStateForHash(tender));
    const candidateSnapshot = TenderSnapshotSchema.parse({
      schemaVersion: 1,
      snapshotId: randomUUID(),
      tenderId: tender.tenderId,
      sourceId: tender.sourceId,
      version: (previousSnapshot?.version ?? 0) + 1,
      observedAt: tender.observedAt,
      payloadHash,
      tender,
    });
    const semanticDecision = diffTenderSnapshots({
      previous: previousSnapshot,
      current: candidateSnapshot,
      sourceHealth: {
        schemaVersion: 1,
        sourceId: context.sourceId,
        state: "healthy",
        checkedAt: context.observedAt,
        previousRecordCount: previousSnapshot === null ? 0 : 1,
        currentRecordCount: 1,
        consecutiveEmptyResults: 0,
        consecutiveTenderAbsences: 0,
      },
    });
    const rejection = semanticDecision.events.find(
      (event) => event.kind === "invalid_snapshot",
    );
    if (semanticDecision.decision !== "accept_current") {
      if (rejection?.kind !== "invalid_snapshot") {
        throw new Error("Snapshot safety gate rejected without evidence");
      }

      const quarantine = QuarantinedExtractionSchema.parse({
        schemaVersion: 1,
        quarantineId: randomUUID(),
        sourceId: context.sourceId,
        extractorVersion: context.extractorVersion,
        observedAt: context.observedAt,
        payloadHash: hashPayload(input),
        rawPayload: input,
        issues: rejection.issues,
      });
      return this.quarantine(quarantine, context, "invalid-extraction");
    }

    const snapshot =
      previousSnapshot?.payloadHash === payloadHash ? null : candidateSnapshot;
    const changeEvent =
      snapshot !== null && previousSnapshot !== null
        ? detectTenderChanges(previousSnapshot, snapshot, context.observedAt)
        : null;

    const recovered = this.buildRecoveryEvidence(
      previousHealth,
      tender,
      payloadHash,
      context,
    );

    const health = SourceHealthSchema.parse({
      schemaVersion: 1,
      sourceId: context.sourceId,
      state: "healthy",
      checkedAt: context.observedAt,
      lastSuccessfulAt: context.observedAt,
      consecutiveFailures: 0,
      recentFailureRate: this.projectedFailureRate(context.sourceId, true),
      activeIncident: null,
      latestRecoveryEvidence:
        recovered ?? previousHealth?.latestRecoveryEvidence ?? null,
    });

    this.recordAttempt(context.sourceId, true);
    if (snapshot !== null) {
      this.snapshots.append(snapshot);
    }
    if (changeEvent !== null) {
      this.changeEvents.append(changeEvent);
    }
    if (recovered !== null) {
      this.recoveryEvidence.append(recovered);
    }
    this.sourceHealth.set(health);

    return {
      outcome: "accepted",
      tender,
      snapshot,
      changeEvent,
      recoveryEvidence: recovered,
      health,
    };
  }

  private quarantine(
    quarantine: QuarantinedExtraction,
    context: ExtractionContext,
    reason: "invalid-extraction" | "schema-drift",
  ): ProcessingResult {
    const previousHealth = this.sourceHealth.get(context.sourceId);
    const activeIncident = previousHealth?.activeIncident ?? {
      incidentId: randomUUID(),
      openedAt: context.observedAt,
      reason,
      detail: quarantine.issues
        .map(
          (issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`,
        )
        .join("; "),
    };
    const health = SourceHealthSchema.parse({
      schemaVersion: 1,
      sourceId: context.sourceId,
      state: "quarantined",
      checkedAt: context.observedAt,
      lastSuccessfulAt: previousHealth?.lastSuccessfulAt ?? null,
      consecutiveFailures: (previousHealth?.consecutiveFailures ?? 0) + 1,
      recentFailureRate: this.projectedFailureRate(context.sourceId, false),
      activeIncident,
      latestRecoveryEvidence: previousHealth?.latestRecoveryEvidence ?? null,
    });

    this.recordAttempt(context.sourceId, false);
    this.quarantines.append(quarantine);
    this.sourceHealth.set(health);

    return { outcome: "quarantined", quarantine, health };
  }

  private buildRecoveryEvidence(
    previousHealth: SourceHealth | null,
    tender: Tender,
    payloadHash: string,
    context: ExtractionContext,
  ): RecoveryEvidence | null {
    if (previousHealth?.activeIncident === null || previousHealth === null) {
      return null;
    }

    return RecoveryEvidenceSchema.parse({
      schemaVersion: 1,
      recoveryEvidenceId: randomUUID(),
      incidentId: previousHealth.activeIncident.incidentId,
      sourceId: context.sourceId,
      strategy: "next-poll-revalidation",
      startedAt: previousHealth.activeIncident.openedAt,
      completedAt: context.observedAt,
      outcome: "recovered",
      actions: [
        "Preserved the invalid extraction in quarantine",
        "Accepted a schema-valid payload on the next poll",
      ],
      verification: {
        validTenderCount: 1,
        quarantinedCount: this.quarantines.listBySource(context.sourceId)
          .length,
        sampleTenderIds: [tender.tenderId],
        payloadHashes: [payloadHash],
      },
    });
  }

  private recordAttempt(sourceId: string, succeeded: boolean): void {
    const attempts = [...(this.#attempts.get(sourceId) ?? []), succeeded].slice(
      -20,
    );
    this.#attempts.set(sourceId, attempts);
  }

  private projectedFailureRate(sourceId: string, succeeded: boolean): number {
    const attempts = [...(this.#attempts.get(sourceId) ?? []), succeeded].slice(
      -20,
    );
    return (
      attempts.filter((attemptSucceeded) => !attemptSucceeded).length /
      attempts.length
    );
  }
}
