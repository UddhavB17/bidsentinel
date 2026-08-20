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
    this.#items.set(snapshot.tenderId, [...existing, snapshot]);
  }

  latest(tenderId: string): TenderSnapshot | null {
    return this.#items.get(tenderId)?.at(-1) ?? null;
  }

  list(tenderId: string): TenderSnapshot[] {
    return [...(this.#items.get(tenderId) ?? [])];
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
    this.#items.push(event);
  }

  list(): TenderChangeEvent[] {
    return [...this.#items];
  }
}

export class InMemoryRecoveryEvidenceStore {
  readonly #items: RecoveryEvidence[] = [];

  append(evidence: RecoveryEvidence): void {
    this.#items.push(evidence);
  }

  listBySource(sourceId: string): RecoveryEvidence[] {
    return this.#items.filter((item) => item.sourceId === sourceId);
  }
}

export class InMemorySourceHealthStore {
  readonly #items = new Map<string, SourceHealth>();

  set(health: SourceHealth): void {
    this.#items.set(health.sourceId, health);
  }

  get(sourceId: string): SourceHealth | null {
    return this.#items.get(sourceId) ?? null;
  }
}
