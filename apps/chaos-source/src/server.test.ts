import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createChaosServer } from "./server.js";

const openServers: ReturnType<typeof createChaosServer>[] = [];

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

async function startServer() {
  const server = createChaosServer();
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function setMode(baseUrl: string, mode: string): Promise<Response> {
  return fetch(`${baseUrl}/__control`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ mode }),
  });
}

describe("chaos source HTTP server", () => {
  it("keeps /tenders stable while the control route changes its layout", async () => {
    const baseUrl = await startServer();
    const baseline = await fetch(`${baseUrl}/tenders`);
    expect(baseline.status).toBe(200);
    expect(baseline.headers.get("content-type")).toContain("text/html");
    expect(await baseline.text()).toContain('data-layout="table"');

    const control = await setMode(baseUrl, "layout-cards");
    expect(control.status).toBe(200);
    expect(await control.json()).toEqual({
      mode: "layout-cards",
      publicTarget: "/tenders",
    });

    const cards = await fetch(`${baseUrl}/tenders`);
    expect(await cards.text()).toContain('data-layout="cards"');
  });

  it("preserves deterministic JSON separately from the public HTML", async () => {
    const baseUrl = await startServer();
    const response = await fetch(
      `${baseUrl}/fixtures/tenders?mode=layout-cards`,
    );
    const body = (await response.json()) as {
      mode: string;
      items: Array<{ submissionDeadline: string; corrigenda: unknown[] }>;
    };

    expect(response.status).toBe(200);
    expect(body.mode).toBe("layout-cards");
    expect(body.items[0]?.corrigenda).toHaveLength(0);

    await setMode(baseUrl, "amended");
    const sameFixture = await fetch(
      `${baseUrl}/fixtures/tenders?mode=layout-cards`,
    );
    expect(await sameFixture.json()).toEqual(body);
  });

  it("returns a deterministic 503 without changing the public URL", async () => {
    const baseUrl = await startServer();
    await setMode(baseUrl, "unavailable");

    const response = await fetch(`${baseUrl}/tenders`);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("Temporarily unavailable");
  });

  it("rejects unsupported control modes without changing state", async () => {
    const baseUrl = await startServer();
    const response = await setMode(baseUrl, "surprise-mode");

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "unsupported_mode",
      supportedModes: [
        "baseline-table",
        "layout-cards",
        "amended",
        "unavailable",
      ],
    });

    const publicPage = await fetch(`${baseUrl}/tenders`);
    expect(await publicPage.text()).toContain('data-layout="table"');
  });

  it("renders only the intended amendment after the card-layout state", async () => {
    const baseUrl = await startServer();
    await setMode(baseUrl, "layout-cards");
    const layoutOnly = await fetch(`${baseUrl}/tenders`).then((response) =>
      response.text(),
    );

    await setMode(baseUrl, "amended");
    const amended = await fetch(`${baseUrl}/tenders`).then((response) =>
      response.text(),
    );

    expect(layoutOnly).toContain('data-layout="cards"');
    expect(layoutOnly).not.toContain("Submission deadline extension");
    expect(amended).toContain('data-layout="cards"');
    expect(amended).toContain("Submission deadline extension");
    expect(amended).toContain("22 September 2026");
  });

  it("reports the current mode through the separate control route", async () => {
    const baseUrl = await startServer();
    await setMode(baseUrl, "layout-cards");

    const response = await fetch(`${baseUrl}/__control`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("layout-cards — current");
  });

  it("applies security headers and returns 405 for unsupported methods", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/tenders`, { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
  });

  it("returns 405 for unsupported control methods and 404 for unknown routes", async () => {
    const baseUrl = await startServer();
    const unsupported = await fetch(`${baseUrl}/__control`, {
      method: "DELETE",
    });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBe("GET, POST");

    const unknown = await fetch(`${baseUrl}/missing`);
    expect(unknown.status).toBe(404);
  });
});
