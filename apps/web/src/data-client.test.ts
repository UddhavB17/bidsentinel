import { describe, expect, it, vi } from "vitest";

import {
  validChangeEventListResponseFixture,
  validQuarantineListResponseFixture,
  validSourceHealthListResponseFixture,
  validTenderListResponseFixture,
} from "@bidsentinel/contracts/fixtures";

import {
  FixtureBidSentinelDataClient,
  HttpBidSentinelDataClient,
  isGeneratedDataStale,
} from "./data-client";

describe("fixture dashboard adapter", () => {
  it("runs the deterministic recovery flow before emitting an amendment", async () => {
    const client = new FixtureBidSentinelDataClient();

    expect((await client.load()).healing.state).toBe("healthy");
    await client.collect("drift");
    let snapshot = await client.load();
    expect(snapshot.healing.state).toBe("healing_requested");
    expect(snapshot.quarantines.data).toHaveLength(1);
    expect(snapshot.tenders.data[0]?.latestSnapshot.version).toBe(1);

    await client.progressHealing();
    expect((await client.load()).healing.state).toBe("awaiting_approval");
    await client.validatePreview();
    expect((await client.load()).healing.state).toBe("preview_valid");
    await client.approve(true);
    expect((await client.load()).healing.state).toBe("recovered");

    await client.collect("amended");
    snapshot = await client.load();
    expect(snapshot.changes.data).toHaveLength(1);
    expect(snapshot.tenders.data[0]?.latestSnapshot.version).toBe(2);
    expect(snapshot.tenders.data[0]?.corrigendumCount).toBe(1);
  });

  it("exposes safe preview failure, recovery failure, stale and unavailable states", async () => {
    const client = new FixtureBidSentinelDataClient();

    client.setInspectionScenario("preview_invalid");
    expect((await client.load()).healing.state).toBe("preview_invalid");
    client.setInspectionScenario("recovery_failed");
    expect((await client.load()).healing.state).toBe("recovery_failed");
    client.setInspectionScenario("stale");
    expect((await client.load()).stale).toBe(true);
    client.setInspectionScenario("unavailable");
    await expect(client.load()).rejects.toMatchObject({ status: 503 });
  });
});

describe("HTTP dashboard adapter", () => {
  it("loads and contract-validates the API views", async () => {
    const responses: Record<string, unknown> = {
      "/api/runtime": {
        data: {
          mode: "mock",
          sourceId: "gem",
          collectorConfigured: false,
          targetConfigured: false,
          liveMutationsEnabled: false,
          configurationIssues: [],
        },
      },
      "/api/tenders": validTenderListResponseFixture,
      "/api/changes": validChangeEventListResponseFixture,
      "/api/sources": validSourceHealthListResponseFixture,
      "/api/quarantines": validQuarantineListResponseFixture,
      "/api/healing/gem": {
        data: {
          mode: "mock",
          sourceId: "gem",
          state: "recovered",
          incident: null,
        },
      },
    };
    const fetchFn = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input), "http://test.local");
      return new Response(JSON.stringify(responses[url.pathname]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const client = new HttpBidSentinelDataClient(
      "http://test.local",
      fetchFn as typeof fetch,
    );

    const snapshot = await client.load();
    expect(snapshot.runtime.mode).toBe("mock");
    expect(snapshot.tenders.data).toHaveLength(1);
    expect(snapshot.healing.state).toBe("recovered");
    expect(fetchFn).toHaveBeenCalledTimes(6);
  });

  it("sends the operator token only on a mutation request", async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = new HttpBidSentinelDataClient(
      "http://test.local",
      fetchFn as typeof fetch,
    );

    await client.approve(true, { operatorToken: "secret-operator-token" });

    const calls = fetchFn.mock.calls as unknown as Array<
      [input: unknown, init?: RequestInit]
    >;
    const [, init] = calls[0] ?? [];
    expect(init?.headers).toMatchObject({
      "x-bidsentinel-operator-token": "secret-operator-token",
    });
    expect(init?.body).toBe('{"approve":true}');
  });
});

describe("freshness", () => {
  it("marks responses stale after the explicit two-minute boundary", () => {
    const now = Date.parse("2026-08-20T10:05:00.000Z");
    expect(isGeneratedDataStale(["2026-08-20T10:04:00.000Z"], now)).toBe(false);
    expect(isGeneratedDataStale(["2026-08-20T10:02:59.999Z"], now)).toBe(true);
  });
});
