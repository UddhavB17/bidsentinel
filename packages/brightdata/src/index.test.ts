import { describe, expect, it } from "vitest";

import {
  ExternalCollectionNotConfiguredError,
  UnconfiguredBrightDataProvider,
} from "./index.js";

describe("UnconfiguredBrightDataProvider", () => {
  it("fails closed without making a network request", async () => {
    const provider = new UnconfiguredBrightDataProvider();

    await expect(
      provider.collect({
        sourceId: "gem",
        targetUrl: "https://example.gov.test/tenders",
        requestedAt: "2026-08-20T05:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ExternalCollectionNotConfiguredError);
  });
});
