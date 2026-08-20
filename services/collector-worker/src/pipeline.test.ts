import { describe, expect, it } from "vitest";

import {
  tenderWithCorrigendumFixture,
  validTenderFixture,
} from "@bidsentinel/contracts/fixtures";

import { BidSentinelPipeline } from "./pipeline.js";

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
});
