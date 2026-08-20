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
  collectorId: string;
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

export type BrightDataErrorCode =
  | "authentication"
  | "rate_limited"
  | "not_found"
  | "invalid_input"
  | "timeout"
  | "network"
  | "malformed_response"
  | "api_error";

/** An operational error safe to surface without leaking request credentials. */
export class BrightDataApiError extends Error {
  constructor(
    public readonly code: BrightDataErrorCode,
    message: string,
    public readonly options: {
      status?: number;
      transient?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "BrightDataApiError";
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get transient(): boolean {
    return this.options.transient ?? false;
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
  requestTimeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetchFn?: typeof fetch;
  sleepFn?: (delayMs: number) => Promise<void>;
  nowFn?: () => number;
}

export class BrightDataCollectionProvider implements TenderCollectionProvider {
  private readonly apiToken: string;
  private readonly collectorId: string;
  private readonly pollingIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (delayMs: number) => Promise<void>;
  private readonly nowFn: () => number;

  constructor(options: BrightDataCollectionProviderOptions = {}) {
    this.apiToken = options.apiToken || process.env.BRIGHT_DATA_API_TOKEN || "";
    this.collectorId =
      options.collectorId || process.env.BRIGHT_DATA_COLLECTOR_ID || "";
    this.pollingIntervalMs = options.pollingIntervalMs ?? 5000;
    this.timeoutMs = options.timeoutMs ?? 120000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.maxRetries = options.maxRetries ?? 3;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn =
      options.sleepFn ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.nowFn = options.nowFn ?? Date.now;

    if (!this.apiToken || !this.collectorId) {
      throw new ExternalCollectionNotConfiguredError();
    }
  }

  async collect(
    request: TenderCollectionRequest,
  ): Promise<TenderCollectionBatch> {
    const triggerUrl = new URL("https://api.brightdata.com/dca/trigger");
    triggerUrl.searchParams.set("collector", this.collectorId);
    triggerUrl.searchParams.set("queue_next", "1");

    const triggerRes = await this.fetchWithRetry(
      triggerUrl.toString(),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([{ url: request.targetUrl }]),
      },
      this.maxRetries,
    );

    this.assertSuccessfulResponse(triggerRes, "trigger collector");

    const triggerData = await this.parseObjectResponse(
      triggerRes,
      "trigger collector",
    );
    const collectionId = triggerData.collection_id;
    if (typeof collectionId !== "string" || collectionId.trim() === "") {
      throw new BrightDataApiError(
        "malformed_response",
        "Bright Data trigger response did not contain a valid collection_id",
      );
    }

    const rawRows = await this.pollDataset(collectionId);
    const receivedAt = new Date().toISOString();
    const payloads = rawRows.map((row) =>
      mapRawRowToTender(row, request.sourceId, receivedAt),
    );

    return {
      sourceId: request.sourceId,
      collectorId: this.collectorId,
      extractorVersion: `brightdata-${this.collectorId}`,
      receivedAt,
      payloads,
    };
  }

  private async pollDataset(collectionId: string): Promise<unknown[]> {
    const startTime = this.nowFn();
    const datasetUrl = new URL("https://api.brightdata.com/dca/dataset");
    datasetUrl.searchParams.set("id", collectionId);

    while (true) {
      if (this.nowFn() - startTime >= this.timeoutMs) {
        throw new BrightDataApiError(
          "timeout",
          "Timed out waiting for Bright Data collection to complete",
          { transient: true },
        );
      }

      const pollRes = await this.fetchWithRetry(
        datasetUrl.toString(),
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
          },
        },
        this.maxRetries,
      );

      if (pollRes.status === 202) {
        await this.sleepFn(this.pollingIntervalMs);
        continue;
      }

      this.assertSuccessfulResponse(pollRes, "poll dataset");

      const responseText = await pollRes.text();
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch {
        throw new BrightDataApiError(
          "malformed_response",
          "Bright Data dataset response was not valid JSON",
        );
      }

      if (
        data !== null &&
        typeof data === "object" &&
        !Array.isArray(data) &&
        (data as Record<string, unknown>).status === "building"
      ) {
        await this.sleepFn(this.pollingIntervalMs);
        continue;
      }

      if (Array.isArray(data)) {
        return data;
      }

      throw new BrightDataApiError(
        "malformed_response",
        "Bright Data dataset response was neither a building status nor an array",
      );
    }
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number,
    initialDelayMs = this.retryDelayMs,
  ): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.fetchFn(url, {
          ...options,
          signal: options.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
        });
        const retryableStatus =
          response.status === 429 ||
          (response.status >= 500 && response.status < 600);
        if (retryableStatus && attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await this.sleepFn(delay);
          continue;
        }
        return response;
      } catch (error) {
        if (attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await this.sleepFn(delay);
          continue;
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new BrightDataApiError(
            "timeout",
            "Bright Data request timed out",
            { transient: true, cause: error },
          );
        }
        throw new BrightDataApiError(
          "network",
          "Bright Data request failed before a response was received",
          { transient: true, cause: error },
        );
      }
    }
  }

  private assertSuccessfulResponse(
    response: Response,
    operation: string,
  ): void {
    if (response.ok) return;

    const details = { status: response.status };
    if (response.status === 401 || response.status === 403) {
      throw new BrightDataApiError(
        "authentication",
        `Bright Data authentication failed while attempting to ${operation}`,
        details,
      );
    }
    if (response.status === 404) {
      throw new BrightDataApiError(
        "not_found",
        `Bright Data resource was not found while attempting to ${operation}`,
        details,
      );
    }
    if (response.status === 422) {
      throw new BrightDataApiError(
        "invalid_input",
        `Bright Data rejected the configured collector input while attempting to ${operation}`,
        details,
      );
    }
    if (response.status === 429) {
      throw new BrightDataApiError(
        "rate_limited",
        `Bright Data rate limited the request while attempting to ${operation}`,
        { ...details, transient: true },
      );
    }
    throw new BrightDataApiError(
      "api_error",
      `Bright Data returned HTTP ${response.status} while attempting to ${operation}`,
      {
        ...details,
        transient: response.status >= 500,
      },
    );
  }

  private async parseObjectResponse(
    response: Response,
    operation: string,
  ): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new BrightDataApiError(
        "malformed_response",
        `Bright Data returned invalid JSON while attempting to ${operation}`,
        { cause: error },
      );
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new BrightDataApiError(
        "malformed_response",
        `Bright Data returned an invalid object while attempting to ${operation}`,
      );
    }
    return data as Record<string, unknown>;
  }
}

export function mapRawRowToTender(
  row: unknown,
  sourceId: string,
  observedAt: string,
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

  const rawExternalId = getField(row, ["externalId", "external_id", "id"]) as
    string | undefined;
  const rawTenderId = getField(row, ["tenderId", "tender_id"]) as
    string | undefined;
  const tenderId =
    rawTenderId ?? (rawExternalId ? `${sourceId}:${rawExternalId}` : undefined);

  const rawBuyer = getField(row, ["buyer"]);
  let buyer: unknown = undefined;
  if (rawBuyer && typeof rawBuyer === "object" && !Array.isArray(rawBuyer)) {
    buyer = {
      name: getField(rawBuyer, ["name"]),
      countryCode:
        getField(rawBuyer, ["countryCode", "country_code", "country"]) ?? null,
    };
  } else {
    const buyerName = getField(row, ["buyerName", "buyer_name"]);
    const buyerCountry = getField(row, [
      "buyerCountry",
      "buyer_country",
      "buyerCountryCode",
      "buyer_country_code",
    ]);
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
    const amount =
      amountVal !== undefined && amountVal !== null
        ? Number(amountVal)
        : undefined;
    estimatedValue = {
      amount,
      currency: getField(rawEstVal, ["currency"]),
    };
  } else {
    const amountVal = getField(row, [
      "amount",
      "estimated_amount",
      "estimatedValueAmount",
      "value",
    ]);
    const currency = getField(row, [
      "currency",
      "estimated_currency",
      "estimatedValueCurrency",
    ]);
    if (amountVal !== undefined || currency !== undefined) {
      const amount =
        amountVal !== undefined && amountVal !== null
          ? Number(amountVal)
          : undefined;
      estimatedValue = {
        amount,
        currency,
      };
    }
  }

  const rawDocs = getField(row, ["documents"]);
  const documents = Array.isArray(rawDocs)
    ? rawDocs.map((doc) => {
        if (doc === null || typeof doc !== "object" || Array.isArray(doc))
          return doc;
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
        if (corr === null || typeof corr !== "object" || Array.isArray(corr))
          return corr;
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
    submissionDeadline:
      getField(row, ["submissionDeadline", "submission_deadline"]) ?? null,
    url: getField(row, ["url", "link"]),
    estimatedValue,
    documents,
    corrigenda,
    observedAt,
  };
}

export interface TenderHealingProvider {
  triggerRefactor(collectorId: string, prompt: string): Promise<void>;
  pollRefactorProgress(collectorId: string): Promise<TenderHealingProgress>;
  resumeAutomationJob(
    collectorId: string,
    approve: boolean,
    options?: { autoSave?: boolean },
  ): Promise<void>;
}

export interface TenderHealingProgress {
  status: string;
  step?: string;
  previewResult: unknown[];
}

export class UnconfiguredBrightDataHealingProvider implements TenderHealingProvider {
  async triggerRefactor(_collectorId: string, _prompt: string): Promise<void> {
    throw new ExternalCollectionNotConfiguredError();
  }
  async pollRefactorProgress(
    _collectorId: string,
  ): Promise<TenderHealingProgress> {
    throw new ExternalCollectionNotConfiguredError();
  }
  async resumeAutomationJob(
    _collectorId: string,
    _approve: boolean,
    _options?: { autoSave?: boolean },
  ): Promise<void> {
    throw new ExternalCollectionNotConfiguredError();
  }
}

export class BrightDataHealingProvider implements TenderHealingProvider {
  private readonly apiToken: string;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (delayMs: number) => Promise<void>;

  constructor(
    options: {
      apiToken?: string;
      maxRetries?: number;
      requestTimeoutMs?: number;
      retryDelayMs?: number;
      fetchFn?: typeof fetch;
      sleepFn?: (delayMs: number) => Promise<void>;
    } = {},
  ) {
    this.apiToken = options.apiToken || process.env.BRIGHT_DATA_API_TOKEN || "";
    this.maxRetries = options.maxRetries ?? 3;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn =
      options.sleepFn ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));

    if (!this.apiToken) {
      throw new ExternalCollectionNotConfiguredError();
    }
  }

  async triggerRefactor(collectorId: string, prompt: string): Promise<void> {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt || normalizedPrompt.length > 1000) {
      throw new BrightDataApiError(
        "invalid_input",
        "Bright Data healing prompt must contain between 1 and 1000 characters",
      );
    }
    const url = this.collectorEndpoint(collectorId, "refactor_template");
    const res = await this.fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: normalizedPrompt, custom_input: [] }),
      },
      this.maxRetries,
    );

    this.assertSuccessfulResponse(res, "trigger self-healing");
  }

  async pollRefactorProgress(
    collectorId: string,
  ): Promise<TenderHealingProgress> {
    const url = this.collectorEndpoint(
      collectorId,
      "refactor_template/progress",
    );
    const res = await this.fetchWithRetry(
      url,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
        },
      },
      this.maxRetries,
    );

    this.assertSuccessfulResponse(res, "poll self-healing progress");

    const data = await this.parseProgressResponse(res);
    const status = data?.status;
    if (typeof status !== "string") {
      throw new BrightDataApiError(
        "malformed_response",
        "Bright Data self-healing progress response did not include a status",
      );
    }
    return {
      status,
      ...(typeof data.step === "string" ? { step: data.step } : {}),
      previewResult: Array.isArray(data.preview_result)
        ? data.preview_result
        : [],
    };
  }

  async resumeAutomationJob(
    collectorId: string,
    approve: boolean,
    options: { autoSave?: boolean } = {},
  ): Promise<void> {
    const url = this.collectorEndpoint(collectorId, "resume_automation_job");
    const body =
      approve && options.autoSave
        ? { message: true, auto_save: true }
        : { message: approve };
    const res = await this.fetchWithRetry(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      this.maxRetries,
    );

    this.assertSuccessfulResponse(res, "resume self-healing");
  }

  private async fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries: number,
    initialDelayMs = this.retryDelayMs,
  ): Promise<Response> {
    let attempt = 0;
    while (true) {
      try {
        const response = await this.fetchFn(url, {
          ...options,
          signal: options.signal ?? AbortSignal.timeout(this.requestTimeoutMs),
        });
        const retryableStatus =
          response.status === 429 ||
          (response.status >= 500 && response.status < 600);
        if (retryableStatus && attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await this.sleepFn(delay);
          continue;
        }
        return response;
      } catch (error) {
        if (attempt < maxRetries) {
          attempt++;
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          await this.sleepFn(delay);
          continue;
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new BrightDataApiError(
            "timeout",
            "Bright Data self-healing request timed out",
            { transient: true, cause: error },
          );
        }
        throw new BrightDataApiError(
          "network",
          "Bright Data self-healing request failed before a response was received",
          { transient: true, cause: error },
        );
      }
    }
  }

  private collectorEndpoint(collectorId: string, path: string): string {
    if (!/^c_[a-zA-Z0-9_-]+$/.test(collectorId)) {
      throw new BrightDataApiError(
        "invalid_input",
        "Bright Data collector ID must start with c_",
      );
    }
    return `https://api.brightdata.com/dca/collectors/${encodeURIComponent(collectorId)}/${path}`;
  }

  private assertSuccessfulResponse(
    response: Response,
    operation: string,
  ): void {
    if (response.ok) return;
    const status = response.status;
    if (status === 401 || status === 403) {
      throw new BrightDataApiError(
        "authentication",
        `Bright Data authentication failed while attempting to ${operation}`,
        { status },
      );
    }
    if (status === 404) {
      throw new BrightDataApiError(
        "not_found",
        `Bright Data collector was not found while attempting to ${operation}`,
        { status },
      );
    }
    if (status === 429) {
      throw new BrightDataApiError(
        "rate_limited",
        `Bright Data rate limited the request while attempting to ${operation}`,
        { status, transient: true },
      );
    }
    throw new BrightDataApiError(
      "api_error",
      `Bright Data returned HTTP ${status} while attempting to ${operation}`,
      { status, transient: status >= 500 },
    );
  }

  private async parseProgressResponse(
    response: Response,
  ): Promise<Record<string, unknown>> {
    let data: unknown;
    try {
      data = await response.json();
    } catch (error) {
      throw new BrightDataApiError(
        "malformed_response",
        "Bright Data self-healing progress response was not valid JSON",
        { cause: error },
      );
    }
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      throw new BrightDataApiError(
        "malformed_response",
        "Bright Data self-healing progress response was not an object",
      );
    }
    return data as Record<string, unknown>;
  }
}

export class MockBrightDataHealingProvider implements TenderHealingProvider {
  private status = "pending_answer";

  constructor(private readonly previewResult: unknown[] = []) {}

  async triggerRefactor(_collectorId: string, _prompt: string): Promise<void> {
    // The deterministic judge demo makes its preview available on the first
    // explicit poll. Dedicated coordinator tests cover longer-running jobs.
    this.status = "pending_answer";
  }

  async pollRefactorProgress(
    _collectorId: string,
  ): Promise<TenderHealingProgress> {
    return {
      status: this.status,
      previewResult:
        this.status === "pending_answer"
          ? structuredClone(this.previewResult)
          : [],
    };
  }

  async resumeAutomationJob(
    _collectorId: string,
    approve: boolean,
    _options?: { autoSave?: boolean },
  ): Promise<void> {
    this.status = approve ? "done" : "rejected";
  }
}
