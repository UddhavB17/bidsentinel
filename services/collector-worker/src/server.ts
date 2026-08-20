import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { ZodTypeAny } from "zod";
import {
  ApiHealthResponseSchema,
  TenderListResponseSchema,
  TenderDetailResponseSchema,
  ChangeEventListResponseSchema,
  SourceHealthListResponseSchema,
  QuarantineListResponseSchema,
} from "@bidsentinel/contracts";
import { validTenderFixture, tenderWithCorrigendumFixture } from "@bidsentinel/contracts/fixtures";
import { MockBrightDataHealingProvider } from "@bidsentinel/brightdata";
import { BidSentinelPipeline } from "./pipeline.js";
import { SelfHealingCoordinator } from "./healing-coordinator.js";

const pipeline = new BidSentinelPipeline();
const healingProvider = new MockBrightDataHealingProvider();
const coordinator = new SelfHealingCoordinator(healingProvider);
pipeline.healingCoordinator = coordinator;

// Seed initial healthy tender
pipeline.process(validTenderFixture, {
  sourceId: "gem",
  extractorVersion: "initial-seeder",
  observedAt: "2026-08-20T05:00:00.000Z",
});

// Custom HTTP Errors
class HttpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details: unknown[] = []
  ) {
    super(message);
    this.name = "HttpError";
  }
}

class BadRequestError extends HttpError {
  constructor(message: string) {
    super("invalid_request", 400, message);
  }
}

class NotFoundError extends HttpError {
  constructor(message: string) {
    super("not_found", 404, message);
  }
}

class MethodNotAllowedError extends HttpError {
  constructor(message: string) {
    super("method_not_allowed", 405, message);
  }
}

export function createRequestHandler(
  pipelineInstance: BidSentinelPipeline,
  coordinatorInstance: SelfHealingCoordinator
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const generatedAt = new Date().toISOString();
    const requestId = `req-${randomUUID().replace(/-/g, "").substring(0, 15)}`;

    // Set CORS headers
    const origin = req.headers.origin;
    const allowedOrigins = [
      "http://localhost:4173",
      "http://127.0.0.1:4173",
      "http://localhost:3000",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ];
    if (origin && allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    } else if (!origin) {
      // Default fallback for client requests lacking origin header in local development
      res.setHeader("Access-Control-Allow-Origin", "*");
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const sendJson = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body, null, 2));
    };

    const sendError = (error: HttpError) => {
      sendJson(error.status, {
        error: {
          code: error.code,
          status: error.status,
          message: error.message,
          requestId,
          details: error.details,
        },
        generatedAt,
      });
    };

    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host || "localhost"}`);
      const path = url.pathname;

      // 1. GET /health
      if (path === "/health") {
        if (req.method !== "GET") throw new MethodNotAllowedError("Method not allowed");
        const body = ApiHealthResponseSchema.parse({
          data: {
            schemaVersion: 1,
            service: "bidsentinel-api",
            status: "ok",
          },
          generatedAt,
        });
        sendJson(200, body);
        return;
      }

      // 2. GET /api/tenders
      if (path === "/api/tenders") {
        if (req.method !== "GET") throw new MethodNotAllowedError("Method not allowed");

        const tenderIds = pipelineInstance.snapshots.listUniqueTenderIds();
        const tenders = tenderIds.map((tid: string) => {
          const snaps = pipelineInstance.snapshots.list(tid);
          const latest = snaps[snaps.length - 1];
          if (!latest) throw new Error("Snapshot not found");
          return {
            schemaVersion: 1,
            tenderId: latest.tenderId,
            sourceId: latest.sourceId,
            externalId: latest.tender.externalId,
            title: latest.tender.title,
            buyer: latest.tender.buyer,
            status: latest.tender.status,
            publishedAt: latest.tender.publishedAt,
            submissionDeadline: latest.tender.submissionDeadline,
            url: latest.tender.url,
            estimatedValue: latest.tender.estimatedValue,
            observedAt: latest.observedAt,
            latestSnapshot: {
              snapshotId: latest.snapshotId,
              version: latest.version,
            },
            documentCount: latest.tender.documents.length,
            corrigendumCount: latest.tender.corrigenda.length,
          };
        });

        // Sort: observedAt desc, then tenderId asc
        tenders.sort((a: { observedAt: string; tenderId: string }, b: { observedAt: string; tenderId: string }) => {
          const timeA = Date.parse(a.observedAt);
          const timeB = Date.parse(b.observedAt);
          if (timeA !== timeB) return timeB - timeA;
          return a.tenderId.localeCompare(b.tenderId);
        });

        const paginated = paginate(tenders, url, TenderListResponseSchema, generatedAt);
        sendJson(200, paginated);
        return;
      }

      // 3. GET /api/tenders/{tenderId}
      if (path.startsWith("/api/tenders/")) {
        if (req.method !== "GET") throw new MethodNotAllowedError("Method not allowed");
        const encodedTenderId = path.substring("/api/tenders/".length);
        const tenderId = decodeURIComponent(encodedTenderId);

        const snaps = pipelineInstance.snapshots.list(tenderId);
        const latest = snaps[snaps.length - 1];
        if (!latest) {
          throw new NotFoundError(`Tender ${tenderId} was not found`);
        }

        const body = TenderDetailResponseSchema.parse({
          data: {
            ...latest.tender,
            latestSnapshot: {
              snapshotId: latest.snapshotId,
              version: latest.version,
              payloadHash: latest.payloadHash,
            },
          },
          generatedAt,
        });
        sendJson(200, body);
        return;
      }

      // 4. GET /api/changes
      if (path === "/api/changes") {
        if (req.method !== "GET") throw new MethodNotAllowedError("Method not allowed");
        const changes = pipelineInstance.changeEvents.list();

        // Sort: detectedAt desc, then changeEventId asc
        changes.sort((a, b) => {
          const timeA = Date.parse(a.detectedAt);
          const timeB = Date.parse(b.detectedAt);
          if (timeA !== timeB) return timeB - timeA;
          return a.changeEventId.localeCompare(b.changeEventId);
        });

        const paginated = paginate(changes, url, ChangeEventListResponseSchema, generatedAt);
        sendJson(200, paginated);
        return;
      }

      // 5. GET /api/sources
      if (path === "/api/sources") {
        if (req.method !== "GET") throw new MethodNotAllowedError("Method not allowed");

        const sourceIds = pipelineInstance.sourceHealth.listSourceIds();
        const sources = sourceIds.map((sid: string) => {
          const rawHealth = pipelineInstance.sourceHealth.get(sid);
          if (!rawHealth) throw new Error("Health record not found");

          const healingState = coordinatorInstance.getHealingState(sid);
          let state = rawHealth.state;
          const recoveringStates = ["healing_requested", "awaiting_approval", "preview_valid", "preview_invalid", "approved", "rejected"];
          if (recoveringStates.includes(healingState)) {
            state = "recovering";
          } else if (healingState === "recovered") {
            state = "healthy";
          } else if (healingState === "recovery_failed") {
            state = "quarantined";
          }

          const incident = coordinatorInstance.getIncident(sid);
          const latestRecoveryEvidence = incident?.evidence ?? rawHealth.latestRecoveryEvidence;

          return {
            ...rawHealth,
            state,
            latestRecoveryEvidence,
          };
        });

        // Sort: sourceId asc
        sources.sort((a: { sourceId: string }, b: { sourceId: string }) => a.sourceId.localeCompare(b.sourceId));

        const paginated = paginate(sources, url, SourceHealthListResponseSchema, generatedAt);
        sendJson(200, paginated);
        return;
      }

      // 6. GET /api/quarantines
      if (path === "/api/quarantines") {
        if (req.method !== "GET") throw new MethodNotAllowedError("Method not allowed");
        const quarantines = pipelineInstance.quarantines.list();

        // Sort: observedAt desc, then quarantineId asc
        quarantines.sort((a: { observedAt: string; quarantineId: string }, b: { observedAt: string; quarantineId: string }) => {
          const timeA = Date.parse(a.observedAt);
          const timeB = Date.parse(b.observedAt);
          if (timeA !== timeB) return timeB - timeA;
          return a.quarantineId.localeCompare(b.quarantineId);
        });

        const paginated = paginate(quarantines, url, QuarantineListResponseSchema, generatedAt);
        sendJson(200, paginated);
        return;
      }

      // 7. POST /api/dev/collect
      if (path === "/api/dev/collect") {
        if (req.method !== "POST") throw new MethodNotAllowedError("Method not allowed");

        const mode = url.searchParams.get("mode") ?? "valid";
        let payload: unknown;
        if (mode === "valid") {
          payload = validTenderFixture;
        } else if (mode === "drift") {
          payload = {
            tenderId: "gem:2026-rail-signalling-001",
            externalId: "2026-rail-signalling-001",
            url: "https://example.gov.test/tenders/001",
            observedAt: new Date().toISOString(),
          };
        } else if (mode === "amended") {
          payload = tenderWithCorrigendumFixture;
        } else {
          throw new BadRequestError(`Unsupported collect mode: ${mode}`);
        }

        const context = {
          sourceId: "gem",
          extractorVersion: "dev-collector",
          observedAt: new Date().toISOString(),
        };

        const result = pipelineInstance.process(payload, context);
        sendJson(200, { success: true, mode, outcome: result.outcome });
        return;
      }

      // 8. POST /api/dev/heal-progress
      if (path === "/api/dev/heal-progress") {
        if (req.method !== "POST") throw new MethodNotAllowedError("Method not allowed");
        const status = await coordinatorInstance.pollProgress("gem", new Date().toISOString());
        sendJson(200, { success: true, status, healingState: coordinatorInstance.getHealingState("gem") });
        return;
      }

      // 9. POST /api/dev/approve
      if (path === "/api/dev/approve") {
        if (req.method !== "POST") throw new MethodNotAllowedError("Method not allowed");

        const bodyText = await readBodyText(req);
        let approve = true;
        try {
          const body = JSON.parse(bodyText) as Record<string, unknown>;
          if (body && typeof body === "object" && "approve" in body) {
            approve = !!body.approve;
          }
        } catch {
          // Default to true
        }

        const rerunFn = async () => {
          pipelineInstance.process(validTenderFixture, {
            sourceId: "gem",
            extractorVersion: "dev-collector",
            observedAt: new Date().toISOString(),
          });
          return true;
        };

        await coordinatorInstance.approveOrReject("gem", approve, rerunFn, new Date().toISOString());
        sendJson(200, { success: true, healingState: coordinatorInstance.getHealingState("gem") });
        return;
      }

      throw new NotFoundError(`Route ${path} not found`);
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(err);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        sendJson(500, {
          error: {
            code: "internal_error",
            status: 500,
            message: msg,
            requestId,
            details: [],
          },
          generatedAt,
        });
      }
    }
  };
}

function paginate(items: unknown[], url: URL, responseSchema: ZodTypeAny, generatedAt: string): unknown {
  const limitParam = url.searchParams.get("limit") ?? "50";
  const offsetParam = url.searchParams.get("offset") ?? "0";

  const limit = parseInt(limitParam, 10);
  const offset = parseInt(offsetParam, 10);

  if (isNaN(limit) || limit < 1 || limit > 100 || isNaN(offset) || offset < 0) {
    throw new BadRequestError("Invalid pagination parameters");
  }

  for (const key of url.searchParams.keys()) {
    if (key !== "limit" && key !== "offset") {
      throw new BadRequestError(`Unknown query parameter: ${key}`);
    }
  }

  const paginatedItems = items.slice(offset, offset + limit);
  const total = items.length;
  const hasMore = offset + paginatedItems.length < total;

  const body = {
    data: paginatedItems,
    pagination: {
      limit,
      offset,
      total,
      hasMore,
    },
    generatedAt,
  };

  return responseSchema.parse(body);
}

async function readBodyText(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
    });
    req.on("end", () => {
      resolve(body);
    });
    req.on("error", (err) => {
      reject(err);
    });
  });
}

if (process.env.NODE_ENV !== "test") {
  const parsedPort = Number.parseInt(process.env.PORT ?? "4321", 10);
  const port = Number.isFinite(parsedPort) ? parsedPort : 4321;
  const server = createServer(createRequestHandler(pipeline, coordinator));

  server.listen(port, "127.0.0.1", () => {
    console.warn(`BidSentinel backend API listening on http://127.0.0.1:${port}`);
  });
}
