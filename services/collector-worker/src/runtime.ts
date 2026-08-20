import { createHash, timingSafeEqual } from "node:crypto";

import {
  BrightDataApiError,
  BrightDataCollectionProvider,
  BrightDataHealingProvider,
  MockBrightDataHealingProvider,
  type TenderCollectionProvider,
} from "@bidsentinel/brightdata";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";
import { hashPayload } from "@bidsentinel/validation";

import {
  SelfHealingCoordinator,
  type RecoveryVerification,
} from "./healing-coordinator.js";
import { BidSentinelPipeline } from "./pipeline.js";

export type RuntimeMode = "live" | "mock";

export interface BidSentinelRuntime {
  mode: RuntimeMode;
  pipeline: BidSentinelPipeline;
  coordinator: SelfHealingCoordinator;
  collectionProvider: TenderCollectionProvider | null;
  sourceId: string;
  collectorId: string | null;
  targetUrl: string | null;
  configurationIssues: string[];
  liveMutationsEnabled: boolean;
  operatorTokenHash: string | null;
}

export interface CollectionRunSummary extends RecoveryVerification {
  sourceId: string;
  collectorId: string;
  outcomes: Array<"accepted" | "quarantined">;
}

export function createRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): BidSentinelRuntime {
  const apiToken = env.BRIGHT_DATA_API_TOKEN?.trim() ?? "";
  const collectorId = env.BRIGHT_DATA_COLLECTOR_ID?.trim() ?? "";
  const targetUrl = env.BRIGHT_DATA_TARGET_URL?.trim() ?? "";
  const sourceId = env.BIDSENTINEL_SOURCE_ID?.trim() || "iim-amritsar";
  const liveMutationFlag =
    env.BIDSENTINEL_ENABLE_LIVE_MUTATIONS?.trim().toLowerCase() === "true";
  const operatorToken = env.BIDSENTINEL_OPERATOR_TOKEN?.trim() ?? "";
  const hasStrongOperatorToken = operatorToken.length >= 32;
  const operatorTokenHash = hasStrongOperatorToken
    ? createHash("sha256").update(operatorToken).digest("hex")
    : null;
  const missing = [
    ["BRIGHT_DATA_API_TOKEN", apiToken],
    ["BRIGHT_DATA_COLLECTOR_ID", collectorId],
    ["BRIGHT_DATA_TARGET_URL", targetUrl],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => `${name} is not configured`);

  const pipeline = new BidSentinelPipeline();
  if (missing.length > 0) {
    const mockHealing = new MockBrightDataHealingProvider([
      { ...validTenderFixture, sourceId },
    ]);
    const coordinator = new SelfHealingCoordinator(mockHealing, {
      pollIntervalMs: 0,
    });
    pipeline.healingCoordinator = coordinator;
    return {
      mode: "mock",
      pipeline,
      coordinator,
      collectionProvider: null,
      sourceId,
      collectorId: null,
      targetUrl: null,
      configurationIssues: missing,
      liveMutationsEnabled: false,
      operatorTokenHash: null,
    };
  }

  const collectionProvider = new BrightDataCollectionProvider({
    apiToken,
    collectorId,
  });
  const healingProvider = new BrightDataHealingProvider({ apiToken });
  const coordinator = new SelfHealingCoordinator(healingProvider);
  pipeline.healingCoordinator = coordinator;
  return {
    mode: "live",
    pipeline,
    coordinator,
    collectionProvider,
    sourceId,
    collectorId,
    targetUrl,
    configurationIssues: [
      ...(!liveMutationFlag
        ? ["BIDSENTINEL_ENABLE_LIVE_MUTATIONS is not true"]
        : []),
      ...(!hasStrongOperatorToken
        ? ["BIDSENTINEL_OPERATOR_TOKEN must contain at least 32 characters"]
        : []),
    ],
    liveMutationsEnabled: liveMutationFlag && hasStrongOperatorToken,
    operatorTokenHash,
  };
}

export function isAuthorizedOperatorToken(
  runtime: BidSentinelRuntime,
  suppliedToken: string | undefined,
): boolean {
  if (!runtime.liveMutationsEnabled || !runtime.operatorTokenHash) return false;
  if (!suppliedToken) return false;
  const suppliedHash = createHash("sha256").update(suppliedToken).digest();
  const expectedHash = Buffer.from(runtime.operatorTokenHash, "hex");
  return timingSafeEqual(expectedHash, suppliedHash);
}

export async function runConfiguredCollection(
  runtime: BidSentinelRuntime,
  options: { enableHealing?: boolean } = {},
): Promise<CollectionRunSummary> {
  if (
    runtime.mode !== "live" ||
    !runtime.collectionProvider ||
    !runtime.collectorId ||
    !runtime.targetUrl
  ) {
    throw new Error(
      "Live Bright Data collection is not configured; runtime is explicitly in mock mode",
    );
  }

  const observedAt = new Date().toISOString();
  let batch;
  try {
    batch = await runtime.collectionProvider.collect({
      sourceId: runtime.sourceId,
      targetUrl: runtime.targetUrl,
      requestedAt: observedAt,
    });
  } catch (error) {
    const reason =
      error instanceof BrightDataApiError && error.code === "rate_limited"
        ? "rate-limited"
        : error instanceof BrightDataApiError &&
            ["network", "timeout", "api_error"].includes(error.code)
          ? "network-error"
          : "unknown";
    const detail =
      error instanceof Error
        ? error.message
        : "Bright Data collection failed without a structured error";
    runtime.pipeline.recordCollectionFailure(
      runtime.sourceId,
      observedAt,
      reason,
      detail,
    );
    throw error;
  }

  if (batch.collectorId !== runtime.collectorId) {
    throw new Error(
      "Bright Data collection returned an unexpected collector ID; refusing to process the batch",
    );
  }

  const results = await runtime.pipeline.processBatchWithHealing(
    batch.payloads,
    {
      sourceId: batch.sourceId,
      collectorId: batch.collectorId,
      extractorVersion: batch.extractorVersion,
      observedAt: batch.receivedAt,
    },
    1,
    options.enableHealing ?? true,
  );
  const accepted = results.filter((result) => result.outcome === "accepted");
  const quarantinedCount = results.length - accepted.length;
  return {
    sourceId: batch.sourceId,
    collectorId: batch.collectorId,
    outcomes: results.map((result) => result.outcome),
    success: accepted.length > 0 && quarantinedCount === 0,
    validTenderCount: accepted.length,
    quarantinedCount,
    sampleTenderIds: accepted
      .map((result) =>
        result.outcome === "accepted" ? result.tender.tenderId : "",
      )
      .filter(Boolean)
      .slice(0, 20),
    payloadHashes: accepted
      .map((result) =>
        result.outcome === "accepted" ? hashPayload(result.tender) : "",
      )
      .filter(Boolean)
      .slice(0, 20),
  };
}
