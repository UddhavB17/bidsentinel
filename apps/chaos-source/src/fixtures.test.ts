import { describe, expect, it } from "vitest";

import { TenderSchema } from "@bidsentinel/contracts";

import { buildTenderForMode, fixtureEnvelope } from "./fixtures.js";

describe("chaos source fixtures", () => {
  it("keeps baseline-table and layout-cards business data identical", () => {
    expect(buildTenderForMode("layout-cards")).toEqual(
      buildTenderForMode("baseline-table"),
    );
  });

  it("changes only the deadline and corrigenda when amended", () => {
    const baseline = buildTenderForMode("layout-cards");
    const amended = buildTenderForMode("amended");
    const {
      submissionDeadline: baselineDeadline,
      corrigenda: baselineCorrigenda,
      ...baselineStable
    } = baseline;
    const {
      submissionDeadline: amendedDeadline,
      corrigenda: amendedCorrigenda,
      ...amendedStable
    } = amended;

    expect(amendedStable).toEqual(baselineStable);
    expect(amendedDeadline).not.toBe(baselineDeadline);
    expect(baselineCorrigenda).toHaveLength(0);
    expect(amendedCorrigenda).toHaveLength(1);
  });

  it.each(["baseline-table", "layout-cards", "amended"] as const)(
    "emits canonical tender data for %s",
    (mode) => {
      expect(TenderSchema.safeParse(buildTenderForMode(mode)).success).toBe(
        true,
      );
      expect(fixtureEnvelope(mode).mode).toBe(mode);
    },
  );
});
