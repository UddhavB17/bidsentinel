import type { Tender } from "@bidsentinel/contracts";

/**
 * Provider-neutral boundary for a future public-web collection adapter.
 * The MVP intentionally ships without credentials or network behavior.
 */
export interface TenderCollectionRequest {
  sourceId: string;
  targetUrl: string;
  requestedAt: string;
}

export interface TenderCollectionBatch {
  sourceId: string;
  extractorVersion: string;
  receivedAt: string;
  payloads: unknown[];
}

export interface TenderCollectionProvider {
  collect(request: TenderCollectionRequest): Promise<TenderCollectionBatch>;
}

export interface CanonicalTenderSink {
  accept(tender: Tender): Promise<void>;
}

export class ExternalCollectionNotConfiguredError extends Error {
  constructor() {
    super("External collection is intentionally not configured in this MVP");
    this.name = "ExternalCollectionNotConfiguredError";
  }
}

export class UnconfiguredBrightDataProvider implements TenderCollectionProvider {
  collect(_request: TenderCollectionRequest): Promise<TenderCollectionBatch> {
    return Promise.reject(new ExternalCollectionNotConfiguredError());
  }
}
