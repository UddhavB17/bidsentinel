import { createHash, randomUUID } from "node:crypto";

import {
  QuarantinedExtractionSchema,
  TenderSchema,
  type QuarantinedExtraction,
  type Tender,
} from "@bidsentinel/contracts";

export interface ExtractionContext {
  sourceId: string;
  extractorVersion: string;
  observedAt: string;
}

export type TenderValidationResult =
  | { ok: true; value: Tender }
  | { ok: false; quarantine: QuarantinedExtraction };

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForHash);
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeForHash(item)]),
    );
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  return value;
}

export function stableStringify(value: unknown): string {
  const serialized = JSON.stringify(normalizeForHash(value));
  return serialized ?? String(value);
}

export function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function validateTenderExtraction(
  input: unknown,
  context: ExtractionContext,
): TenderValidationResult {
  const result = TenderSchema.safeParse(input);
  const issues = result.success
    ? result.data.sourceId === context.sourceId
      ? []
      : [
          {
            code: "source_id_mismatch",
            path: ["sourceId"],
            message: `Expected sourceId ${context.sourceId}, received ${result.data.sourceId}`,
          },
        ]
    : result.error.issues.map((issue) => ({
        code: issue.code,
        path: issue.path,
        message: issue.message,
      }));

  if (result.success && issues.length === 0) {
    return { ok: true, value: result.data };
  }

  const quarantine = QuarantinedExtractionSchema.parse({
    schemaVersion: 1,
    quarantineId: randomUUID(),
    sourceId: context.sourceId,
    extractorVersion: context.extractorVersion,
    observedAt: context.observedAt,
    payloadHash: hashPayload(input),
    rawPayload: input,
    issues,
  });

  return { ok: false, quarantine };
}
