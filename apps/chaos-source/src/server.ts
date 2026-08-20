import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  buildTenderForMode,
  chaosModes,
  fixtureEnvelope,
  isChaosMode,
  type AvailableChaosMode,
  type ChaosMode,
} from "./fixtures.js";

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "x-robots-tag": "noindex, nofollow",
} as const;

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body, null, 2));
}

function sendHtml(
  response: ServerResponse,
  statusCode: number,
  body: string,
): void {
  response.writeHead(statusCode, {
    ...securityHeaders,
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDeadline(value: string | null): string {
  if (value === null) return "Not published";
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Kolkata",
  }).format(new Date(value));
}

function documentShell(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color: #17221d; background: #f5f6f2; font-family: Inter, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; }
      main { width: min(1040px, calc(100% - 32px)); margin: 0 auto; padding: 48px 0 72px; }
      header { margin-bottom: 34px; border-bottom: 1px solid #ccd5ce; padding-bottom: 24px; }
      h1 { margin: 0 0 10px; font-size: clamp(2rem, 5vw, 3.5rem); letter-spacing: -.045em; }
      h2, h3, p { margin-top: 0; }
      .eyebrow { color: #276445; font-size: .75rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
      .muted { color: #5a6860; }
      table { width: 100%; border-collapse: collapse; background: #fff; }
      th, td { border: 1px solid #c7d1c9; padding: 16px; text-align: left; vertical-align: top; }
      th { width: 18%; color: #4d5f54; background: #edf2ed; }
      .tender-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
      .notice-card { border: 1px solid #c7d1c9; border-radius: 16px; padding: 24px; background: #fff; box-shadow: 0 14px 38px rgb(23 34 29 / 7%); }
      .notice-card .deadline { margin-top: 22px; border-top: 1px solid #d9dfda; padding-top: 18px; }
      .corrigendum { margin-top: 18px; border-left: 4px solid #bd6b00; padding: 14px 16px; background: #fff3df; }
      .control-list { display: grid; gap: 10px; max-width: 520px; }
      button { width: 100%; border: 1px solid #1d6240; border-radius: 9px; padding: 12px 16px; color: #fff; background: #1d6240; font: inherit; font-weight: 750; cursor: pointer; text-align: left; }
      code { border-radius: 5px; padding: 2px 6px; background: #e7ebe7; }
      @media (max-width: 680px) { .tender-grid { grid-template-columns: 1fr; } th, td { display: block; width: 100%; } }
    </style>
  </head>
  <body>${content}</body>
</html>`;
}

function renderTenderPage(mode: AvailableChaosMode): string {
  const tender = buildTenderForMode(mode);
  const title = escapeHtml(tender.title);
  const buyer = escapeHtml(tender.buyer.name);
  const externalId = escapeHtml(tender.externalId);
  const deadline = escapeHtml(formatDeadline(tender.submissionDeadline));
  const description = escapeHtml(
    tender.description ?? "Description unavailable",
  );
  const commonHeader = `<header>
      <p class="eyebrow">Institute procurement portal</p>
      <h1>Current tenders</h1>
      <p class="muted">Public notices and corrigenda. Tender reference ${externalId}.</p>
    </header>`;

  if (mode === "baseline-table") {
    return documentShell(
      "Current tenders",
      `<main data-layout="table">${commonHeader}
      <table aria-label="Current tender notices">
        <tbody>
          <tr><th scope="row">Reference</th><td>${externalId}</td></tr>
          <tr><th scope="row">Tender</th><td><h2>${title}</h2><p>${description}</p></td></tr>
          <tr><th scope="row">Buyer</th><td>${buyer}</td></tr>
          <tr><th scope="row">Status</th><td>${escapeHtml(tender.status)}</td></tr>
          <tr><th scope="row">Submission deadline</th><td><time datetime="${escapeHtml(tender.submissionDeadline ?? "")}">${deadline}</time></td></tr>
          <tr><th scope="row">Corrigenda</th><td>None published</td></tr>
        </tbody>
      </table>
    </main>`,
    );
  }

  const corrigendum = tender.corrigenda[0];
  const amendmentMarkup = corrigendum
    ? `<aside class="corrigendum" aria-label="Latest corrigendum">
        <strong>${escapeHtml(corrigendum.title)}</strong>
        <p>${escapeHtml(corrigendum.description ?? "No description supplied")}</p>
      </aside>`
    : "";

  return documentShell(
    "Current tenders",
    `<main data-layout="cards">${commonHeader}
      <section class="tender-grid" aria-label="Current tender notices">
        <article class="notice-card">
          <p class="eyebrow">${externalId}</p>
          <h2>${title}</h2>
          <p>${description}</p>
          <p><strong>Buyer:</strong> ${buyer}</p>
          <p><strong>Status:</strong> ${escapeHtml(tender.status)}</p>
          <div class="deadline">
            <p class="eyebrow">Submission deadline</p>
            <time datetime="${escapeHtml(tender.submissionDeadline ?? "")}">${deadline}</time>
          </div>
          ${amendmentMarkup}
        </article>
      </section>
    </main>`,
  );
}

function renderUnavailablePage(): string {
  return documentShell(
    "Tender portal temporarily unavailable",
    `<main><header>
      <p class="eyebrow">Service notice</p>
      <h1>Temporarily unavailable</h1>
      <p class="muted">The tender portal could not serve this request. Please retry later.</p>
    </header></main>`,
  );
}

function renderControlPage(mode: ChaosMode): string {
  const controls = chaosModes
    .map(
      (candidate) => `<form method="post" action="/__control">
        <input type="hidden" name="mode" value="${candidate}">
        <button type="submit"${candidate === mode ? ' aria-current="true"' : ""}>${candidate}${candidate === mode ? " — current" : ""}</button>
      </form>`,
    )
    .join("\n");
  return documentShell(
    "Chaos source controls",
    `<main><header>
      <p class="eyebrow">Development controls</p>
      <h1>Source layout state</h1>
      <p class="muted">The public scraper target remains <code>/tenders</code>. This route is for local demonstrations only.</p>
    </header><div class="control-list">${controls}</div></main>`,
  );
}

async function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 10_000) reject(new Error("Request body too large"));
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

async function requestedControlMode(request: IncomingMessage): Promise<string> {
  const body = await readBody(request);
  if ((request.headers["content-type"] ?? "").includes("application/json")) {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null && "mode" in parsed
      ? String((parsed as { mode: unknown }).mode)
      : "";
  }
  return new URLSearchParams(body).get("mode") ?? "";
}

function sendMethodNotAllowed(
  response: ServerResponse,
  allowedMethods: readonly string[],
): void {
  response.writeHead(405, {
    ...securityHeaders,
    allow: allowedMethods.join(", "),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify({ error: "method_not_allowed" }, null, 2));
}

export function createChaosServer(initialMode: ChaosMode = "baseline-table") {
  let mode = initialMode;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          service: "chaos-source",
          mode,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/tenders") {
        if (mode === "unavailable") {
          sendHtml(response, 503, renderUnavailablePage());
          return;
        }
        sendHtml(response, 200, renderTenderPage(mode));
        return;
      }

      if (
        request.method === "GET" &&
        (url.pathname === "/fixtures/tenders" ||
          url.pathname === "/tenders.json")
      ) {
        const requestedMode = url.searchParams.get("mode") ?? mode;
        if (!isChaosMode(requestedMode)) {
          sendJson(response, 400, {
            error: "unsupported_mode",
            supportedModes: chaosModes,
          });
          return;
        }
        if (requestedMode === "unavailable") {
          sendJson(response, 503, {
            error: "source_unavailable",
            mode: requestedMode,
          });
          return;
        }
        sendJson(response, 200, fixtureEnvelope(requestedMode));
        return;
      }

      if (request.method === "GET" && url.pathname === "/__control") {
        sendHtml(response, 200, renderControlPage(mode));
        return;
      }

      if (request.method === "POST" && url.pathname === "/__control") {
        const nextMode = await requestedControlMode(request);
        if (!isChaosMode(nextMode)) {
          sendJson(response, 400, {
            error: "unsupported_mode",
            supportedModes: chaosModes,
          });
          return;
        }
        mode = nextMode;
        if ((request.headers.accept ?? "").includes("application/json")) {
          sendJson(response, 200, { mode, publicTarget: "/tenders" });
          return;
        }
        response.writeHead(303, {
          ...securityHeaders,
          location: "/__control",
        });
        response.end();
        return;
      }

      if (url.pathname === "/__control") {
        sendMethodNotAllowed(response, ["GET", "POST"]);
        return;
      }

      if (
        url.pathname === "/health" ||
        url.pathname === "/tenders" ||
        url.pathname === "/fixtures/tenders" ||
        url.pathname === "/tenders.json"
      ) {
        sendMethodNotAllowed(response, ["GET"]);
        return;
      }

      sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      sendJson(response, 400, {
        error: "invalid_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  const parsedPort = Number.parseInt(process.env.PORT ?? "4311", 10);
  const port = Number.isFinite(parsedPort) ? parsedPort : 4311;
  const host = process.env.HOST?.trim() || "127.0.0.1";
  const server = createChaosServer();

  server.listen(port, host, () => {
    console.log(`BidSentinel chaos source listening on http://${host}:${port}`);
  });
}
