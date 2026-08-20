import { randomUUID } from "node:crypto";

import {
  TenderChangeEventSchema,
  type Corrigendum,
  type TenderChange,
  type TenderChangeEvent,
  type TenderSnapshot,
} from "@bidsentinel/contracts";
import { stableStringify } from "@bidsentinel/validation";

function indexCorrigenda(items: Corrigendum[]): Map<string, Corrigendum> {
  return new Map(items.map((item) => [item.id, item]));
}

export function detectTenderChanges(
  previous: TenderSnapshot,
  current: TenderSnapshot,
  detectedAt: string,
  changeEventId = randomUUID(),
): TenderChangeEvent | null {
  const changes: TenderChange[] = [];

  if (previous.tender.status !== current.tender.status) {
    changes.push({
      kind: "status",
      before: previous.tender.status,
      after: current.tender.status,
    });
  }

  if (
    previous.tender.submissionDeadline !== current.tender.submissionDeadline
  ) {
    changes.push({
      kind: "deadline",
      before: previous.tender.submissionDeadline,
      after: current.tender.submissionDeadline,
    });
  }

  const previousCorrigenda = indexCorrigenda(previous.tender.corrigenda);
  const currentCorrigenda = indexCorrigenda(current.tender.corrigenda);
  const added = current.tender.corrigenda.filter(
    (item) => !previousCorrigenda.has(item.id),
  );
  const removed = previous.tender.corrigenda.filter(
    (item) => !currentCorrigenda.has(item.id),
  );
  const updated = current.tender.corrigenda.flatMap((currentItem) => {
    const previousItem = previousCorrigenda.get(currentItem.id);
    if (
      previousItem === undefined ||
      stableStringify(previousItem) === stableStringify(currentItem)
    ) {
      return [];
    }

    return [{ before: previousItem, after: currentItem }];
  });

  if (added.length > 0 || removed.length > 0 || updated.length > 0) {
    changes.push({ kind: "corrigendum", added, removed, updated });
  }

  if (changes.length === 0) {
    return null;
  }

  return TenderChangeEventSchema.parse({
    schemaVersion: 1,
    changeEventId,
    tenderId: current.tenderId,
    sourceId: current.sourceId,
    fromSnapshotId: previous.snapshotId,
    toSnapshotId: current.snapshotId,
    detectedAt,
    changes,
  });
}
