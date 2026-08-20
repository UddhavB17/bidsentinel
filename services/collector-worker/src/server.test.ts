import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BidSentinelPipeline } from "./pipeline.js";
import { MockBrightDataHealingProvider } from "@bidsentinel/brightdata";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";
import { SelfHealingCoordinator } from "./healing-coordinator.js";
import { createRequestHandler } from "./server.js";
import { createRuntimeFromEnv, type BidSentinelRuntime } from "./runtime.js";

async function startRuntimeServer(runtime: BidSentinelRuntime) {
  const server = createServer(
    createRequestHandler(runtime.pipeline, runtime.coordinator, runtime),
  );
  const baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
  return { server, baseUrl };
}

async function stopRuntimeServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("BidSentinel API Server", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let pipeline: BidSentinelPipeline;
  let coordinator: SelfHealingCoordinator;

  beforeAll(async () => {
    pipeline = new BidSentinelPipeline();
    const healingProvider = new MockBrightDataHealingProvider([
      validTenderFixture,
    ]);
    coordinator = new SelfHealingCoordinator(healingProvider, {
      pollIntervalMs: 0,
    });
    pipeline.healingCoordinator = coordinator;

    const runtime: BidSentinelRuntime = {
      mode: "mock",
      pipeline,
      coordinator,
      collectionProvider: null,
      sourceId: "gem",
      collectorId: null,
      targetUrl: null,
      configurationIssues: ["test runtime"],
      liveMutationsEnabled: false,
      operatorTokenHash: null,
    };
    const handler = createRequestHandler(pipeline, coordinator, runtime);
    server = createServer(handler);

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  it("GET /health returns health metrics", async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { service: string; status: string };
    };
    expect(body.data.service).toBe("bidsentinel-api");
    expect(body.data.status).toBe("ok");
  });

  it("GET /api/runtime explicitly labels deterministic mock mode", async () => {
    const res = await fetch(`${baseUrl}/api/runtime`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { mode: string; collectorConfigured: boolean };
    };
    expect(body.data).toMatchObject({
      mode: "mock",
      collectorConfigured: false,
    });
  });

  it("GET /api/tenders returns empty list initially (before seeder/dev collect)", async () => {
    const res = await fetch(`${baseUrl}/api/tenders`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: unknown[];
      pagination: { total: number };
    };
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it("POST /api/dev/collect?mode=valid executes a collection cycle", async () => {
    const res = await fetch(`${baseUrl}/api/dev/collect?mode=valid`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; outcome: string };
    expect(body.success).toBe(true);
    expect(body.outcome).toBe("accepted");

    // Fetch tenders list again
    const listRes = await fetch(`${baseUrl}/api/tenders`);
    const listBody = (await listRes.json()) as {
      data: Array<{ tenderId: string }>;
    };
    expect(listBody.data).toHaveLength(1);
    expect(listBody.data[0]?.tenderId).toBe("gem:2026-rail-signalling-001");
  });

  it("GET /api/tenders/{tenderId} returns tender details", async () => {
    const tenderId = encodeURIComponent("gem:2026-rail-signalling-001");
    const res = await fetch(`${baseUrl}/api/tenders/${tenderId}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tenderId: string } };
    expect(body.data.tenderId).toBe("gem:2026-rail-signalling-001");
  });

  it("GET /api/tenders/{tenderId} returns 404 for missing tender", async () => {
    const res = await fetch(`${baseUrl}/api/tenders/gem%3Amissing-id`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("POST /api/dev/collect?mode=drift quarantines invalid row and triggers healing", async () => {
    const res = await fetch(`${baseUrl}/api/dev/collect?mode=drift`, {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(body.outcome).toBe("quarantined");

    // Check quarantines list
    const qRes = await fetch(`${baseUrl}/api/quarantines`);
    const qBody = (await qRes.json()) as { data: unknown[] };
    expect(qBody.data).toHaveLength(1);

    // Verify source health transitioned to recovering
    const sRes = await fetch(`${baseUrl}/api/sources`);
    const sBody = (await sRes.json()) as { data: Array<{ state: string }> };
    expect(sBody.data[0]?.state).toBe("recovering");
  });

  it("POST /api/dev/heal-progress and POST /api/dev/approve recovery", async () => {
    // The deterministic mock makes a preview available on the first poll.
    let res = await fetch(`${baseUrl}/api/dev/heal-progress`, {
      method: "POST",
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending_answer");

    // Approval is forbidden until the Bright Data preview passes the Tender schema canary.
    res = await fetch(`${baseUrl}/api/dev/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    expect(res.status).toBe(409);

    res = await fetch(`${baseUrl}/api/dev/validate-preview`, {
      method: "POST",
    });
    const previewBody = (await res.json()) as { healingState: string };
    expect(previewBody.healingState).toBe("preview_valid");

    res = await fetch(`${baseUrl}/api/dev/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    const approveBody = (await res.json()) as { healingState: string };
    expect(approveBody.healingState).toBe("recovered");

    const healingRes = await fetch(`${baseUrl}/api/healing/gem`);
    const healingBody = (await healingRes.json()) as {
      data: { state: string; incident: { collectorId: string } };
    };
    expect(healingBody.data.state).toBe("recovered");
    expect(healingBody.data.incident.collectorId).toBe("c_mock_dev");

    // Check health state is back to healthy
    const sRes = await fetch(`${baseUrl}/api/sources`);
    const sBody = (await sRes.json()) as { data: Array<{ state: string }> };
    expect(sBody.data[0]?.state).toBe("healthy");
  });
});

describe("BidSentinel live mutation authorization", () => {
  const liveEnv = {
    BRIGHT_DATA_API_TOKEN: "bright-data-token",
    BRIGHT_DATA_COLLECTOR_ID: "c_exact",
    BRIGHT_DATA_TARGET_URL: "https://example.gov.test/tenders",
    BIDSENTINEL_SOURCE_ID: "gem",
  };

  it("fails closed before a provider call when live mutations are disabled", async () => {
    const runtime = createRuntimeFromEnv(liveEnv);
    const collect = vi.fn(async () => ({
      sourceId: "gem",
      collectorId: "c_exact",
      extractorVersion: "parser-v2",
      receivedAt: validTenderFixture.observedAt,
      payloads: [validTenderFixture],
    }));
    runtime.collectionProvider = { collect };
    const { server, baseUrl } = await startRuntimeServer(runtime);

    try {
      const response = await fetch(`${baseUrl}/api/dev/collect?mode=live`, {
        method: "POST",
      });
      expect(response.status).toBe(403);
      expect(collect).not.toHaveBeenCalled();
    } finally {
      await stopRuntimeServer(server);
    }
  });

  it("rejects the wrong operator token and accepts the configured token", async () => {
    const operatorToken = "operator-token-with-at-least-32-chars";
    const runtime = createRuntimeFromEnv({
      ...liveEnv,
      BIDSENTINEL_ENABLE_LIVE_MUTATIONS: "true",
      BIDSENTINEL_OPERATOR_TOKEN: operatorToken,
    });
    const collect = vi.fn(async () => ({
      sourceId: "gem",
      collectorId: "c_exact",
      extractorVersion: "parser-v2",
      receivedAt: validTenderFixture.observedAt,
      payloads: [validTenderFixture],
    }));
    runtime.collectionProvider = { collect };
    const { server, baseUrl } = await startRuntimeServer(runtime);

    try {
      const denied = await fetch(`${baseUrl}/api/dev/collect?mode=live`, {
        method: "POST",
        headers: { "X-BidSentinel-Operator-Token": "wrong-token" },
      });
      expect(denied.status).toBe(403);
      expect(collect).not.toHaveBeenCalled();

      const allowed = await fetch(`${baseUrl}/api/dev/collect?mode=live`, {
        method: "POST",
        headers: { "X-BidSentinel-Operator-Token": operatorToken },
      });
      expect(allowed.status).toBe(200);
      expect(collect).toHaveBeenCalledTimes(1);
    } finally {
      await stopRuntimeServer(server);
    }
  });
});
