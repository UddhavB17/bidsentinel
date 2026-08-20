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

export interface BrightDataCollectionProviderOptions {
  apiToken?: string;
  collectorId?: string;
  pollingIntervalMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}

export class BrightDataCollectionProvider implements TenderCollectionProvider {
  private readonly apiToken: string;
  private readonly collectorId: string;
  private readonly pollingIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: BrightDataCollectionProviderOptions = {}) {
    this.apiToken = options.apiToken || process.env.BRIGHT_DATA_API_TOKEN || "";
    this.collectorId = options.collectorId || process.env.BRIGHT_DATA_COLLECTOR_ID || "";
    this.pollingIntervalMs = options.pollingIntervalMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.maxRetries = options.maxRetries ?? 3;

    if (!this.apiToken || !this.collectorId) {
      throw new Error("Bright Data API Token and Collector ID are required");
    }
  }

  async collect(request: TenderCollectionRequest): Promise<TenderCollectionBatch> {
    const triggerUrl = `https://api.brightdata.com/dca/trigger?collector=${this.collectorId}`;

    const triggerRes = await this.fetchWithRetry(
      triggerUrl,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ url: request.targetUrl }]),
      },
      this.maxRetries
    );

    if (triggerRes.status === 401 || triggerRes.status === 403) {
      throw new Error("Authentication failed with Bright Data API");
    }
    if (!triggerRes.ok) {
      throw new Error(`Failed to trigger collector: ${triggerRes.status} ${triggerRes.statusText}`);
    }

    const triggerData = (await triggerRes.json()) as Record<string, unknown>;
    const collectionId = triggerData?.collection_id as string | undefined;
    if (!collectionId) {
      throw new Error("Trigger response did not contain collection_id");
    }

    const rawRows = await this.pollDataset(collectionId);
    const receivedAt = new Date().toISOString();
    const payloads = rawRows.map((row) =>
      mapRawRowToTender(row, request.sourceId, receivedAt)
    );

    return {
      sourceId: request.sourceId,
      extractorVersion: `brightdata-${this.collectorId}`,
      receivedAt,
      payloads,
    };
  }

  private async pollDataset(collectionId: string): Promise<unknown[]> {
    const startTime = Date.now();
    const datasetUrl = `https://api.brightdata.com/dca/dataset?id=${collectionId}`;

    while (true) {
      if (Date.now() - startTime > this.timeoutMs) {
        throw new Error("Timeout waiting for Bright Data collection to complete");
      }

      const pollRes = await this.fetchWithRetry(
        datasetUrl,
        {
          method: "GET",
          headers: {
            "Authorization": `Bearer ${this.apiToken}`,
          },
        },
        this.maxRetries
      );

      if (pollRes.status === 401 || pollRes.status === 403) {
        throw new Error("Authentication failed with Bright Data API");
      }

      if (pollRes.status === 202) {
        await new Promise((resolve) => setTimeout(resolve, this.pollingIntervalMs));
        continue;
      }

      if (!pollRes.ok) {
        throw new Error(`Dataset API returned error status: ${pollRes.status}`);
      }

      const responseText = await pollRes.text();
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new Error("Malformed JSON response from Bright Data dataset API");
      }

      if (
        data !== null &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        (data as Record<string, unknown>).status === "building"
      ) {
        await new Promise((resolve) => setTimeout(resolve, this.pollingIntervalMs));
        continue;
      }

      if (Array.isArray(data)) {
        return data;
      }

      throw new Error("Malformed response from Bright Data dataset API");
    }
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number,
    initialDelayMs = 1000
  ): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        const response = await fetch(url, options);
        if (response.status >= 500 && response.status < 600 && attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }
}

export function mapRawRowToTender(
  row: unknown,
  sourceId: string,
  observedAt: string
): unknown {
  if (row === null || typeof row !== "object" || Array.isArray(row)) {
    return row;
  }

  const getField = (obj: unknown, keys: string[]): unknown => {
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) return undefined;
    const record = obj as Record<string, unknown>;
    for (const k of keys) {
      if (k in record) return record[k];
      const normalizedK = k.toLowerCase().replace(/[^a-z0-9]/g, "");
      for (const rawKey of Object.keys(record)) {
        const normalizedRawKey = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (normalizedK === normalizedRawKey) {
          return record[rawKey];
        }
      }
    }
    return undefined;
  };

  const rawExternalId = getField(row, ["externalId", "external_id", "id"]) as string | undefined;
  const rawTenderId = getField(row, ["tenderId", "tender_id"]) as string | undefined;
  const tenderId = rawTenderId ?? (rawExternalId ? `${sourceId}:${rawExternalId}` : undefined);

  const rawBuyer = getField(row, ["buyer"]);
  let buyer: unknown = undefined;
  if (rawBuyer && typeof rawBuyer === "object" && !Array.isArray(rawBuyer)) {
    buyer = {
      name: getField(rawBuyer, ["name"]),
      countryCode: getField(rawBuyer, ["countryCode", "country_code", "country"]) ?? null,
    };
  } else {
    const buyerName = getField(row, ["buyerName", "buyer_name"]);
    const buyerCountry = getField(row, ["buyerCountry", "buyer_country", "buyerCountryCode", "buyer_country_code"]);
    if (buyerName !== undefined || buyerCountry !== undefined) {
      buyer = {
        name: buyerName,
        countryCode: buyerCountry ?? null,
      };
    }
  }

  const rawEstVal = getField(row, ["estimatedValue", "estimated_value"]);
  let estimatedValue: unknown = null;
  if (rawEstVal && typeof rawEstVal === "object" && !Array.isArray(rawEstVal)) {
    const amountVal = getField(rawEstVal, ["amount"]);
    const amount = amountVal !== undefined && amountVal !== null ? Number(amountVal) : undefined;
    estimatedValue = {
      amount,
      currency: getField(rawEstVal, ["currency"]),
    };
  } else {
    const amountVal = getField(row, ["amount", "estimated_amount", "estimatedValueAmount", "value"]);
    const currency = getField(row, ["currency", "estimated_currency", "estimatedValueCurrency"]);
    if (amountVal !== undefined || currency !== undefined) {
      const amount = amountVal !== undefined && amountVal !== null ? Number(amountVal) : undefined;
      estimatedValue = {
        amount,
        currency,
      };
    }
  }

  const rawDocs = getField(row, ["documents"]);
  const documents = Array.isArray(rawDocs)
    ? rawDocs.map((doc) => {
        if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return doc;
        return {
          id: getField(doc, ["id"]),
          title: getField(doc, ["title"]),
          url: getField(doc, ["url", "link"]),
          publishedAt: getField(doc, ["publishedAt", "published_at"]) ?? null,
        };
      })
    : [];

  const rawCorrigenda = getField(row, ["corrigenda"]);
  const corrigenda = Array.isArray(rawCorrigenda)
    ? rawCorrigenda.map((corr) => {
        if (corr === null || typeof corr !== "object" || Array.isArray(corr)) return corr;
        return {
          id: getField(corr, ["id"]),
          title: getField(corr, ["title"]),
          description: getField(corr, ["description"]) ?? null,
          publishedAt: getField(corr, ["publishedAt", "published_at"]),
          url: getField(corr, ["url", "link"]) ?? null,
        };
      })
    : [];

  return {
    schemaVersion: 1,
    tenderId,
    sourceId: getField(row, ["sourceId", "source_id"]) ?? sourceId,
    externalId: rawExternalId,
    title: getField(row, ["title"]),
    description: getField(row, ["description"]) ?? null,
    buyer,
    status: getField(row, ["status"]),
    publishedAt: getField(row, ["publishedAt", "published_at"]) ?? null,
    submissionDeadline: getField(row, ["submissionDeadline", "submission_deadline"]) ?? null,
    url: getField(row, ["url", "link"]),
    estimatedValue,
    documents,
    corrigenda,
    observedAt,
  };
}

export interface TenderHealingProvider {
  triggerRefactor(collectorId: string, prompt: string): Promise<void>;
  pollRefactorProgress(collectorId: string): Promise<string>;
  resumeAutomationJob(collectorId: string, approve: boolean): Promise<void>;
}

export class UnconfiguredBrightDataHealingProvider implements TenderHealingProvider {
  async triggerRefactor(_collectorId: string, _prompt: string): Promise<void> {
    throw new ExternalCollectionNotConfiguredError();
  }
  async pollRefactorProgress(_collectorId: string): Promise<string> {
    throw new ExternalCollectionNotConfiguredError();
  }
  async resumeAutomationJob(_collectorId: string, _approve: boolean): Promise<void> {
    throw new ExternalCollectionNotConfiguredError();
  }
}

export class BrightDataHealingProvider implements TenderHealingProvider {
  private readonly apiToken: string;
  private readonly maxRetries: number;

  constructor(options: { apiToken?: string; maxRetries?: number } = {}) {
    this.apiToken = options.apiToken || process.env.BRIGHT_DATA_API_TOKEN || "";
    this.maxRetries = options.maxRetries ?? 3;

    if (!this.apiToken) {
      throw new Error("Bright Data API Token is required for healing");
    }
  }

  async triggerRefactor(collectorId: string, prompt: string): Promise<void> {
    const url = `https://api.brightdata.com/dca/collectors/${collectorId}/refactor_template`;
    const res = await this.fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt }),
      },
      this.maxRetries
    );

    if (res.status === 401 || res.status === 403) {
      throw new Error("Authentication failed with Bright Data API");
    }
    if (!res.ok) {
      throw new Error(`Failed to trigger refactor: ${res.status} ${res.statusText}`);
    }
  }

  async pollRefactorProgress(collectorId: string): Promise<string> {
    const url = `https://api.brightdata.com/dca/collectors/${collectorId}/refactor_template/progress`;
    const res = await this.fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          "Authorization": `Bearer ${this.apiToken}`,
        },
      },
      this.maxRetries
    );

    if (res.status === 401 || res.status === 403) {
      throw new Error("Authentication failed with Bright Data API");
    }
    if (!res.ok) {
      throw new Error(`Failed to poll refactor progress: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    const status = data?.status;
    if (typeof status !== "string") {
      throw new Error("Invalid refactor progress response");
    }
    return status;
  }

  async resumeAutomationJob(collectorId: string, approve: boolean): Promise<void> {
    const url = `https://api.brightdata.com/dca/collectors/${collectorId}/resume_automation_job`;
    const res = await this.fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: approve, auto_save: approve }),
      },
      this.maxRetries
    );

    if (res.status === 401 || res.status === 403) {
      throw new Error("Authentication failed with Bright Data API");
    }
    if (!res.ok) {
      throw new Error(`Failed to resume automation job: ${res.status} ${res.statusText}`);
    }
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number,
    initialDelayMs = 1000
  ): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        const response = await fetch(url, options);
        if (response.status >= 500 && response.status < 600 && attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        return response;
      } catch (error) {
        if (attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }
}

export class MockBrightDataHealingProvider implements TenderHealingProvider {
  private status = "in_progress";

  async triggerRefactor(_collectorId: string, _prompt: string): Promise<void> {
    this.status = "in_progress";
  }

  async pollRefactorProgress(_collectorId: string): Promise<string> {
    if (this.status === "in_progress") {
      this.status = "pending_answer";
      return "in_progress";
    }
    return "pending_answer";
  }

  async resumeAutomationJob(_collectorId: string, _approve: boolean): Promise<void> {
    // Mock approve/reject
  }
}


