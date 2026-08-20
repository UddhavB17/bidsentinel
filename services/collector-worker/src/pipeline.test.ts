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
});
