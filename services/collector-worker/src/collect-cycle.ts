import { mapRawRowToTender } from "@bidsentinel/brightdata";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";

import { createRuntimeFromEnv, runConfiguredCollection } from "./runtime.js";

async function main() {
  const runtime = createRuntimeFromEnv();
  if (runtime.mode === "live") {
    const summary = await runConfiguredCollection(runtime);
    console.log(JSON.stringify({ mode: "live", ...summary }, null, 2));
    return;
  }

  const receivedAt = new Date().toISOString();
  const rawRows = [
    {
      ...validTenderFixture,
      sourceId: runtime.sourceId,
      observedAt: receivedAt,
    },
    {
      id: "2026-invalid-tender-002",
      status: "open",
      url: "https://example.gov.test/tenders/invalid-002",
    },
    {
      ...validTenderFixture,
      tenderId: `${runtime.sourceId}:2026-invalid-tender-003`,
      sourceId: runtime.sourceId,
      externalId: "2026-invalid-tender-003",
      submissionDeadline: "invalid-date-format",
      observedAt: receivedAt,
    },
  ];
  const payloads = rawRows.map((row) =>
    mapRawRowToTender(row, runtime.sourceId, receivedAt),
  );
  const results = await runtime.pipeline.processBatchWithHealing(
    payloads,
    {
      sourceId: runtime.sourceId,
      extractorVersion: "mock-collector",
      observedAt: receivedAt,
    },
    1,
    false,
  );

  console.log(
    JSON.stringify(
      {
        mode: "mock",
        configurationIssues: runtime.configurationIssues,
        outcomes: results.map((result) => result.outcome),
        quarantinedExtractions: runtime.pipeline.quarantines.listBySource(
          runtime.sourceId,
        ).length,
        sourceState: runtime.pipeline.sourceHealth.get(runtime.sourceId)?.state,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[BidSentinel] Collection cycle failed: ${message}`);
  process.exitCode = 1;
});
