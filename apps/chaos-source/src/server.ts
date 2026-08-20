import { createServer, type ServerResponse } from "node:http";

import { buildTenderForMode, chaosModes, isChaosMode } from "./fixtures.js";

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body, null, 2));
}

export function createChaosServer() {
  return createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, { status: "ok", service: "chaos-source" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/tenders") {
      const requestedMode = url.searchParams.get("mode") ?? "valid";
      if (!isChaosMode(requestedMode)) {
        sendJson(response, 400, {
          error: "unsupported_mode",
          supportedModes: chaosModes,
        });
        return;
      }

      sendJson(response, 200, {
        sourceId: "gem",
        extractorVersion: "chaos-source-v1",
        mode: requestedMode,
        items: [buildTenderForMode(requestedMode)],
      });
      return;
    }

    sendJson(response, 404, { error: "not_found" });
  });
}

if (process.env.NODE_ENV !== "test") {
  const parsedPort = Number.parseInt(process.env.PORT ?? "4311", 10);
  const port = Number.isFinite(parsedPort) ? parsedPort : 4311;
  const server = createChaosServer();

  server.listen(port, "127.0.0.1", () => {
    console.log(
      `BidSentinel chaos source listening on http://127.0.0.1:${port}`,
    );
  });
}
