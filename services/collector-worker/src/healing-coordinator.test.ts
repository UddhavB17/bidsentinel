import { describe, expect, it, vi } from "vitest";

import {
  type TenderHealingProgress,
  type TenderHealingProvider,
} from "@bidsentinel/brightdata";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";

import { SelfHealingCoordinator } from "./healing-coordinator.js";
import { BidSentinelPipeline } from "./pipeline.js";

const observedAt = "2026-08-20T05:00:00.000Z";
const collectorId = "c_same_collector";
const context = {
  sourceId: "gem",
  collectorId,
  extractorVersion: "tender-parser-v1",
  observedAt,
};

class ScriptedHealingProvider implements TenderHealingProvider {
  readonly triggerRefactor = vi.fn(async () => undefined);
  readonly resumeAutomationJob = vi.fn(async () => undefined);
  readonly pollRefactorProgress = vi.fn(async () => {
    const progress = this.progress.shift();
    if (!progress) throw new Error("No scripted healing progress remains");
    return progress;
  });

  constructor(private readonly progress: TenderHealingProgress[]) {}
}

function validVerification() {
  return {
    success: true,
    validTenderCount: 1,
    quarantinedCount: 0,
    sampleTenderIds: [validTenderFixture.tenderId],
    payloadHashes: ["a".repeat(64)],
  };
}

describe("SelfHealingCoordinator reliability gate", () => {
  it("heals confirmed structural drift using the first-class collector ID", async () => {
    const provider = new ScriptedHealingProvider([]);
    const coordinator = new SelfHealingCoordinator(provider, {
      pollIntervalMs: 0,
    });
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = coordinator;
    await pipeline.processWithHealing(validTenderFixture, context);

    const result = await pipeline.processWithHealing(
      {
        tenderId: validTenderFixture.tenderId,
        externalId: validTenderFixture.externalId,
        url: validTenderFixture.url,
      },
      context,
    );

    expect(result.outcome).toBe("quarantined");
    expect(provider.triggerRefactor).toHaveBeenCalledWith(
      collectorId,
      expect.stringContaining("Confirmed batch-level layout drift"),
    );
    expect(coordinator.getHealingState("gem")).toBe("healing_requested");
    expect(coordinator.getIncident("gem")?.collectorId).toBe(collectorId);
  });

  it("does not heal one malformed date and preserves the verified baseline", async () => {
    const provider = new ScriptedHealingProvider([]);
    const coordinator = new SelfHealingCoordinator(provider);
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = coordinator;
    pipeline.process(validTenderFixture, context);

    const result = await pipeline.processWithHealing(
      { ...validTenderFixture, submissionDeadline: "tomorrow" },
      context,
    );

    expect(result.outcome).toBe("quarantined");
    expect(provider.triggerRefactor).not.toHaveBeenCalled();
    expect(pipeline.snapshots.list(validTenderFixture.tenderId)).toHaveLength(
      1,
    );
    expect(
      pipeline.snapshots.latest(validTenderFixture.tenderId)?.tender
        .submissionDeadline,
    ).toBe(validTenderFixture.submissionDeadline);
  });

  it("requires repeated evidence for a single missing structural field", async () => {
    const provider = new ScriptedHealingProvider([]);
    const coordinator = new SelfHealingCoordinator(provider);
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = coordinator;
    const missingTitle = structuredClone(validTenderFixture) as Record<
      string,
      unknown
    >;
    delete missingTitle.title;

    await pipeline.processWithHealing(missingTitle, context);
    expect(provider.triggerRefactor).not.toHaveBeenCalled();

    await pipeline.processWithHealing(missingTitle, context);
    expect(provider.triggerRefactor).toHaveBeenCalledTimes(1);
  });

  it("surfaces a self-healing trigger failure and records failed state", async () => {
    const provider = new ScriptedHealingProvider([]);
    provider.triggerRefactor.mockRejectedValueOnce(new Error("trigger failed"));
    const coordinator = new SelfHealingCoordinator(provider);
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = coordinator;
    await pipeline.processWithHealing(validTenderFixture, context);

    await expect(
      pipeline.processWithHealing(
        { tenderId: "gem:broken", externalId: "broken" },
        context,
      ),
    ).rejects.toThrow("trigger failed");
    expect(coordinator.getHealingState("gem")).toBe("recovery_failed");
    expect(coordinator.getIncident("gem")?.evidence?.outcome).toBe("failed");
  });

  it("refuses approval until the preview passes the Tender schema canary", async () => {
    const provider = new ScriptedHealingProvider([
      {
        status: "pending_answer",
        previewResult: [{ title: "still broken" }],
      },
    ]);
    const coordinator = new SelfHealingCoordinator(provider);
    await coordinator.handleDrift(
      "gem",
      collectorId,
      "schema-drift",
      "restore fields",
      observedAt,
    );
    await coordinator.pollProgress("gem", observedAt);

    await expect(
      coordinator.approveOrReject(
        "gem",
        true,
        async () => validVerification(),
        observedAt,
      ),
    ).rejects.toThrow("schema-valid preview is required");
    expect(
      coordinator.handlePreview(
        "gem",
        [{ title: "still broken" }],
        1,
        observedAt,
      ),
    ).toBe(false);
    await expect(
      coordinator.approveOrReject(
        "gem",
        true,
        async () => validVerification(),
        observedAt,
      ),
    ).rejects.toThrow("schema-valid preview is required");

    await coordinator.approveOrReject(
      "gem",
      false,
      async () => validVerification(),
      observedAt,
    );
    expect(coordinator.getHealingState("gem")).toBe("rejected");
    expect(provider.resumeAutomationJob).toHaveBeenCalledWith(
      collectorId,
      false,
      { autoSave: false },
    );
  });

  it("polls to done after approval, then reruns the same collector", async () => {
    const provider = new ScriptedHealingProvider([
      { status: "pending_answer", previewResult: [validTenderFixture] },
      { status: "in_progress", previewResult: [] },
      { status: "done", previewResult: [] },
    ]);
    const coordinator = new SelfHealingCoordinator(provider, {
      pollIntervalMs: 0,
      approvalTimeoutMs: 1000,
    });
    await coordinator.handleDrift(
      "gem",
      collectorId,
      "schema-drift",
      "restore fields",
      observedAt,
    );
    const awaiting = await coordinator.pollProgress("gem", observedAt);
    expect(awaiting.previewResult).toEqual([validTenderFixture]);
    expect(
      coordinator.handlePreview("gem", awaiting.previewResult, 1, observedAt),
    ).toBe(true);

    const rerun = vi.fn(async () => validVerification());
    await coordinator.approveOrReject("gem", true, rerun, observedAt);

    expect(provider.resumeAutomationJob).toHaveBeenCalledWith(
      collectorId,
      true,
      { autoSave: true },
    );
    expect(provider.pollRefactorProgress).toHaveBeenCalledTimes(3);
    expect(rerun).toHaveBeenCalledTimes(1);
    expect(coordinator.getHealingState("gem")).toBe("recovered");
    expect(coordinator.getIncident("gem")?.evidence?.verification).toEqual(
      expect.objectContaining({
        validTenderCount: 1,
        payloadHashes: ["a".repeat(64)],
      }),
    );
  });

  it("fails closed on an undocumented progress status", async () => {
    const provider = new ScriptedHealingProvider([
      { status: "mystery_terminal", previewResult: [] },
    ]);
    const coordinator = new SelfHealingCoordinator(provider);
    await coordinator.handleDrift(
      "gem",
      collectorId,
      "schema-drift",
      "restore fields",
      observedAt,
    );

    await expect(coordinator.pollProgress("gem", observedAt)).rejects.toThrow(
      "Unknown Bright Data self-healing status",
    );
    expect(coordinator.getHealingState("gem")).toBe("recovery_failed");
    expect(coordinator.getIncident("gem")?.evidence).toMatchObject({
      outcome: "failed",
      verification: { validTenderCount: 0, quarantinedCount: 1 },
    });
  });
});
