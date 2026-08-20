import {
  tenderWithCorrigendumFixture,
  validTenderFixture,
} from "@bidsentinel/contracts/fixtures";

import { BidSentinelPipeline } from "./pipeline.js";

const pipeline = new BidSentinelPipeline();
const baseContext = {
  sourceId: "gem",
  extractorVersion: "fixture-v1",
  observedAt: validTenderFixture.observedAt,
};

const initial = pipeline.process(validTenderFixture, baseContext);
const invalid = pipeline.process(
  { ...validTenderFixture, submissionDeadline: "invalid-date" },
  { ...baseContext, observedAt: "2026-08-20T05:05:00.000Z" },
);
const recovered = pipeline.process(tenderWithCorrigendumFixture, {
  ...baseContext,
  observedAt: tenderWithCorrigendumFixture.observedAt,
});

console.log(
  JSON.stringify(
    {
      outcomes: [initial.outcome, invalid.outcome, recovered.outcome],
      snapshotVersions: pipeline.snapshots
        .list(validTenderFixture.tenderId)
        .map((snapshot) => snapshot.version),
      changeKinds: pipeline.changeEvents
        .list()
        .flatMap((event) => event.changes.map((change) => change.kind)),
      quarantinedExtractions: pipeline.quarantines.listBySource("gem").length,
      recoveryEvidence: pipeline.recoveryEvidence.listBySource("gem").length,
      sourceState: pipeline.sourceHealth.get("gem")?.state,
    },
    null,
    2,
  ),
);
