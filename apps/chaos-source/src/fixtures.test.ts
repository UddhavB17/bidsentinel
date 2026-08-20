import { describe, expect, it } from "vitest";

import { TenderSchema } from "@bidsentinel/contracts";

import { buildTenderForMode } from "./fixtures.js";

describe("chaos source fixtures", () => {
  it.each([
    "valid",
    "deadline-shift",
    "status-closed",
    "corrigendum-added",
  ] as const)("emits canonical data for %s", (mode) => {
    expect(TenderSchema.safeParse(buildTenderForMode(mode)).success).toBe(true);
  });

  it.each(["invalid-deadline", "invalid-shape"] as const)(
    "emits quarantinable data for %s",
    (mode) => {
      expect(TenderSchema.safeParse(buildTenderForMode(mode)).success).toBe(
        false,
      );
    },
  );
});
