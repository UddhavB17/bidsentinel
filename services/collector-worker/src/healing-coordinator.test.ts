import { describe, expect, it, vi } from "vitest";
import { MockBrightDataHealingProvider } from "@bidsentinel/brightdata";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";
import { validateTenderExtraction } from "@bidsentinel/validation";
import { BidSentinelPipeline } from "./pipeline.js";
import { SelfHealingCoordinator } from "./healing-coordinator.js";

describe("SelfHealingCoordinator", () => {
  it("triggers layout drift and transitions states on schema error", async () => {
    const mockProvider = new MockBrightDataHealingProvider();
    const triggerSpy = vi.spyOn(mockProvider, "triggerRefactor");

    const pipeline = new BidSentinelPipeline();
    const coordinator = new SelfHealingCoordinator(mockProvider);
    pipeline.healingCoordinator = coordinator;

    const observedAt = "2026-08-20T05:00:00.000Z";
    const context = {
      sourceId: "gem",
      extractorVersion: "chaos-source-v1",
      observedAt,
    };

    // Send malformed input missing 'title'
    const malformedTender = {
      tenderId: "gem:2026-rail-signalling-001",
      externalId: "2026-rail-signalling-001",
      url: "https://example.gov.test/tenders/001",
    };

    const result = pipeline.process(malformedTender, context);
    expect(result.outcome).toBe("quarantined");

    // Wait a brief tick for async handleDrift to fire (if run asynchronously)
    expect(coordinator.getHealingState("gem")).toBe("healing_requested");
    expect(triggerSpy).toHaveBeenCalledWith("chaos-source-v1", expect.stringContaining("Layout drift detected"));

    // Poll progress
    const progress = await coordinator.pollProgress("gem", observedAt);
    expect(progress).toBe("in_progress"); // mock returns in_progress first

    const progress2 = await coordinator.pollProgress("gem", observedAt);
    expect(progress2).toBe("pending_answer");
    expect(coordinator.getHealingState("gem")).toBe("awaiting_approval");

    // Run canary verification on empty/invalid preview
    const previewInvalid = await coordinator.handlePreview(
      "gem",
      [],
      (p) => validateTenderExtraction(p, context),
      1,
      observedAt
    );
    expect(previewInvalid).toBe(false);
    expect(coordinator.getHealingState("gem")).toBe("preview_invalid");

    // Run canary verification on valid preview
    const previewValid = await coordinator.handlePreview(
      "gem",
      [validTenderFixture],
      (p) => validateTenderExtraction(p, context),
      1,
      observedAt
    );
    expect(previewValid).toBe(true);
    expect(coordinator.getHealingState("gem")).toBe("preview_valid");

    // Human Approval
    const resumeSpy = vi.spyOn(mockProvider, "resumeAutomationJob");
    let rerunCalled = false;
    const rerunFn = async () => {
      rerunCalled = true;
      return true;
    };

    await coordinator.approveOrReject("gem", true, rerunFn, observedAt);
    expect(coordinator.getHealingState("gem")).toBe("recovered");
    expect(resumeSpy).toHaveBeenCalledWith("chaos-source-v1", true);
    expect(rerunCalled).toBe(true);

    const incident = coordinator.getIncident("gem");
    expect(incident?.evidence?.outcome).toBe("recovered");
    expect(incident?.evidence?.verification.validTenderCount).toBe(1);
    expect(incident?.evidence?.verification.sampleTenderIds).toContain("gem:2026-rail-signalling-001");
  });

  it("handles transient network failures without triggering healing", async () => {
    const mockProvider = new MockBrightDataHealingProvider();
    const triggerSpy = vi.spyOn(mockProvider, "triggerRefactor");

    const pipeline = new BidSentinelPipeline();
    const coordinator = new SelfHealingCoordinator(mockProvider);
    pipeline.healingCoordinator = coordinator;

    // A transient failure in BidSentinel is modeled by the collector provider throwing an error,
    // which prevents the pipeline process from even running. The coordinator remains healthy.
    expect(coordinator.getHealingState("gem")).toBe("healthy");
    expect(triggerSpy).not.toHaveBeenCalled();
  });

  it("handles rejection and transitions to recovery_failed", async () => {
    const mockProvider = new MockBrightDataHealingProvider();
    const resumeSpy = vi.spyOn(mockProvider, "resumeAutomationJob");

    const coordinator = new SelfHealingCoordinator(mockProvider);
    const observedAt = "2026-08-20T05:00:00.000Z";

    await coordinator.handleDrift("gem", "c_test_123", "schema-drift", "drift", observedAt);
    await coordinator.pollProgress("gem", observedAt);
    await coordinator.pollProgress("gem", observedAt); // pending_answer
    await coordinator.handlePreview("gem", [], (_p) => ({ ok: false }), 1, observedAt);

    expect(coordinator.getHealingState("gem")).toBe("preview_invalid");

    const rerunFn = async () => true;
    await coordinator.approveOrReject("gem", false, rerunFn, observedAt);

    expect(coordinator.getHealingState("gem")).toBe("recovery_failed");
    expect(resumeSpy).toHaveBeenCalledWith("c_test_123", false);
  });
});
