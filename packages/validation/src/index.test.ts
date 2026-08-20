import { describe, expect, it } from "vitest";

import { validTenderFixture } from "@bidsentinel/contracts/fixtures";

import {
  hashPayload,
  stableStringify,
  validateTenderExtraction,
} from "./index.js";

const context = {
  sourceId: "gem",
  extractorVersion: "fixture-v1",
  observedAt: "2026-08-20T05:00:00.000Z",
};

describe("validateTenderExtraction", () => {
  it("returns a canonical tender for valid input", () => {
    const result = validateTenderExtraction(validTenderFixture, context);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.tenderId).toBe(validTenderFixture.tenderId);
    }
  });

  it("quarantines invalid extraction with the original payload and issues", () => {
    const invalidPayload = {
      ...validTenderFixture,
      submissionDeadline: "not-a-date",
    };
    const result = validateTenderExtraction(invalidPayload, context);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.quarantine.rawPayload).toEqual(invalidPayload);
      expect(result.quarantine.issues[0]?.path).toEqual(["submissionDeadline"]);
      expect(result.quarantine.payloadHash).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("quarantines a valid payload attributed to the wrong source", () => {
    const result = validateTenderExtraction(validTenderFixture, {
      ...context,
      sourceId: "cppp",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.quarantine.issues[0]?.code).toBe("source_id_mismatch");
    }
  });
});

describe("stable payload hashing", () => {
  it("is independent of object key order", () => {
    const left = { nested: { second: 2, first: 1 }, name: "tender" };
    const right = { name: "tender", nested: { first: 1, second: 2 } };

    expect(stableStringify(left)).toBe(stableStringify(right));
    expect(hashPayload(left)).toBe(hashPayload(right));
  });
});
