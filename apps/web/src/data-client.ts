import {
  ChangeEventListResponseSchema,
  QuarantineListResponseSchema,
  SourceHealthListResponseSchema,
  TenderListResponseSchema,
  type ChangeEventListResponse,
  type QuarantineListResponse,
  type RecoveryEvidence,
  type SourceHealthListResponse,
  type TenderChangeEvent,
  type TenderListResponse,
  type TenderSummary,
} from "@bidsentinel/contracts";
import {
  tenderWithCorrigendumFixture,
  validQuarantinedExtractionFixture,
  validRecoveryEvidenceFixture,
  validSourceHealthFixture,
  validTenderChangeEventFixture,
  validTenderSummaryFixture,
} from "@bidsentinel/contracts/fixtures";

export type RuntimeMode = "mock" | "live";
export type HealingState =
  | "healthy"
  | "quarantined"
  | "healing_requested"
  | "awaiting_approval"
  | "preview_valid"
  | "preview_invalid"
  | "approved"
  | "rejected"
  | "recovered"
  | "recovery_failed";

export interface RuntimeStatus {
  mode: RuntimeMode;
  sourceId: string;
  collectorConfigured: boolean;
  targetConfigured: boolean;
  liveMutationsEnabled: boolean;
  configurationIssues: string[];
}

export interface HealingStatus {
  mode: RuntimeMode;
  sourceId: string;
  state: HealingState;
  incident: null | {
    incidentId: string;
    collectorId: string;
    state: HealingState;
    openedAt: string;
    updatedAt: string;
    reason: string;
    prompt: string | null;
    previewCount: number;
    previewValidated: boolean;
    evidence: RecoveryEvidence | null;
  };
}

export interface DashboardSnapshot {
  runtime: RuntimeStatus;
  tenders: TenderListResponse;
  changes: ChangeEventListResponse;
  sources: SourceHealthListResponse;
  quarantines: QuarantineListResponse;
  healing: HealingStatus;
  receivedAt: string;
  stale: boolean;
}

export type CollectionMode = "valid" | "drift" | "amended" | "live";

export interface MutationOptions {
  operatorToken?: string;
}

export interface BidSentinelDataClient {
  load(): Promise<DashboardSnapshot>;
  collect(mode: CollectionMode, options?: MutationOptions): Promise<void>;
  progressHealing(options?: MutationOptions): Promise<void>;
  validatePreview(options?: MutationOptions): Promise<void>;
  approve(approve: boolean, options?: MutationOptions): Promise<void>;
}

export class DataClientError extends Error {
  constructor(
    message: string,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "DataClientError";
  }
}

type FetchLike = typeof fetch;

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/$/, "")}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRuntimeResponse(value: unknown): RuntimeStatus {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new DataClientError("The API returned an invalid runtime response");
  }
  const data = value.data;
  if (
    (data.mode !== "mock" && data.mode !== "live") ||
    typeof data.sourceId !== "string" ||
    typeof data.collectorConfigured !== "boolean" ||
    typeof data.targetConfigured !== "boolean" ||
    typeof data.liveMutationsEnabled !== "boolean" ||
    !Array.isArray(data.configurationIssues) ||
    !data.configurationIssues.every((item) => typeof item === "string")
  ) {
    throw new DataClientError("The API returned an invalid runtime response");
  }
  return {
    mode: data.mode,
    sourceId: data.sourceId,
    collectorConfigured: data.collectorConfigured,
    targetConfigured: data.targetConfigured,
    liveMutationsEnabled: data.liveMutationsEnabled,
    configurationIssues: [...data.configurationIssues],
  };
}

const healingStates = new Set<HealingState>([
  "healthy",
  "quarantined",
  "healing_requested",
  "awaiting_approval",
  "preview_valid",
  "preview_invalid",
  "approved",
  "rejected",
  "recovered",
  "recovery_failed",
]);

function parseHealingResponse(value: unknown): HealingStatus {
  if (!isRecord(value) || !isRecord(value.data)) {
    throw new DataClientError("The API returned an invalid healing response");
  }
  const data = value.data;
  if (
    (data.mode !== "mock" && data.mode !== "live") ||
    typeof data.sourceId !== "string" ||
    typeof data.state !== "string" ||
    !healingStates.has(data.state as HealingState)
  ) {
    throw new DataClientError("The API returned an invalid healing response");
  }
  if (data.incident !== null && !isRecord(data.incident)) {
    throw new DataClientError("The API returned an invalid healing incident");
  }

  const incident = data.incident;
  if (incident === null) {
    return {
      mode: data.mode,
      sourceId: data.sourceId,
      state: data.state as HealingState,
      incident: null,
    };
  }
  if (
    typeof incident.incidentId !== "string" ||
    typeof incident.collectorId !== "string" ||
    typeof incident.state !== "string" ||
    !healingStates.has(incident.state as HealingState) ||
    typeof incident.openedAt !== "string" ||
    typeof incident.updatedAt !== "string" ||
    typeof incident.reason !== "string" ||
    (incident.prompt !== null && typeof incident.prompt !== "string") ||
    typeof incident.previewCount !== "number" ||
    typeof incident.previewValidated !== "boolean"
  ) {
    throw new DataClientError("The API returned an invalid healing incident");
  }
  return {
    mode: data.mode,
    sourceId: data.sourceId,
    state: data.state as HealingState,
    incident: {
      incidentId: incident.incidentId,
      collectorId: incident.collectorId,
      state: incident.state as HealingState,
      openedAt: incident.openedAt,
      updatedAt: incident.updatedAt,
      reason: incident.reason,
      prompt: incident.prompt as string | null,
      previewCount: incident.previewCount,
      previewValidated: incident.previewValidated,
      evidence: (incident.evidence as RecoveryEvidence | null) ?? null,
    },
  };
}

async function readJson(response: Response): Promise<unknown> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new DataClientError(
      `API returned non-JSON content (${response.status})`,
      response.status,
    );
  }
  if (!response.ok) {
    const message =
      isRecord(body) &&
      isRecord(body.error) &&
      typeof body.error.message === "string"
        ? body.error.message
        : `API request failed (${response.status})`;
    throw new DataClientError(message, response.status);
  }
  return body;
}

export class HttpBidSentinelDataClient implements BidSentinelDataClient {
  constructor(
    private readonly baseUrl = "",
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async load(): Promise<DashboardSnapshot> {
    const runtimeValue = await this.get("/api/runtime");
    const runtime = parseRuntimeResponse(runtimeValue);
    const [
      tendersValue,
      changesValue,
      sourcesValue,
      quarantinesValue,
      healingValue,
    ] = await Promise.all([
      this.get("/api/tenders"),
      this.get("/api/changes"),
      this.get("/api/sources"),
      this.get("/api/quarantines"),
      this.get(`/api/healing/${encodeURIComponent(runtime.sourceId)}`),
    ]);

    const tenders = TenderListResponseSchema.parse(tendersValue);
    const changes = ChangeEventListResponseSchema.parse(changesValue);
    const sources = SourceHealthListResponseSchema.parse(sourcesValue);
    const quarantines = QuarantineListResponseSchema.parse(quarantinesValue);
    const healing = parseHealingResponse(healingValue);
    const receivedAt = new Date().toISOString();

    return {
      runtime,
      tenders,
      changes,
      sources,
      quarantines,
      healing,
      receivedAt,
      stale: isGeneratedDataStale(
        [
          tenders.generatedAt,
          changes.generatedAt,
          sources.generatedAt,
          quarantines.generatedAt,
        ],
        Date.parse(receivedAt),
      ),
    };
  }

  async collect(
    mode: CollectionMode,
    options: MutationOptions = {},
  ): Promise<void> {
    await this.post(
      `/api/dev/collect?mode=${encodeURIComponent(mode)}`,
      undefined,
      options.operatorToken,
    );
  }

  async progressHealing(options: MutationOptions = {}): Promise<void> {
    await this.post("/api/dev/heal-progress", undefined, options.operatorToken);
  }

  async validatePreview(options: MutationOptions = {}): Promise<void> {
    await this.post(
      "/api/dev/validate-preview",
      undefined,
      options.operatorToken,
    );
  }

  async approve(
    approve: boolean,
    options: MutationOptions = {},
  ): Promise<void> {
    // The backend may wait up to ten minutes for Bright Data to finish the
    // approved repair, then rerun the collector. Keep the browser request alive
    // long enough to receive that terminal evidence instead of showing a false
    // failure while the server continues working.
    await this.post(
      "/api/dev/approve",
      { approve },
      options.operatorToken,
      780_000,
    );
  }

  private async get(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchFn(joinUrl(this.baseUrl, path), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new DataClientError(
        error instanceof Error
          ? `Could not reach BidSentinel API: ${error.message}`
          : "Could not reach BidSentinel API",
      );
    }
    return readJson(response);
  }

  private async post(
    path: string,
    body: unknown,
    operatorToken?: string,
    timeoutMs = 90_000,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (operatorToken) {
      headers["x-bidsentinel-operator-token"] = operatorToken;
    }

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: "POST",
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (body !== undefined) requestInit.body = JSON.stringify(body);
      response = await this.fetchFn(joinUrl(this.baseUrl, path), requestInit);
    } catch (error) {
      throw new DataClientError(
        error instanceof Error
          ? `BidSentinel action failed: ${error.message}`
          : "BidSentinel action failed",
      );
    }
    return readJson(response);
  }
}

function pagination(total: number) {
  return { limit: 50, offset: 0, total, hasMore: false };
}

function activeIncident(state: HealingState, now: string) {
  if (["healthy", "recovered"].includes(state)) return null;
  return {
    incidentId: "ec1ef7d9-f67c-45ab-b4a9-dfcf406564d2",
    openedAt: now,
    reason: "schema-drift" as const,
    detail: "Required tender fields disappeared after a source layout change.",
  };
}

function demoTender(amended: boolean): TenderSummary {
  return amended
    ? {
        ...validTenderSummaryFixture,
        submissionDeadline: tenderWithCorrigendumFixture.submissionDeadline,
        observedAt: tenderWithCorrigendumFixture.observedAt,
        latestSnapshot: {
          snapshotId: "56f00f0d-f6f1-47a3-8693-1578423dc6b1",
          version: 2,
        },
        corrigendumCount: 1,
      }
    : structuredClone(validTenderSummaryFixture);
}

function amendmentEvent(): TenderChangeEvent {
  return {
    ...validTenderChangeEventFixture,
    changes: [
      ...validTenderChangeEventFixture.changes,
      {
        kind: "corrigendum",
        added: tenderWithCorrigendumFixture.corrigenda,
        removed: [],
        updated: [],
      },
    ],
  };
}

export class FixtureBidSentinelDataClient implements BidSentinelDataClient {
  private state: HealingState = "healthy";
  private amended = false;
  private forcedStale = false;
  private unavailable = false;

  async load(): Promise<DashboardSnapshot> {
    if (this.unavailable) {
      throw new DataClientError(
        "The fixture source is unavailable for this state inspection",
        503,
      );
    }
    const now = new Date().toISOString();
    const hasIncident = !["healthy", "recovered"].includes(this.state);
    const evidence =
      this.state === "recovered"
        ? { ...validRecoveryEvidenceFixture, completedAt: now }
        : this.state === "recovery_failed"
          ? {
              ...validRecoveryEvidenceFixture,
              completedAt: now,
              outcome: "failed" as const,
              actions: ["Healing preview failed contract validation"],
            }
          : null;
    const sourceState =
      this.state === "healthy" || this.state === "recovered"
        ? "healthy"
        : this.state === "quarantined" ||
            this.state === "recovery_failed" ||
            this.state === "rejected"
          ? "quarantined"
          : "recovering";
    const sources: SourceHealthListResponse = {
      data: [
        {
          ...validSourceHealthFixture,
          state: sourceState,
          checkedAt: now,
          lastSuccessfulAt:
            sourceState === "healthy"
              ? now
              : validSourceHealthFixture.lastSuccessfulAt,
          consecutiveFailures: hasIncident ? 1 : 0,
          recentFailureRate: hasIncident ? 0.5 : 0,
          activeIncident: activeIncident(this.state, now),
          latestRecoveryEvidence: evidence,
        },
      ],
      pagination: pagination(1),
      generatedAt: now,
    };
    const tenderData = [demoTender(this.amended)];
    const changeData = this.amended ? [amendmentEvent()] : [];
    const quarantineData = hasIncident
      ? [
          {
            ...validQuarantinedExtractionFixture,
            observedAt: now,
            issues: [
              {
                code: "invalid_type",
                path: ["title"],
                message: "Required tender title was missing after layout drift",
              },
            ],
          },
        ]
      : [];
    const healing: HealingStatus = {
      mode: "mock",
      sourceId: validSourceHealthFixture.sourceId,
      state: this.state,
      incident:
        this.state === "healthy"
          ? null
          : {
              incidentId: validRecoveryEvidenceFixture.incidentId,
              collectorId: "c_mock_dev",
              state: this.state,
              openedAt: now,
              updatedAt: now,
              reason: "Source layout changed from table rows to cards",
              prompt: "Refactor selectors for the new tender card layout.",
              previewCount: [
                "awaiting_approval",
                "preview_valid",
                "preview_invalid",
              ].includes(this.state)
                ? 1
                : 0,
              previewValidated: [
                "preview_valid",
                "approved",
                "recovered",
              ].includes(this.state),
              evidence,
            },
    };

    return {
      runtime: {
        mode: "mock",
        sourceId: validSourceHealthFixture.sourceId,
        collectorConfigured: false,
        targetConfigured: false,
        liveMutationsEnabled: false,
        configurationIssues: [
          "Deterministic fixture adapter selected; no Bright Data calls are made",
        ],
      },
      tenders: {
        data: tenderData,
        pagination: pagination(tenderData.length),
        generatedAt: now,
      },
      changes: {
        data: changeData,
        pagination: pagination(changeData.length),
        generatedAt: now,
      },
      sources,
      quarantines: {
        data: quarantineData,
        pagination: pagination(quarantineData.length),
        generatedAt: now,
      },
      healing,
      receivedAt: now,
      stale: this.forcedStale,
    };
  }

  async collect(mode: CollectionMode): Promise<void> {
    if (mode === "drift") {
      this.state = "healing_requested";
      return;
    }
    if (mode === "amended") {
      this.amended = true;
      return;
    }
    this.state = "healthy";
    this.amended = false;
  }

  async progressHealing(): Promise<void> {
    if (this.state !== "healing_requested" && this.state !== "approved") {
      throw new DataClientError(
        `Cannot poll healing progress from ${this.state}`,
        409,
      );
    }
    this.state = "awaiting_approval";
  }

  async validatePreview(): Promise<void> {
    if (this.state !== "awaiting_approval") {
      throw new DataClientError(
        `Cannot validate a preview from ${this.state}`,
        409,
      );
    }
    this.state = "preview_valid";
  }

  async approve(approve: boolean): Promise<void> {
    if (!approve) {
      this.state = "rejected";
      return;
    }
    if (this.state !== "preview_valid") {
      throw new DataClientError(
        `Cannot approve healing from ${this.state}`,
        409,
      );
    }
    this.state = "recovered";
  }

  setInspectionState(state: HealingState): void {
    this.state = state;
    this.forcedStale = false;
    this.unavailable = false;
  }

  setInspectionScenario(
    scenario: HealingState | "stale" | "unavailable",
  ): void {
    if (scenario === "stale") {
      this.forcedStale = true;
      this.unavailable = false;
      return;
    }
    if (scenario === "unavailable") {
      this.unavailable = true;
      return;
    }
    this.setInspectionState(scenario);
  }
}

export function isGeneratedDataStale(
  generatedAtValues: string[],
  now = Date.now(),
  staleAfterMs = 2 * 60_000,
): boolean {
  return generatedAtValues.some((value) => {
    const timestamp = Date.parse(value);
    return !Number.isFinite(timestamp) || now - timestamp > staleAfterMs;
  });
}
