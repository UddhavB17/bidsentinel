import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { BidSentinelPipeline } from "./pipeline.js";
import { MockBrightDataHealingProvider } from "@bidsentinel/brightdata";
import { SelfHealingCoordinator } from "./healing-coordinator.js";
import { createRequestHandler } from "./server.js";

describe("BidSentinel API Server", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;
  let pipeline: BidSentinelPipeline;
  let coordinator: SelfHealingCoordinator;

  beforeAll(async () => {
    pipeline = new BidSentinelPipeline();
    const healingProvider = new MockBrightDataHealingProvider();
    coordinator = new SelfHealingCoordinator(healingProvider);
    pipeline.healingCoordinator = coordinator;

    const handler = createRequestHandler(pipeline, coordinator);
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
    const body = (await res.json()) as { data: { service: string; status: string } };
    expect(body.data.service).toBe("bidsentinel-api");
    expect(body.data.status).toBe("ok");
  });

  it("GET /api/tenders returns empty list initially (before seeder/dev collect)", async () => {
    const res = await fetch(`${baseUrl}/api/tenders`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; pagination: { total: number } };
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
  });

  it("POST /api/dev/collect?mode=valid executes a collection cycle", async () => {
    const res = await fetch(`${baseUrl}/api/dev/collect?mode=valid`, { method: "POST" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; outcome: string };
    expect(body.success).toBe(true);
    expect(body.outcome).toBe("accepted");

    // Fetch tenders list again
    const listRes = await fetch(`${baseUrl}/api/tenders`);
    const listBody = (await listRes.json()) as { data: Array<{ tenderId: string }> };
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
    const res = await fetch(`${baseUrl}/api/dev/collect?mode=drift`, { method: "POST" });
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
    // Advance progress
    let res = await fetch(`${baseUrl}/api/dev/heal-progress`, { method: "POST" });
    let body = (await res.json()) as { status: string };
    expect(body.status).toBe("in_progress");

    res = await fetch(`${baseUrl}/api/dev/heal-progress`, { method: "POST" });
    body = (await res.json()) as { status: string };
    expect(body.status).toBe("pending_answer");

    // Simulate mock preview check and human approval
    res = await fetch(`${baseUrl}/api/dev/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approve: true }),
    });
    const approveBody = (await res.json()) as { healingState: string };
    expect(approveBody.healingState).toBe("recovered");

    // Check health state is back to healthy
    const sRes = await fetch(`${baseUrl}/api/sources`);
    const sBody = (await sRes.json()) as { data: Array<{ state: string }> };
    expect(sBody.data[0]?.state).toBe("healthy");
  });
});
