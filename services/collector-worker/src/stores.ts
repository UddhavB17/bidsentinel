import type {
  QuarantinedExtraction,
  RecoveryEvidence,
  SourceHealth,
  TenderChangeEvent,
  TenderSnapshot,
} from "@bidsentinel/contracts";

export class InMemorySnapshotStore {
  readonly #items = new Map<string, TenderSnapshot[]>();

  append(snapshot: TenderSnapshot): void {
    const existing = this.#items.get(snapshot.tenderId) ?? [];
    this.#items.set(snapshot.tenderId, [
      ...existing,
      structuredClone(snapshot),
    ]);
  }

  latest(tenderId: string): TenderSnapshot | null {
    const snapshot = this.#items.get(tenderId)?.at(-1);
    return snapshot === undefined ? null : structuredClone(snapshot);
  }

  list(tenderId: string): TenderSnapshot[] {
    return structuredClone(this.#items.get(tenderId) ?? []);
  }
}

export class InMemoryQuarantineStore {
  readonly #items: QuarantinedExtraction[] = [];

  append(extraction: QuarantinedExtraction): void {
    this.#items.push(extraction);
  }

  listBySource(sourceId: string): QuarantinedExtraction[] {
    return this.#items.filter((item) => item.sourceId === sourceId);
  }
}

export class InMemoryChangeEventStore {
  readonly #items: TenderChangeEvent[] = [];

  append(event: TenderChangeEvent): void {
    this.#items.push(structuredClone(event));
  }

  list(): TenderChangeEvent[] {
    return structuredClone(this.#items);
  }
}

export class InMemoryRecoveryEvidenceStore {
  readonly #items: RecoveryEvidence[] = [];

  append(evidence: RecoveryEvidence): void {
    this.#items.push(structuredClone(evidence));
  }

  listBySource(sourceId: string): RecoveryEvidence[] {
    return structuredClone(
      this.#items.filter((item) => item.sourceId === sourceId),
    );
  }
}

export class InMemorySourceHealthStore {
  readonly #items = new Map<string, SourceHealth>();

  set(health: SourceHealth): void {
    this.#items.set(health.sourceId, structuredClone(health));
  }

  get(sourceId: string): SourceHealth | null {
    const health = this.#items.get(sourceId);
    return health === undefined ? null : structuredClone(health);
  }
}
