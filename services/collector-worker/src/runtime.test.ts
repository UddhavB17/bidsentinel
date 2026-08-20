import { describe, expect, it, vi } from "vitest";

import {
  BrightDataApiError,
  MockBrightDataHealingProvider,
  type TenderHealingProvider,
  type TenderCollectionProvider,
} from "@bidsentinel/brightdata";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";

import { SelfHealingCoordinator } from "./healing-coordinator.js";
import { BidSentinelPipeline } from "./pipeline.js";
import {
  createRuntimeFromEnv,
  isAuthorizedOperatorToken,
  runConfiguredCollection,
  type BidSentinelRuntime,
} from "./runtime.js";

function liveRuntimeWith(
  provider: TenderCollectionProvider,
): BidSentinelRuntime {
  const pipeline = new BidSentinelPipeline();
  const coordinator = new SelfHealingCoordinator(
    new MockBrightDataHealingProvider([validTenderFixture]),
    { pollIntervalMs: 0 },
  );
  pipeline.healingCoordinator = coordinator;
  return {
    mode: "live",
    pipeline,
    coordinator,
    collectionProvider: provider,
    sourceId: "gem",
    collectorId: "c_exact",
    targetUrl: "https://example.gov.test/tenders",
    configurationIssues: [],
    liveMutationsEnabled: false,
    operatorTokenHash: null,
  };
}

describe("runtime selection and live collection", () => {
  it("selects explicitly labeled mock mode unless every live variable exists", () => {
    const mock = createRuntimeFromEnv({
      BRIGHT_DATA_API_TOKEN: "secret-never-serialize",
    });
    expect(mock.mode).toBe("mock");
    expect(mock.configurationIssues).toEqual(
      expect.arrayContaining([
        "BRIGHT_DATA_COLLECTOR_ID is not configured",
        "BRIGHT_DATA_TARGET_URL is not configured",
      ]),
    );
    expect(JSON.stringify(mock.configurationIssues)).not.toContain(
      "secret-never-serialize",
    );

    const live = createRuntimeFromEnv({
      BRIGHT_DATA_API_TOKEN: "secret-never-serialize",
      BRIGHT_DATA_COLLECTOR_ID: "c_exact",
      BRIGHT_DATA_TARGET_URL: "https://example.gov.test/tenders",
      BIDSENTINEL_SOURCE_ID: "gem",
    });
    expect(live.mode).toBe("live");
    expect(live.collectorId).toBe("c_exact");
    expect(live.liveMutationsEnabled).toBe(false);
    expect(live.configurationIssues).toEqual(
      expect.arrayContaining([
        "BIDSENTINEL_ENABLE_LIVE_MUTATIONS is not true",
        "BIDSENTINEL_OPERATOR_TOKEN must contain at least 32 characters",
      ]),
    );
  });

  it("enables live mutations only with the explicit flag and a strong operator token", () => {
    const operatorToken = "operator-token-with-at-least-32-chars";
    const live = createRuntimeFromEnv({
      BRIGHT_DATA_API_TOKEN: "secret-never-serialize",
      BRIGHT_DATA_COLLECTOR_ID: "c_exact",
      BRIGHT_DATA_TARGET_URL: "https://example.gov.test/tenders",
      BIDSENTINEL_SOURCE_ID: "gem",
      BIDSENTINEL_ENABLE_LIVE_MUTATIONS: "true",
      BIDSENTINEL_OPERATOR_TOKEN: operatorToken,
    });

    expect(live.liveMutationsEnabled).toBe(true);
    expect(live.configurationIssues).toEqual([]);
    expect(isAuthorizedOperatorToken(live, operatorToken)).toBe(true);
    expect(isAuthorizedOperatorToken(live, "wrong-token")).toBe(false);
    expect(JSON.stringify(live)).not.toContain(operatorToken);
  });

  it("processes every row while preserving the provider collector ID", async () => {
    const collect = vi.fn(async () => ({
      sourceId: "gem",
      collectorId: "c_exact",
      extractorVersion: "parser-v2",
      receivedAt: validTenderFixture.observedAt,
      payloads: [validTenderFixture, { title: "invalid row" }],
    }));
    const runtime = liveRuntimeWith({ collect });

    const summary = await runConfiguredCollection(runtime, {
      enableHealing: false,
    });

    expect(collect).toHaveBeenCalledTimes(1);
    expect(summary.collectorId).toBe("c_exact");
    expect(summary.outcomes).toEqual(["accepted", "quarantined"]);
    expect(summary).toMatchObject({
      success: false,
      validTenderCount: 1,
      quarantinedCount: 1,
    });
  });

  it("rejects a batch whose collector ID does not match runtime configuration", async () => {
    const runtime = liveRuntimeWith({
      collect: async () => ({
        sourceId: "gem",
        collectorId: "c_other",
        extractorVersion: "parser-v2",
        receivedAt: validTenderFixture.observedAt,
        payloads: [validTenderFixture],
      }),
    });

    await expect(runConfiguredCollection(runtime)).rejects.toThrow(
      "unexpected collector ID",
    );
    expect(
      runtime.pipeline.snapshots.list(validTenderFixture.tenderId),
    ).toEqual([]);
  });

  it("records transient collection failure without requesting healing", async () => {
    const runtime = liveRuntimeWith({
      collect: async () => {
        throw new BrightDataApiError("timeout", "collection timed out", {
          transient: true,
        });
      },
    });
    const trigger = vi.spyOn(runtime.coordinator, "handleDrift");

    await expect(runConfiguredCollection(runtime)).rejects.toMatchObject({
      code: "timeout",
    });
    expect(runtime.pipeline.sourceHealth.get("gem")).toMatchObject({
      state: "degraded",
      activeIncident: { reason: "network-error" },
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("approval polls Bright Data to done before rerunning the exact provider", async () => {
    const collectedBatches = [
      [validTenderFixture],
      [
        {
          tenderId: validTenderFixture.tenderId,
          externalId: validTenderFixture.externalId,
        },
      ],
      [{ ...validTenderFixture, observedAt: "2026-08-20T05:10:00.000Z" }],
    ];
    const collect = vi.fn(async () => ({
      sourceId: "gem",
      collectorId: "c_exact",
      extractorVersion: "parser-v2",
      receivedAt: "2026-08-20T05:10:00.000Z",
      payloads: collectedBatches.shift() ?? [],
    }));
    const triggerRefactor = vi.fn(async () => undefined);
    const resumeAutomationJob = vi.fn(async () => undefined);
    const progress = [
      { status: "pending_answer", previewResult: [validTenderFixture] },
      { status: "done", previewResult: [] },
    ];
    const healingProvider: TenderHealingProvider = {
      triggerRefactor,
      resumeAutomationJob,
      pollRefactorProgress: async () => {
        const next = progress.shift();
        if (!next) throw new Error("No progress response left");
        return next;
      },
    };
    const pipeline = new BidSentinelPipeline();
    const coordinator = new SelfHealingCoordinator(healingProvider, {
      pollIntervalMs: 0,
    });
    pipeline.healingCoordinator = coordinator;
    const runtime: BidSentinelRuntime = {
      mode: "live",
      pipeline,
      coordinator,
      collectionProvider: { collect },
      sourceId: "gem",
      collectorId: "c_exact",
      targetUrl: "https://example.gov.test/tenders",
      configurationIssues: [],
      liveMutationsEnabled: false,
      operatorTokenHash: null,
    };

    expect((await runConfiguredCollection(runtime)).success).toBe(true);
    expect((await runConfiguredCollection(runtime)).success).toBe(false);
    expect(triggerRefactor).toHaveBeenCalledWith(
      "c_exact",
      expect.stringContaining("Confirmed batch-level layout drift"),
    );

    const pending = await coordinator.pollProgress(
      "gem",
      "2026-08-20T05:11:00.000Z",
    );
    expect(
      coordinator.handlePreview(
        "gem",
        pending.previewResult,
        1,
        "2026-08-20T05:11:00.000Z",
      ),
    ).toBe(true);
    await coordinator.approveOrReject(
      "gem",
      true,
      () => runConfiguredCollection(runtime, { enableHealing: false }),
      "2026-08-20T05:12:00.000Z",
    );

    expect(resumeAutomationJob).toHaveBeenCalledWith("c_exact", true, {
      autoSave: true,
    });
    expect(collect).toHaveBeenCalledTimes(3);
    expect(coordinator.getHealingState("gem")).toBe("recovered");
    expect(coordinator.getIncident("gem")?.collectorId).toBe("c_exact");
  });
});
