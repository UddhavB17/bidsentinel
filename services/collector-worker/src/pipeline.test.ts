import { describe, expect, it, vi } from "vitest";

import { MockBrightDataHealingProvider } from "@bidsentinel/brightdata";

import {
  tenderWithCorrigendumFixture,
  validTenderFixture,
} from "@bidsentinel/contracts/fixtures";

import { BidSentinelPipeline } from "./pipeline.js";
import { SelfHealingCoordinator } from "./healing-coordinator.js";

const context = {
  sourceId: "gem",
  extractorVersion: "fixture-v1",
  observedAt: validTenderFixture.observedAt,
};

describe("BidSentinelPipeline", () => {
  it("creates immutable state versions and suppresses duplicate observations", () => {
    const pipeline = new BidSentinelPipeline();
    const first = pipeline.process(validTenderFixture, context);
    const duplicate = pipeline.process(
      {
        ...validTenderFixture,
        observedAt: "2026-08-20T05:10:00.000Z",
      },
      { ...context, observedAt: "2026-08-20T05:10:00.000Z" },
    );

    expect(first.outcome).toBe("accepted");
    expect(duplicate.outcome).toBe("accepted");
    if (first.outcome === "accepted" && duplicate.outcome === "accepted") {
      expect(first.snapshot?.version).toBe(1);
      expect(duplicate.snapshot).toBeNull();
    }
    expect(pipeline.snapshots.list(validTenderFixture.tenderId)).toHaveLength(
      1,
    );
  });

  it("detects deadline, status, and corrigendum changes", () => {
    const pipeline = new BidSentinelPipeline();
    pipeline.process(validTenderFixture, context);
    const changed = pipeline.process(
      { ...tenderWithCorrigendumFixture, status: "closed" },
      {
        ...context,
        observedAt: tenderWithCorrigendumFixture.observedAt,
      },
    );

    expect(changed.outcome).toBe("accepted");
    if (changed.outcome === "accepted") {
      expect(changed.snapshot?.version).toBe(2);
      expect(changed.changeEvent?.changes.map((change) => change.kind)).toEqual(
        ["status", "deadline", "corrigendum"],
      );
    }
  });

  it("quarantines invalid extraction and records verified recovery", () => {
    const pipeline = new BidSentinelPipeline();
    const invalid = pipeline.process(
      { ...validTenderFixture, submissionDeadline: "tomorrow" },
      context,
    );
    const recoveryTime = "2026-08-20T05:10:00.000Z";
    const recovered = pipeline.process(
      { ...validTenderFixture, observedAt: recoveryTime },
      { ...context, observedAt: recoveryTime },
    );

    expect(invalid.outcome).toBe("quarantined");
    if (invalid.outcome === "quarantined") {
      expect(invalid.health.state).toBe("quarantined");
    }
    expect(pipeline.quarantines.listBySource("gem")).toHaveLength(1);

    expect(recovered.outcome).toBe("accepted");
    if (recovered.outcome === "accepted") {
      expect(recovered.health.state).toBe("healthy");
      expect(recovered.recoveryEvidence?.outcome).toBe("recovered");
      expect(recovered.recoveryEvidence?.verification).toMatchObject({
        validTenderCount: 1,
        quarantinedCount: 1,
        sampleTenderIds: [validTenderFixture.tenderId],
      });
    }
    expect(pipeline.recoveryEvidence.listBySource("gem")).toHaveLength(1);
  });

  it("rejects semantically invalid snapshots without replacing the baseline", () => {
    const pipeline = new BidSentinelPipeline();
    pipeline.process(validTenderFixture, context);
    const originalDocument = validTenderFixture.documents[0];
    if (originalDocument === undefined) {
      throw new Error("Fixture must include a document");
    }

    const duplicate = pipeline.process(
      {
        ...validTenderFixture,
        observedAt: "2026-08-21T05:00:00.000Z",
        documents: [originalDocument, { ...originalDocument }],
      },
      { ...context, observedAt: "2026-08-21T05:00:00.000Z" },
    );
    const regressed = pipeline.process(
      {
        ...validTenderFixture,
        status: "closed",
        observedAt: "2026-08-19T05:00:00.000Z",
      },
      { ...context, observedAt: "2026-08-19T05:00:00.000Z" },
    );

    expect(duplicate.outcome).toBe("quarantined");
    expect(regressed.outcome).toBe("quarantined");
    expect(pipeline.snapshots.list(validTenderFixture.tenderId)).toHaveLength(
      1,
    );
    expect(
      pipeline.snapshots.latest(validTenderFixture.tenderId)?.tender.status,
    ).toBe("open");
  });

  it("keeps stored snapshots isolated from returned mutable objects", () => {
    const pipeline = new BidSentinelPipeline();
    const accepted = pipeline.process(validTenderFixture, context);
    if (accepted.outcome !== "accepted" || accepted.snapshot === null) {
      throw new Error("Fixture must produce a snapshot");
    }

    accepted.snapshot.tender.status = "closed";
    accepted.health.state = "quarantined";
    const readCopy = pipeline.snapshots.latest(validTenderFixture.tenderId);
    if (readCopy === null) {
      throw new Error("Expected stored snapshot");
    }
    readCopy.tender.status = "cancelled";

    expect(
      pipeline.snapshots.latest(validTenderFixture.tenderId)?.tender.status,
    ).toBe("open");
    expect(pipeline.sourceHealth.get("gem")?.state).toBe("healthy");
  });

  it("classifies structural extraction failure as schema drift", () => {
    const pipeline = new BidSentinelPipeline();
    const invalidShape: Record<string, unknown> =
      structuredClone(validTenderFixture);
    Reflect.deleteProperty(invalidShape, "title");

    const result = pipeline.process(invalidShape, context);

    expect(result.outcome).toBe("quarantined");
    if (result.outcome === "quarantined") {
      expect(result.health.activeIncident?.reason).toBe("schema-drift");
    }
  });

  it("quarantines one malformed row in a 100-row batch without healing", async () => {
    const provider = new MockBrightDataHealingProvider();
    const trigger = vi.spyOn(provider, "triggerRefactor");
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = new SelfHealingCoordinator(provider);
    const validRows = Array.from({ length: 99 }, (_, index) => ({
      ...validTenderFixture,
      tenderId: `gem:valid-${index}`,
      externalId: `valid-${index}`,
      url: `https://example.gov.test/tenders/valid-${index}`,
    }));

    const results = await pipeline.processBatchWithHealing(
      [...validRows, { tenderId: "gem:broken", externalId: "broken" }],
      { ...context, collectorId: "c_batch_safe" },
    );

    expect(
      results.filter((result) => result.outcome === "accepted"),
    ).toHaveLength(99);
    expect(
      results.filter((result) => result.outcome === "quarantined"),
    ).toHaveLength(1);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("does not heal a first-ever empty batch without a verified baseline", async () => {
    const provider = new MockBrightDataHealingProvider();
    const trigger = vi.spyOn(provider, "triggerRefactor");
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = new SelfHealingCoordinator(provider);

    const results = await pipeline.processBatchWithHealing([], {
      ...context,
      collectorId: "c_initial_empty",
    });

    expect(results).toEqual([]);
    expect(pipeline.quarantines.listBySource("gem")).toEqual([]);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("heals a count collapse only after a verified batch baseline", async () => {
    const provider = new MockBrightDataHealingProvider();
    const trigger = vi.spyOn(provider, "triggerRefactor");
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = new SelfHealingCoordinator(provider);
    const baseline = Array.from({ length: 4 }, (_, index) => ({
      ...validTenderFixture,
      tenderId: `gem:baseline-${index}`,
      externalId: `baseline-${index}`,
      url: `https://example.gov.test/tenders/baseline-${index}`,
    }));
    const batchContext = { ...context, collectorId: "c_collapse" };

    await pipeline.processBatchWithHealing(baseline, batchContext);
    expect(trigger).not.toHaveBeenCalled();
    const collapsed = await pipeline.processBatchWithHealing([], batchContext);

    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]?.outcome).toBe("quarantined");
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      "c_collapse",
      expect.stringContaining("result-count collapse"),
    );
  });

  it("heals the same majority structural signature repeated across two runs", async () => {
    const provider = new MockBrightDataHealingProvider();
    const trigger = vi.spyOn(provider, "triggerRefactor");
    const pipeline = new BidSentinelPipeline();
    pipeline.healingCoordinator = new SelfHealingCoordinator(provider);
    const broken = [
      { tenderId: "gem:broken-1", externalId: "broken-1" },
      { tenderId: "gem:broken-2", externalId: "broken-2" },
    ];
    const batchContext = { ...context, collectorId: "c_repeat" };

    await pipeline.processBatchWithHealing(broken, batchContext);
    expect(trigger).not.toHaveBeenCalled();
    await pipeline.processBatchWithHealing(broken, batchContext);

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith(
      "c_repeat",
      expect.stringContaining("Confirmed batch-level layout drift"),
    );
  });
});
