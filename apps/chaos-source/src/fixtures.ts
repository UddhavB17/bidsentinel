import {
  tenderWithCorrigendumFixture,
  validTenderFixture,
} from "@bidsentinel/contracts/fixtures";

export const chaosModes = [
  "valid",
  "deadline-shift",
  "status-closed",
  "corrigendum-added",
  "invalid-deadline",
  "invalid-shape",
] as const;

export type ChaosMode = (typeof chaosModes)[number];

export function isChaosMode(value: string): value is ChaosMode {
  return (chaosModes as readonly string[]).includes(value);
}

export function buildTenderForMode(mode: ChaosMode): unknown {
  switch (mode) {
    case "valid":
      return structuredClone(validTenderFixture);
    case "deadline-shift":
      return {
        ...validTenderFixture,
        submissionDeadline: "2026-09-22T12:00:00.000Z",
        observedAt: "2026-08-21T05:00:00.000Z",
      };
    case "status-closed":
      return {
        ...validTenderFixture,
        status: "closed",
        observedAt: "2026-08-21T05:00:00.000Z",
      };
    case "corrigendum-added":
      return structuredClone(tenderWithCorrigendumFixture);
    case "invalid-deadline":
      return {
        ...validTenderFixture,
        submissionDeadline: "extended until further notice",
      };
    case "invalid-shape": {
      const payload: Record<string, unknown> =
        structuredClone(validTenderFixture);
      Reflect.deleteProperty(payload, "title");
      return payload;
    }
  }
}
