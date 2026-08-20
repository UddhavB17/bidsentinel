import { randomUUID } from "node:crypto";
import { type RecoveryEvidence } from "@bidsentinel/contracts";
import { type TenderHealingProvider } from "@bidsentinel/brightdata";

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

export class SelfHealingCoordinator {
  private readonly healingProvider: TenderHealingProvider;
  private readonly incidents = new Map<string, HealingIncident>();
  private readonly states = new Map<string, HealingState>();

  constructor(healingProvider: TenderHealingProvider) {
    this.healingProvider = healingProvider;
  }

  getHealingState(sourceId: string): HealingState {
    return this.states.get(sourceId) ?? "healthy";
  }

  setHealingState(sourceId: string, state: HealingState): void {
    this.states.set(sourceId, state);
  }

  getIncident(sourceId: string): HealingIncident | undefined {
    return this.incidents.get(sourceId);
  }

  async handleDrift(
    sourceId: string,
    collectorId: string,
    reason: string,
    prompt: string,
    observedAt: string
  ): Promise<void> {
    const incidentId = randomUUID();
    const incident: HealingIncident = {
      incidentId,
      sourceId,
      collectorId,
      state: "quarantined",
      openedAt: observedAt,
      updatedAt: observedAt,
      reason,
      prompt,
    };
    this.incidents.set(sourceId, incident);
    this.states.set(sourceId, "quarantined");

    // Transition to healing_requested and trigger API refactor
    this.states.set(sourceId, "healing_requested");
    incident.state = "healing_requested";
    incident.updatedAt = new Date().toISOString();

    try {
      await this.healingProvider.triggerRefactor(collectorId, prompt);
    } catch (error) {
      this.states.set(sourceId, "recovery_failed");
      incident.state = "recovery_failed";
      throw error;
    }
  }

  async pollProgress(sourceId: string, observedAt: string): Promise<string> {
    const incident = this.incidents.get(sourceId);
    if (!incident) {
      throw new Error(`No active self-healing incident found for source ${sourceId}`);
    }

    const state = this.states.get(sourceId);
    if (state !== "healing_requested") {
      return state ?? "healthy";
    }

    try {
      const status = await this.healingProvider.pollRefactorProgress(incident.collectorId);
      if (status === "pending_answer") {
        this.states.set(sourceId, "awaiting_approval");
        incident.state = "awaiting_approval";
        incident.updatedAt = observedAt;
      }
      return status;
    } catch (error) {
      this.states.set(sourceId, "recovery_failed");
      incident.state = "recovery_failed";
      throw error;
    }
  }

  async handlePreview(
    sourceId: string,
    previewPayloads: unknown[],
    validateFn: (payload: unknown) => { ok: boolean },
    expectedMinCount = 1,
    observedAt: string
  ): Promise<boolean> {
    const incident = this.incidents.get(sourceId);
    if (!incident) {
      throw new Error(`No active self-healing incident found for source ${sourceId}`);
    }

    incident.previewPayloads = previewPayloads;
    incident.updatedAt = observedAt;

    const hasEnoughResults = previewPayloads.length >= expectedMinCount;
    const allValid = previewPayloads.length > 0 && previewPayloads.every((p) => validateFn(p).ok);

    if (hasEnoughResults && allValid) {
      this.states.set(sourceId, "preview_valid");
      incident.state = "preview_valid";
      return true;
    } else {
      this.states.set(sourceId, "preview_invalid");
      incident.state = "preview_invalid";
      return false;
    }
  }

  async approveOrReject(
    sourceId: string,
    approve: boolean,
    rerunFn: () => Promise<boolean>,
    observedAt: string
  ): Promise<void> {
    const incident = this.incidents.get(sourceId);
    if (!incident) {
      throw new Error(`No active self-healing incident found for source ${sourceId}`);
    }

    const currentState = this.states.get(sourceId);
    const validStatesForApproval = ["preview_valid", "preview_invalid", "awaiting_approval"];
    if (!currentState || !validStatesForApproval.includes(currentState)) {
      throw new Error(`Cannot approve or reject from state ${currentState}`);
    }

    const targetState = approve ? "approved" : "rejected";
    this.states.set(sourceId, targetState);
    incident.state = targetState;
    incident.updatedAt = observedAt;

    try {
      await this.healingProvider.resumeAutomationJob(incident.collectorId, approve);

      if (approve) {
        const rerunSuccess = await rerunFn();
        if (rerunSuccess) {
          this.states.set(sourceId, "recovered");
          incident.state = "recovered";
          
          const sampleTenderIds = (incident.previewPayloads ?? []).map((p) => {
            if (p && typeof p === "object" && "tenderId" in p && typeof p.tenderId === "string") {
              return p.tenderId;
            }
            return "unknown";
          });

          incident.evidence = {
            schemaVersion: 1,
            recoveryEvidenceId: randomUUID(),
            incidentId: incident.incidentId,
            sourceId,
            strategy: "alternate-parser",
            startedAt: incident.openedAt,
            completedAt: observedAt,
            outcome: "recovered",
            actions: [
              "Layout drift detected",
              `Refactored scraper with prompt: "${incident.prompt || ""}"`,
              "Preview validated successfully",
              "Human approved refactored code",
              "Rerun scraper successfully completed",
            ],
            verification: {
              validTenderCount: incident.previewPayloads?.length ?? 0,
              quarantinedCount: 0,
              sampleTenderIds,
              payloadHashes: [],
            },
          };
        } else {
          this.states.set(sourceId, "recovery_failed");
          incident.state = "recovery_failed";
        }
      } else {
        this.states.set(sourceId, "recovery_failed");
        incident.state = "recovery_failed";
      }
    } catch (error) {
      this.states.set(sourceId, "recovery_failed");
      incident.state = "recovery_failed";
      throw error;
    }
  }
}
