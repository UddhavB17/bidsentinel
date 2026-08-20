import {
  BrightDataCollectionProvider,
  mapRawRowToTender,
} from "@bidsentinel/brightdata";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";
import { BidSentinelPipeline } from "./pipeline.js";

async function main() {
  const apiToken = process.env.BRIGHT_DATA_API_TOKEN;
  const collectorId = process.env.BRIGHT_DATA_COLLECTOR_ID;
  const targetUrl = process.env.BRIGHT_DATA_TARGET_URL || "https://example.gov.test/tenders";

  const pipeline = new BidSentinelPipeline();
  let mode: "live" | "mock" = "mock";
  let payloads: unknown[] = [];
  let extractorVersion = "mock-collector";
  let receivedAt = new Date().toISOString();

  if (apiToken && collectorId) {
    mode = "live";
    console.warn(`[BidSentinel] Running collection cycle with Bright Data collector: ${collectorId}`);
    try {
      const provider = new BrightDataCollectionProvider({
        apiToken,
        collectorId,
        pollingIntervalMs: 5000,
        timeoutMs: 120000,
      });

      const batch = await provider.collect({
        sourceId: "gem",
        targetUrl,
        requestedAt: new Date().toISOString(),
      });

      payloads = batch.payloads;
      extractorVersion = batch.extractorVersion;
      receivedAt = batch.receivedAt;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[BidSentinel] Bright Data collection failed: ${msg}`);
      process.exit(1);
    }
  } else {
    mode = "mock";
    console.warn("[BidSentinel] Bright Data credentials not configured in environment. Running in mock mode...");

    // Simulate mixed valid and invalid rows
    const rawRows = [
      // 1. Valid Tender Row
      {
        ...validTenderFixture,
        tenderId: "gem:2026-rail-signalling-001",
        externalId: "2026-rail-signalling-001",
      },
      // 2. Invalid Tender Row (missing required 'title')
      {
        id: "2026-invalid-tender-002",
        status: "open",
        url: "https://example.gov.test/tenders/invalid-002",
      },
      // 3. Invalid Tender Row (invalid deadline date string format)
      {
        ...validTenderFixture,
        tenderId: "gem:2026-invalid-tender-003",
        externalId: "2026-invalid-tender-003",
        submissionDeadline: "invalid-date-format",
      }
    ];

    payloads = rawRows.map((row) =>
      mapRawRowToTender(row, "gem", receivedAt)
    );
  }

  console.warn(`[BidSentinel] Processing ${payloads.length} payloads through the validation and change pipeline...`);

  const outcomes: string[] = [];
  for (const payload of payloads) {
    const context = {
      sourceId: "gem",
      extractorVersion,
      observedAt: receivedAt,
    };
    const result = pipeline.process(payload, context);
    outcomes.push(result.outcome);
  }

  // Print deterministic collection summary
  console.log(
    JSON.stringify(
      {
        mode,
        outcomes,
        snapshotVersions: pipeline.snapshots
          .list("gem:2026-rail-signalling-001")
          .map((snapshot) => snapshot.version),
        quarantinedExtractions: pipeline.quarantines.listBySource("gem").length,
        recoveryEvidence: pipeline.recoveryEvidence.listBySource("gem").length,
        sourceState: pipeline.sourceHealth.get("gem")?.state,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
