import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ExternalCollectionNotConfiguredError,
  UnconfiguredBrightDataProvider,
  BrightDataCollectionProvider,
  mapRawRowToTender,
  BrightDataHealingProvider,
  UnconfiguredBrightDataHealingProvider,
} from "./index.js";
import type { BrightDataApiError } from "./index.js";

describe("UnconfiguredBrightDataProvider", () => {
  it("fails closed without making a network request", async () => {
    const provider = new UnconfiguredBrightDataProvider();

    await expect(
      provider.collect({
        sourceId: "gem",
        targetUrl: "https://example.gov.test/tenders",
        requestedAt: "2026-08-20T05:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ExternalCollectionNotConfiguredError);
  });
});

describe("BrightDataCollectionProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("successfully triggers collector, polls, and returns dataset payloads", async () => {
    let pollCount = 0;
    const mockFetch = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes("/dca/trigger")) {
        expect(options?.method).toBe("POST");
        expect(url).toContain("queue_next=1");
        expect(options?.body).toContain("https://example.gov.test/tenders");
        return Promise.resolve(
          new Response(JSON.stringify({ collection_id: "j_success_123" }), {
            status: 200,
          }),
        );
      }
      if (url.includes("/dca/dataset?id=j_success_123")) {
        expect(options?.method).toBe("GET");
        pollCount++;
        if (pollCount === 1) {
          return Promise.resolve(new Response("", { status: 202 }));
        }
        if (pollCount === 2) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: "building" }), {
              status: 200,
            }),
          );
        }
        return Promise.resolve(
          new Response(
            JSON.stringify([
              {
                id: "2026-rail-signalling-001",
                title: "Signalling Equipment",
                url: "https://example.gov.test/tenders/001",
                status: "open",
                buyer_name: "National Rail",
              },
            ]),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataCollectionProvider({
      apiToken: "test-token",
      collectorId: "c_test_123",
      pollingIntervalMs: 1,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    const result = await provider.collect({
      sourceId: "gem",
      targetUrl: "https://example.gov.test/tenders",
      requestedAt: "2026-08-20T05:00:00.000Z",
    });

    expect(result.sourceId).toBe("gem");
    expect(result.collectorId).toBe("c_test_123");
    expect(result.extractorVersion).toBe("brightdata-c_test_123");
    expect(result.payloads).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped = result.payloads[0] as any;
    expect(mapped.externalId).toBe("2026-rail-signalling-001");
    expect(mapped.tenderId).toBe("gem:2026-rail-signalling-001");
    expect(mapped.title).toBe("Signalling Equipment");
    expect(mapped.buyer.name).toBe("National Rail");
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("handles authentication failure immediately", async () => {
    const mockFetch = vi.fn((url: string) => {
      if (url.includes("/dca/trigger")) {
        return Promise.resolve(new Response("", { status: 401 }));
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataCollectionProvider({
      apiToken: "invalid-token",
      collectorId: "c_test_123",
      pollingIntervalMs: 1,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    await expect(
      provider.collect({
        sourceId: "gem",
        targetUrl: "https://example.gov.test/tenders",
        requestedAt: "2026-08-20T05:00:00.000Z",
      }),
    ).rejects.toMatchObject({
      name: "BrightDataApiError",
      code: "authentication",
      status: 401,
    } satisfies Partial<BrightDataApiError>);
  });

  it("aborts a hung HTTP request within the configured request timeout", async () => {
    const hangingFetch = vi.fn(
      (_input: Parameters<typeof fetch>[0], init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason),
            { once: true },
          );
        }),
    ) as typeof fetch;
    const provider = new BrightDataCollectionProvider({
      apiToken: "secret-token-that-must-not-leak",
      collectorId: "c_test_123",
      requestTimeoutMs: 5,
      maxRetries: 0,
      fetchFn: hangingFetch,
    });

    let caught: unknown;
    try {
      await provider.collect({
        sourceId: "gem",
        targetUrl: "https://example.gov.test/tenders",
        requestedAt: "2026-08-20T05:00:00.000Z",
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({ code: "timeout", transient: true });
    expect(String(caught)).not.toContain("secret-token-that-must-not-leak");
    expect(hangingFetch).toHaveBeenCalledTimes(1);
  });

  it("aborts and throws a timeout error if polling exceeds timeout limit", async () => {
    const mockFetch = vi.fn((url: string) => {
      if (url.includes("/dca/trigger")) {
        return Promise.resolve(
          new Response(JSON.stringify({ collection_id: "j_timeout_123" }), {
            status: 200,
          }),
        );
      }
      if (url.includes("/dca/dataset?id=j_timeout_123")) {
        return Promise.resolve(new Response("", { status: 202 }));
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataCollectionProvider({
      apiToken: "test-token",
      collectorId: "c_test_123",
      pollingIntervalMs: 1,
      timeoutMs: 10,
      maxRetries: 0,
    });

    await expect(
      provider.collect({
        sourceId: "gem",
        targetUrl: "https://example.gov.test/tenders",
        requestedAt: "2026-08-20T05:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "timeout", transient: true });
  });

  it("retries on transient 5xx errors with exponential backoff", async () => {
    let triggerCount = 0;
    let pollCount = 0;

    const mockFetch = vi.fn((url: string) => {
      if (url.includes("/dca/trigger")) {
        triggerCount++;
        if (triggerCount === 1) {
          return Promise.resolve(
            new Response("Service Unavailable", { status: 503 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ collection_id: "j_retry_123" }), {
            status: 200,
          }),
        );
      }
      if (url.includes("/dca/dataset?id=j_retry_123")) {
        pollCount++;
        if (pollCount === 1) {
          return Promise.resolve(
            new Response("Internal Server Error", { status: 500 }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify([]), { status: 200 }),
        );
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataCollectionProvider({
      apiToken: "test-token",
      collectorId: "c_test_123",
      pollingIntervalMs: 1,
      timeoutMs: 1000,
      maxRetries: 2,
      retryDelayMs: 1,
    });

    const result = await provider.collect({
      sourceId: "gem",
      targetUrl: "https://example.gov.test/tenders",
      requestedAt: "2026-08-20T05:00:00.000Z",
    });

    expect(result.payloads).toEqual([]);
    expect(triggerCount).toBe(2);
    expect(pollCount).toBe(2);
  });

  it("rejects on malformed JSON response from dataset endpoint", async () => {
    const mockFetch = vi.fn((url: string) => {
      if (url.includes("/dca/trigger")) {
        return Promise.resolve(
          new Response(JSON.stringify({ collection_id: "j_malformed_123" }), {
            status: 200,
          }),
        );
      }
      if (url.includes("/dca/dataset?id=j_malformed_123")) {
        return Promise.resolve(new Response("not-json", { status: 200 }));
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataCollectionProvider({
      apiToken: "test-token",
      collectorId: "c_test_123",
      pollingIntervalMs: 1,
      timeoutMs: 1000,
      maxRetries: 0,
    });

    await expect(
      provider.collect({
        sourceId: "gem",
        targetUrl: "https://example.gov.test/tenders",
        requestedAt: "2026-08-20T05:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("rejects a non-string collection ID before polling", async () => {
    const mockFetch = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ collection_id: 123 }), { status: 200 }),
      ),
    );

    const provider = new BrightDataCollectionProvider({
      apiToken: "test-token",
      collectorId: "c_test_123",
      maxRetries: 0,
      fetchFn: mockFetch,
    });

    await expect(
      provider.collect({
        sourceId: "gem",
        targetUrl: "https://example.gov.test/tenders",
        requestedAt: "2026-08-20T05:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "malformed_response" });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("processes mixed valid and invalid rows independently through mapping", () => {
    const observedAt = "2026-08-20T05:00:00.000Z";
    const validRow = {
      id: "valid-id",
      title: "Valid Title",
      url: "https://example.gov.test/tenders/valid",
      status: "open",
      buyer: { name: "Buyer Name", country: "IN" },
    };
    const invalidRow = {
      id: "invalid-id",
      url: "not-a-url",
      status: "invalid-status",
    };

    type MappedTender = {
      tenderId?: unknown;
      title?: unknown;
      url?: unknown;
      buyer?: { name?: unknown; countryCode?: unknown };
    };
    const mappedValid = mapRawRowToTender(
      validRow,
      "gem",
      observedAt,
    ) as MappedTender;
    const mappedInvalid = mapRawRowToTender(
      invalidRow,
      "gem",
      observedAt,
    ) as MappedTender;

    expect(mappedValid.tenderId).toBe("gem:valid-id");
    expect(mappedValid.title).toBe("Valid Title");
    expect(mappedValid.buyer?.name).toBe("Buyer Name");
    expect(mappedValid.buyer?.countryCode).toBe("IN");

    expect(mappedInvalid.tenderId).toBe("gem:invalid-id");
    expect(mappedInvalid.title).toBeUndefined();
    expect(mappedInvalid.url).toBe("not-a-url");
    expect(mappedInvalid.buyer).toBeUndefined();
  });
});

describe("BrightDataHealingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("successfully triggers refactor template with prompt", async () => {
    const mockFetch = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes("/refactor_template")) {
        expect(options?.method).toBe("POST");
        expect(JSON.parse(String(options?.body))).toEqual({
          prompt: "fix layout drift",
          custom_input: [],
        });
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataHealingProvider({
      apiToken: "test-token",
      maxRetries: 0,
    });
    await provider.triggerRefactor("c_test_123", "fix layout drift");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("successfully polls refactor progress", async () => {
    const mockFetch = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes("/refactor_template/progress")) {
        expect(options?.method).toBe("GET");
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: "pending_answer",
              step: "review",
              preview_result: [{ title: "Recovered tender" }],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataHealingProvider({
      apiToken: "test-token",
      maxRetries: 0,
    });
    const progress = await provider.pollRefactorProgress("c_test_123");
    expect(progress).toEqual({
      status: "pending_answer",
      step: "review",
      previewResult: [{ title: "Recovered tender" }],
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("successfully resumes automation job with approve option", async () => {
    const mockFetch = vi.fn((url: string, options?: RequestInit) => {
      if (url.includes("/resume_automation_job")) {
        expect(options?.method).toBe("POST");
        expect(JSON.parse(String(options?.body))).toEqual({ message: true });
        return Promise.resolve(new Response("", { status: 200 }));
      }
      return Promise.reject(new Error("Unknown URL"));
    });

    vi.stubGlobal("fetch", mockFetch);

    const provider = new BrightDataHealingProvider({
      apiToken: "test-token",
      maxRetries: 0,
    });
    await provider.resumeAutomationJob("c_test_123", true);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("UnconfiguredBrightDataHealingProvider", () => {
  it("fails closed on trigger, poll, and resume", async () => {
    const provider = new UnconfiguredBrightDataHealingProvider();
    await expect(
      provider.triggerRefactor("c_test_123", "fix"),
    ).rejects.toBeInstanceOf(ExternalCollectionNotConfiguredError);
    await expect(
      provider.pollRefactorProgress("c_test_123"),
    ).rejects.toBeInstanceOf(ExternalCollectionNotConfiguredError);
    await expect(
      provider.resumeAutomationJob("c_test_123", true),
    ).rejects.toBeInstanceOf(ExternalCollectionNotConfiguredError);
  });
});
