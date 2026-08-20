import { randomUUID } from "node:crypto";

import {
  RecoveryEvidenceSchema,
  TenderSchema,
  type RecoveryEvidence,
} from "@bidsentinel/contracts";
import {
  type TenderHealingProgress,
  type TenderHealingProvider,
} from "@bidsentinel/brightdata";

export type HealingState =
  | "healthy"
  | "quarantined"
  | "healing_requested"
  | "awaiting_approval"
  | "preview_valid"
  | "preview_invalid"
  | "approved"
  | "rejected"
  | "recovered"
  | "recovery_failed";

export interface HealingIncident {
  incidentId: string;
  sourceId: string;
  collectorId: string;
  state: HealingState;
  openedAt: string;
  updatedAt: string;
  reason: string;
  prompt?: string;
  evidence?: RecoveryEvidence;
  previewPayloads?: unknown[];
}

export interface RecoveryVerification {
  success: boolean;
  validTenderCount: number;
  quarantinedCount: number;
  sampleTenderIds: string[];
  payloadHashes: string[];
}

const RUNNING_STATUSES = new Set(["in_progress", "pending", "running"]);
const FAILURE_STATUSES = new Set(["failed", "error", "cancelled"]);

export class SelfHealingCoordinator {
  private readonly incidents = new Map<string, HealingIncident>();
  private readonly states = new Map<string, HealingState>();
  private readonly sleepFn: (delayMs: number) => Promise<void>;
  private readonly nowFn: () => number;
  private readonly pollIntervalMs: number;
  private readonly approvalTimeoutMs: number;

  constructor(
    private readonly healingProvider: TenderHealingProvider,
    options: {
      sleepFn?: (delayMs: number) => Promise<void>;
      nowFn?: () => number;
      pollIntervalMs?: number;
      approvalTimeoutMs?: number;
    } = {},
  ) {
    this.sleepFn =
      options.sleepFn ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.nowFn = options.nowFn ?? Date.now;
    this.pollIntervalMs = options.pollIntervalMs ?? 5000;
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? 600000;
  }

  getHealingState(sourceId: string): HealingState {
    return this.states.get(sourceId) ?? "healthy";
  }

  setHealingState(sourceId: string, state: HealingState): void {
    this.states.set(sourceId, state);
  }

  getIncident(sourceId: string): HealingIncident | undefined {
    const incident = this.incidents.get(sourceId);
    return incident === undefined ? undefined : structuredClone(incident);
  }

  async handleDrift(
    sourceId: string,
    collectorId: string,
    reason: string,
    prompt: string,
    observedAt: string,
  ): Promise<void> {
    const current = this.incidents.get(sourceId);
    if (
      current &&
      !["rejected", "recovered", "recovery_failed"].includes(current.state)
    ) {
      return;
    }

    const incident: HealingIncident = {
      incidentId: randomUUID(),
      sourceId,
      collectorId,
      state: "quarantined",
      openedAt: observedAt,
      updatedAt: observedAt,
      reason,
      prompt,
    };
    this.incidents.set(sourceId, incident);
    this.transition(incident, "healing_requested", observedAt);

    try {
      await this.healingProvider.triggerRefactor(collectorId, prompt);
    } catch (error) {
      this.transition(incident, "recovery_failed", observedAt);
      incident.evidence = this.buildEvidence(
        incident,
        "failed",
        observedAt,
        {
          success: false,
          validTenderCount: 0,
          quarantinedCount: 1,
          sampleTenderIds: [],
          payloadHashes: [],
        },
        [
          "Self-healing request failed before an approval preview was available",
        ],
      );
      throw error;
    }
  }

  async pollProgress(
    sourceId: string,
    observedAt: string,
  ): Promise<TenderHealingProgress> {
    const incident = this.requireIncident(sourceId);
    const state = this.getHealingState(sourceId);
    if (state !== "healing_requested" && state !== "approved") {
      throw new Error(`Cannot poll self-healing progress from state ${state}`);
    }

    let progress: TenderHealingProgress;
    try {
      progress = await this.healingProvider.pollRefactorProgress(
        incident.collectorId,
      );
    } catch (error) {
      this.failIncident(
        incident,
        observedAt,
        "Bright Data self-healing progress could not be retrieved",
      );
      throw error;
    }

    this.applyProgress(incident, progress, observedAt, state === "approved");
    return progress;
  }

  handlePreview(
    sourceId: string,
    previewPayloads: unknown[],
    expectedMinCount: number,
    observedAt: string,
  ): boolean {
    const incident = this.requireIncident(sourceId);
    const state = this.getHealingState(sourceId);
    if (state !== "awaiting_approval" && state !== "preview_invalid") {
      throw new Error(`Cannot validate a healing preview from state ${state}`);
    }

    incident.previewPayloads = structuredClone(previewPayloads);
    incident.updatedAt = observedAt;
    const hasEnoughResults =
      expectedMinCount > 0 && previewPayloads.length >= expectedMinCount;
    const allValid =
      previewPayloads.length > 0 &&
      previewPayloads.every((payload) => {
        const parsed = TenderSchema.safeParse(payload);
        return parsed.success && parsed.data.sourceId === sourceId;
      });
    const valid = hasEnoughResults && allValid;
    this.transition(
      incident,
      valid ? "preview_valid" : "preview_invalid",
      observedAt,
    );
    return valid;
  }

  async approveOrReject(
    sourceId: string,
    approve: boolean,
    rerunFn: () => Promise<RecoveryVerification>,
    observedAt: string,
  ): Promise<void> {
    const incident = this.requireIncident(sourceId);
    const currentState = this.getHealingState(sourceId);

    if (approve && currentState !== "preview_valid") {
      throw new Error(
        `Cannot approve self-healing from state ${currentState}; a schema-valid preview is required`,
      );
    }
    if (
      !approve &&
      !["awaiting_approval", "preview_valid", "preview_invalid"].includes(
        currentState,
      )
    ) {
      throw new Error(`Cannot reject self-healing from state ${currentState}`);
    }

    try {
      await this.healingProvider.resumeAutomationJob(
        incident.collectorId,
        approve,
        { autoSave: approve },
      );
    } catch (error) {
      this.failIncident(
        incident,
        observedAt,
        "Bright Data rejected the operator's approval decision",
      );
      throw error;
    }

    if (!approve) {
      this.transition(incident, "rejected", observedAt);
      incident.evidence = this.buildEvidence(
        incident,
        "failed",
        observedAt,
        {
          success: false,
          validTenderCount: 0,
          quarantinedCount: 1,
          sampleTenderIds: [],
          payloadHashes: [],
        },
        ["Human rejected the proposed self-healing change"],
      );
      return;
    }

    this.transition(incident, "approved", observedAt);
    const deadline = this.nowFn() + this.approvalTimeoutMs;
    while (this.nowFn() < deadline) {
      const progress = await this.pollProgress(sourceId, observedAt);
      if (progress.status === "done") {
        let verification: RecoveryVerification;
        try {
          verification = await rerunFn();
        } catch (error) {
          this.transition(incident, "recovery_failed", observedAt);
          incident.evidence = this.buildEvidence(
            incident,
            "failed",
            observedAt,
            {
              success: false,
              validTenderCount: 0,
              quarantinedCount: 1,
              sampleTenderIds: [],
              payloadHashes: [],
            },
            ["Approved collector rerun failed before verification completed"],
          );
          throw error;
        }
        if (!verification.success || verification.validTenderCount < 1) {
          this.transition(incident, "recovery_failed", observedAt);
          incident.evidence = this.buildEvidence(
            incident,
            "failed",
            observedAt,
            verification,
            [
              "Approved collector rerun did not pass schema and count validation",
            ],
          );
          return;
        }
        this.transition(incident, "recovered", observedAt);
        incident.evidence = this.buildEvidence(
          incident,
          "recovered",
          observedAt,
          verification,
          [
            "Confirmed structural drift and preserved the last verified snapshot",
            "Validated the Bright Data self-healing preview",
            "Human approved the proposed change",
            `Bright Data completed the heal for the same collector ${incident.collectorId}`,
            "Reran and schema-validated the same collector",
          ],
        );
        return;
      }
      if (progress.status === "pending_answer") {
        throw new Error(
          "Bright Data requested another approval step; validate the new preview before approving again",
        );
      }
      await this.sleepFn(this.pollIntervalMs);
    }

    this.transition(incident, "recovery_failed", observedAt);
    incident.evidence = this.buildEvidence(
      incident,
      "failed",
      observedAt,
      {
        success: false,
        validTenderCount: 0,
        quarantinedCount: 1,
        sampleTenderIds: [],
        payloadHashes: [],
      },
      ["Timed out waiting for Bright Data to complete the approved heal"],
    );
    throw new Error(
      "Timed out waiting for Bright Data self-healing completion",
    );
  }

  private requireIncident(sourceId: string): HealingIncident {
    const incident = this.incidents.get(sourceId);
    if (!incident) {
      throw new Error(
        `No active self-healing incident found for source ${sourceId}`,
      );
    }
    return incident;
  }

  private applyProgress(
    incident: HealingIncident,
    progress: TenderHealingProgress,
    observedAt: string,
    afterApproval: boolean,
  ): void {
    if (RUNNING_STATUSES.has(progress.status)) {
      incident.updatedAt = observedAt;
      return;
    }
    if (progress.status === "pending_answer") {
      incident.previewPayloads = structuredClone(progress.previewResult);
      this.transition(incident, "awaiting_approval", observedAt);
      return;
    }
    if (FAILURE_STATUSES.has(progress.status)) {
      this.failIncident(
        incident,
        observedAt,
        `Bright Data self-healing ended with status ${progress.status}`,
      );
      throw new Error(
        `Bright Data self-healing ended with status ${progress.status}`,
      );
    }
    if (progress.status === "done") {
      if (!afterApproval) {
        this.failIncident(
          incident,
          observedAt,
          "Bright Data self-healing completed without the required approval gate",
        );
        throw new Error(
          "Bright Data self-healing completed without the required approval gate",
        );
      }
      incident.updatedAt = observedAt;
      return;
    }

    this.failIncident(
      incident,
      observedAt,
      `Bright Data returned unknown self-healing status ${progress.status}`,
    );
    throw new Error(
      `Unknown Bright Data self-healing status: ${progress.status}`,
    );
  }

  private failIncident(
    incident: HealingIncident,
    observedAt: string,
    action: string,
  ): void {
    this.transition(incident, "recovery_failed", observedAt);
    incident.evidence = this.buildEvidence(
      incident,
      "failed",
      observedAt,
      {
        success: false,
        validTenderCount: 0,
        quarantinedCount: 1,
        sampleTenderIds: [],
        payloadHashes: [],
      },
      [action],
    );
  }

  private transition(
    incident: HealingIncident,
    state: HealingState,
    observedAt: string,
  ): void {
    incident.state = state;
    incident.updatedAt = observedAt;
    this.states.set(incident.sourceId, state);
  }

  private buildEvidence(
    incident: HealingIncident,
    outcome: "recovered" | "failed",
    completedAt: string,
    verification: RecoveryVerification,
    actions: string[],
  ): RecoveryEvidence {
    return RecoveryEvidenceSchema.parse({
      schemaVersion: 1,
      recoveryEvidenceId: randomUUID(),
      incidentId: incident.incidentId,
      sourceId: incident.sourceId,
      strategy: "alternate-parser",
      startedAt: incident.openedAt,
      completedAt,
      outcome,
      actions,
      verification: {
        validTenderCount: verification.validTenderCount,
        quarantinedCount: verification.quarantinedCount,
        sampleTenderIds: verification.sampleTenderIds.slice(0, 20),
        payloadHashes: verification.payloadHashes.slice(0, 20),
      },
    });
  }
}
