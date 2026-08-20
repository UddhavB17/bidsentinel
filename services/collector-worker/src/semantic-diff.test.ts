import { describe, expect, it } from "vitest";

import {
  SnapshotSourceHealthSchema,
  TenderSnapshotSchema,
  type SnapshotSourceHealth,
  type Tender,
  type TenderSnapshot,
} from "@bidsentinel/contracts";
import { validTenderFixture } from "@bidsentinel/contracts/fixtures";

import { diffTenderSnapshots } from "./semantic-diff.js";

interface SnapshotOptions {
  version?: number;
  observedAt?: string;
  deadline?: string | null;
  status?: Tender["status"];
  documents?: Tender["documents"];
  corrigenda?: Tender["corrigenda"];
}

function makeSnapshot(options: SnapshotOptions = {}): TenderSnapshot {
  const version = options.version ?? 1;
  const observedAt =
    options.observedAt ??
    (version === 1 ? "2026-08-20T05:00:00.000Z" : "2026-08-21T05:00:00.000Z");
  const suffix = String(version).padStart(12, "0");
  const tender: Tender = {
    ...validTenderFixture,
    status: options.status ?? validTenderFixture.status,
    submissionDeadline:
      options.deadline === undefined
        ? validTenderFixture.submissionDeadline
        : options.deadline,
    documents: options.documents ?? validTenderFixture.documents,
    corrigenda: options.corrigenda ?? validTenderFixture.corrigenda,
    observedAt,
  };

  return TenderSnapshotSchema.parse({
    schemaVersion: 1,
    snapshotId: `00000000-0000-4000-8000-${suffix}`,
    tenderId: tender.tenderId,
    sourceId: tender.sourceId,
    version,
    observedAt,
    payloadHash: (version % 10).toString().repeat(64),
    tender,
  });
}

function makeHealth(
  overrides: Partial<SnapshotSourceHealth> = {},
): SnapshotSourceHealth {
  return SnapshotSourceHealthSchema.parse({
    schemaVersion: 1,
    sourceId: "gem",
    state: "healthy",
    checkedAt: "2026-08-21T05:00:00.000Z",
    previousRecordCount: 100,
    currentRecordCount: 100,
    consecutiveEmptyResults: 0,
    consecutiveTenderAbsences: 0,
    ...overrides,
  });
}

function kinds(result: ReturnType<typeof diffTenderSnapshots>): string[] {
  return result.events.map((event) => event.kind);
}

describe("diffTenderSnapshots", () => {
  it("emits new_tender for the first verified snapshot", () => {
    const current = makeSnapshot();
    const result = diffTenderSnapshots({
      previous: null,
      current,
      sourceHealth: makeHealth({
        previousRecordCount: 0,
        currentRecordCount: 1,
      }),
    });

    expect(kinds(result)).toEqual(["new_tender"]);
    expect(result.decision).toBe("accept_current");
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(current.snapshotId);
  });

  it("treats two null deadlines as no_change", () => {
    const previous = makeSnapshot({ deadline: null });
    const current = makeSnapshot({ version: 2, deadline: null });
    const result = diffTenderSnapshots({
      previous,
      current,
      sourceHealth: makeHealth(),
    });

    expect(kinds(result)).toEqual(["no_change"]);
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(current.snapshotId);
  });

  it.each([
    {
      name: "null to a date",
      before: null,
      after: "2026-09-15T12:00:00.000Z",
    },
    {
      name: "one date to another",
      before: "2026-09-15T12:00:00.000Z",
      after: "2026-09-16T12:00:00.000Z",
    },
    {
      name: "a date to null",
      before: "2026-09-15T12:00:00.000Z",
      after: null,
    },
  ])("emits deadline_changed for $name", ({ before, after }) => {
    const result = diffTenderSnapshots({
      previous: makeSnapshot({ deadline: before }),
      current: makeSnapshot({ version: 2, deadline: after }),
      sourceHealth: makeHealth(),
    });

    expect(kinds(result)).toEqual(["deadline_changed"]);
    expect(result.events[0]).toMatchObject({
      before,
      after,
      evidence: { rule: "deadline_instant_changed" },
    });
  });

  it("compares deadline instants rather than timezone formatting", () => {
    const result = diffTenderSnapshots({
      previous: makeSnapshot({
        deadline: "2026-09-15T12:00:00.000Z",
      }),
      current: makeSnapshot({
        version: 2,
        deadline: "2026-09-15T17:30:00.000+05:30",
      }),
      sourceHealth: makeHealth(),
    });

    expect(kinds(result)).toEqual(["no_change"]);
  });

  it("emits status_changed with before/after evidence", () => {
    const result = diffTenderSnapshots({
      previous: makeSnapshot({ status: "open" }),
      current: makeSnapshot({ version: 2, status: "closed" }),
      sourceHealth: makeHealth(),
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        kind: "status_changed",
        before: "open",
        after: "closed",
        evidence: expect.objectContaining({
          rule: "status_value_changed",
          facts: { beforeStatus: "open", afterStatus: "closed" },
        }),
      }),
    ]);
  });

  it("emits one corrigendum_added event for each new reference", () => {
    const corrigendum: Tender["corrigenda"][number] = {
      id: "corrigendum-1",
      title: "Submission deadline extension",
      description: "The submission deadline is extended.",
      publishedAt: "2026-08-21T03:30:00.000Z",
      url: "https://example.gov.test/corrigenda/1",
    };
    const result = diffTenderSnapshots({
      previous: makeSnapshot(),
      current: makeSnapshot({ version: 2, corrigenda: [corrigendum] }),
      sourceHealth: makeHealth(),
    });

    expect(kinds(result)).toEqual(["corrigendum_added"]);
    expect(result.events[0]).toMatchObject({
      corrigendum,
      evidence: {
        rule: "new_corrigendum_reference",
        facts: {
          corrigendumId: "corrigendum-1",
          publishedAt: "2026-08-21T03:30:00.000Z",
        },
      },
    });
  });

  it("rejects duplicate document references without replacing the baseline", () => {
    const previous = makeSnapshot();
    const baseDocument = validTenderFixture.documents[0];
    if (baseDocument === undefined) {
      throw new Error("Fixture must include a document");
    }
    const duplicateDocuments: Tender["documents"] = [
      baseDocument,
      { ...baseDocument },
    ];
    const current = makeSnapshot({
      version: 2,
      documents: duplicateDocuments,
    });
    const result = diffTenderSnapshots({
      previous,
      current,
      sourceHealth: makeHealth(),
    });

    expect(kinds(result)).toEqual(["invalid_snapshot"]);
    expect(result.decision).toBe("retain_previous");
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(previous.snapshotId);
    const event = result.events[0];
    expect(event?.kind).toBe("invalid_snapshot");
    if (event?.kind === "invalid_snapshot") {
      expect(
        event.issues.some((issue) => issue.code === "duplicate_reference"),
      ).toBe(true);
      expect(event.evidence.rule).toBe("snapshot_rejected");
    }
  });

  it("rejects a record-count collapse without replacing the baseline", () => {
    const previous = makeSnapshot();
    const current = makeSnapshot({ version: 2, status: "closed" });
    const result = diffTenderSnapshots({
      previous,
      current,
      sourceHealth: makeHealth({
        previousRecordCount: 200,
        currentRecordCount: 20,
      }),
    });

    expect(kinds(result)).toEqual(["invalid_snapshot"]);
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(previous.snapshotId);
    expect(result.events[0]).toMatchObject({
      issues: [expect.objectContaining({ code: "record_count_collapse" })],
      evidence: {
        facts: expect.objectContaining({
          previousRecordCount: 200,
          currentRecordCount: 20,
        }),
      },
    });
  });

  it("rejects a temporary empty result instead of removing the tender", () => {
    const previous = makeSnapshot();
    const result = diffTenderSnapshots({
      previous,
      current: null,
      sourceHealth: makeHealth({
        currentRecordCount: 0,
        consecutiveEmptyResults: 1,
        consecutiveTenderAbsences: 1,
      }),
    });

    expect(kinds(result)).toEqual(["invalid_snapshot"]);
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(previous.snapshotId);
    expect(result.events[0]).toMatchObject({
      issues: [expect.objectContaining({ code: "temporary_empty_result" })],
      evidence: {
        facts: expect.objectContaining({
          previousRecordCount: 100,
          currentRecordCount: 0,
          consecutiveEmptyResults: 1,
        }),
      },
    });
  });

  it("rejects snapshots from an unhealthy source", () => {
    const previous = makeSnapshot();
    const result = diffTenderSnapshots({
      previous,
      current: makeSnapshot({ version: 2, status: "closed" }),
      sourceHealth: makeHealth({ state: "degraded" }),
    });

    expect(kinds(result)).toEqual(["invalid_snapshot"]);
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(previous.snapshotId);
    expect(result.events[0]).toMatchObject({
      issues: [expect.objectContaining({ code: "source_not_healthy" })],
    });
  });

  it("emits tender_removed only after confirmed absence on a healthy result", () => {
    const previous = makeSnapshot();
    const result = diffTenderSnapshots({
      previous,
      current: null,
      sourceHealth: makeHealth({
        currentRecordCount: 99,
        consecutiveTenderAbsences: 2,
      }),
    });

    expect(kinds(result)).toEqual(["tender_removed"]);
    expect(result.decision).toBe("mark_removed");
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(previous.snapshotId);
    expect(result.events[0]?.evidence.facts).toMatchObject({
      absenceConfirmations: 2,
      requiredConfirmations: 2,
    });
  });

  it("retains the baseline while a non-empty absence is unconfirmed", () => {
    const previous = makeSnapshot();
    const result = diffTenderSnapshots({
      previous,
      current: null,
      sourceHealth: makeHealth({
        currentRecordCount: 99,
        consecutiveTenderAbsences: 1,
      }),
    });

    expect(kinds(result)).toEqual(["no_change"]);
    expect(result.decision).toBe("retain_previous");
    expect(result.lastVerifiedSnapshot?.snapshotId).toBe(previous.snapshotId);
  });

  it("attaches evidence to every event in a multi-change result", () => {
    const corrigendum: Tender["corrigenda"][number] = {
      id: "corrigendum-1",
      title: "Revised terms",
      description: null,
      publishedAt: "2026-08-21T03:30:00.000Z",
      url: null,
    };
    const result = diffTenderSnapshots({
      previous: makeSnapshot(),
      current: makeSnapshot({
        version: 2,
        deadline: "2026-09-20T12:00:00.000Z",
        status: "closed",
        corrigenda: [corrigendum],
      }),
      sourceHealth: makeHealth(),
    });

    expect(kinds(result)).toEqual([
      "deadline_changed",
      "status_changed",
      "corrigendum_added",
    ]);
    expect(
      result.events.every(
        (event) =>
          event.evidence.engineVersion === "semantic-diff-v1" &&
          event.evidence.previousSnapshotId !== null &&
          event.evidence.currentSnapshotId !== null,
      ),
    ).toBe(true);
  });
});
