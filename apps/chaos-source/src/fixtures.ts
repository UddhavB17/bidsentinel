import type { Tender } from "@bidsentinel/contracts";
import {
  tenderWithCorrigendumFixture,
  validTenderFixture,
} from "@bidsentinel/contracts/fixtures";

export const chaosModes = [
  "baseline-table",
  "layout-cards",
  "amended",
  "unavailable",
] as const;

export type ChaosMode = (typeof chaosModes)[number];
export type AvailableChaosMode = Exclude<ChaosMode, "unavailable">;

export function isChaosMode(value: string): value is ChaosMode {
  return (chaosModes as readonly string[]).includes(value);
}

/** Layout modes return identical business data. Only their HTML differs. */
export function buildTenderForMode(mode: AvailableChaosMode): Tender {
  if (mode === "amended") {
    return structuredClone({
      ...validTenderFixture,
      submissionDeadline: tenderWithCorrigendumFixture.submissionDeadline,
      corrigenda: tenderWithCorrigendumFixture.corrigenda,
    });
  }

  return structuredClone(validTenderFixture);
}

export function fixtureEnvelope(mode: AvailableChaosMode) {
  return {
    sourceId: validTenderFixture.sourceId,
    extractorVersion: "chaos-source-v2",
    mode,
    items: [buildTenderForMode(mode)],
  };
}
