import { randomUUID } from "node:crypto";

import {
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
      this.recordAttempt(context.sourceId, false);
      this.quarantines.append(validation.quarantine);
      const previousHealth = this.sourceHealth.get(context.sourceId);
      const activeIncident = previousHealth?.activeIncident ?? {
        incidentId: randomUUID(),
        openedAt: context.observedAt,
        reason: "invalid-extraction" as const,
        detail: validation.quarantine.issues
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
        recentFailureRate: this.failureRate(context.sourceId),
        activeIncident,
        latestRecoveryEvidence: previousHealth?.latestRecoveryEvidence ?? null,
      });
      this.sourceHealth.set(health);

      return {
        outcome: "quarantined",
        quarantine: validation.quarantine,
        health,
      };
    }

    this.recordAttempt(context.sourceId, true);
    const tender = validation.value;
    const previousHealth = this.sourceHealth.get(context.sourceId);
    const previousSnapshot = this.snapshots.latest(tender.tenderId);
    const payloadHash = hashPayload(tenderStateForHash(tender));
    let snapshot: TenderSnapshot | null = null;
    let changeEvent: TenderChangeEvent | null = null;

    if (previousSnapshot?.payloadHash !== payloadHash) {
      snapshot = TenderSnapshotSchema.parse({
        schemaVersion: 1,
        snapshotId: randomUUID(),
        tenderId: tender.tenderId,
        sourceId: tender.sourceId,
        version: (previousSnapshot?.version ?? 0) + 1,
        observedAt: tender.observedAt,
        payloadHash,
        tender,
      });
      this.snapshots.append(snapshot);

      if (previousSnapshot !== null) {
        changeEvent = detectTenderChanges(
          previousSnapshot,
          snapshot,
          context.observedAt,
        );
        if (changeEvent !== null) {
          this.changeEvents.append(changeEvent);
        }
      }
    }

    const recovered = this.buildRecoveryEvidence(
      previousHealth,
      tender,
      payloadHash,
      context,
    );
    if (recovered !== null) {
      this.recoveryEvidence.append(recovered);
    }

    const health = SourceHealthSchema.parse({
      schemaVersion: 1,
      sourceId: context.sourceId,
      state: "healthy",
      checkedAt: context.observedAt,
      lastSuccessfulAt: context.observedAt,
      consecutiveFailures: 0,
      recentFailureRate: this.failureRate(context.sourceId),
      activeIncident: null,
      latestRecoveryEvidence:
        recovered ?? previousHealth?.latestRecoveryEvidence ?? null,
    });
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

  private failureRate(sourceId: string): number {
    const attempts = this.#attempts.get(sourceId) ?? [];
    if (attempts.length === 0) {
      return 0;
    }

    return attempts.filter((succeeded) => !succeeded).length / attempts.length;
  }
}
