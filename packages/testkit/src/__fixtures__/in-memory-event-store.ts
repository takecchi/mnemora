import type {
  Ctx,
  EventFilter,
  EventId,
  EventStore,
  MemoryEvent,
  NewMemoryEvent,
} from "@mnemora/core";
import { nextId } from "./id.js";

/**
 * `NewMemoryEvent` から永続化済みの `MemoryEvent` を組み立てる。`InMemoryEventStore.append`
 * と `InMemoryMemoryStore.updateStatusWithEvent`（ADR 0031）の両方がこれを使う——
 * 「同じ形の memory_events 行を作る」というロジックを2箇所に複製すると、片方だけ直して
 * もう片方を直し忘れる食い違いを作りかねない。
 */
export function buildStoredMemoryEvent(ctx: Ctx, event: NewMemoryEvent): MemoryEvent {
  return {
    id: nextId("evt"),
    tenantId: ctx.tenantId,
    memoryId: event.memoryId,
    kind: event.kind,
    at: event.at ?? new Date(),
    actor: event.actor,
    digestSnapshot: event.digestSnapshot ?? null,
    sizeBeforeBytes: event.sizeBeforeBytes ?? null,
    meta: event.meta,
  };
}

/**
 * `EventStore` のインメモリ・プレースホルダ実装。append-only を実装としても徹底する
 * （`update`/`delete` に相当するメソッドを持たない）。
 *
 * ADR 0031: コンストラクタで既存の配列を渡せる（`InMemoryOutboxStore` が
 * `InMemoryMemoryStore.outboxJobs` を共有するのと同じパターン）。
 * `InMemoryMemoryStore.updateStatusWithEvent` が積んだイベントを、同じ配列を渡した
 * `InMemoryEventStore` からも `get`/`list` できるようにするため。省略時は独立した
 * 空配列を持つ（既存の `new InMemoryEventStore()` の呼び出しは今まで通り動く）。
 */
export class InMemoryEventStore implements EventStore {
  constructor(private readonly events: MemoryEvent[] = []) {}

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    const stored = buildStoredMemoryEvent(ctx, event);
    this.events.push(stored);
    return stored;
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    const event = this.events.find((e) => e.id === id);
    if (!event || event.tenantId !== ctx.tenantId) {
      return null;
    }
    return event;
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    const matched = this.events.filter((event) => {
      if (event.tenantId !== ctx.tenantId) {
        return false;
      }
      if (filter.memoryId !== undefined && event.memoryId !== filter.memoryId) {
        return false;
      }
      if (filter.kind !== undefined && event.kind !== filter.kind) {
        return false;
      }
      if (filter.since !== undefined && event.at < filter.since) {
        return false;
      }
      if (filter.until !== undefined && event.at > filter.until) {
        return false;
      }
      return true;
    });
    // `EventStore.list` の契約（packages/core/src/interfaces/event-store.ts）どおり
    // `at` 昇順に並べ替えてから `limit` を適用する。`filter()` は新しい配列を返すので、
    // その配列を sort() しても `this.events`（InMemoryMemoryStore と共有されうる、
    // ADR 0031）を in-place で破壊しない。
    const sorted = matched.sort((a, b) => a.at.getTime() - b.at.getTime());
    return filter.limit !== undefined ? sorted.slice(0, filter.limit) : sorted;
  }
}
