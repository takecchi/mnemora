import type {
  Ctx,
  EventFilter,
  EventId,
  EventStore,
  MemoryEvent,
  NewMemoryEvent,
} from "@mnemora/core";
import { nextId } from "./id.js";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";

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
 * 空配列を持つ。
 *
 * **`memoryStore` を必須のコンストラクタ引数にしている（省略不可、ADR 0047）。**
 * `memory_events.memory_id → memories(id)` は外部キー（`kind = 'events_purged'` の
 * 場合のみ NULL）。`InMemoryVectorStore` が `InMemoryMemoryStore` を必須にしたのと
 * 同じ理由（ADR 0034）——省略できると「外部キーを実際に検査できる adapter」と
 * 「検査できない adapter」が同じ緑色の出力になる。
 */
export class InMemoryEventStore implements EventStore {
  constructor(
    private readonly memoryStore: InMemoryMemoryStore,
    private readonly events: MemoryEvent[] = [],
  ) {}

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    // 外部キー相当（ADR 0047）: `memoryId` が非 null なら実在する Memory を指さなければ
    // ならない。**NULL は拒まない**——`kind = 'events_purged'` は `memoryId` が無い
    // 正当なケースであり、他の kind であっても NULL 自体を本メソッドは咎めない
    // （0001_init.sql の CHECK 制約が禁じるのは「events_purged なのに非 NULL」の
    // 向きだけであり、その逆は禁じていない）。
    if (event.memoryId !== null) {
      const memory = await this.memoryStore.get(ctx, event.memoryId);
      if (!memory) {
        throw new Error(`InMemoryEventStore: memory not found: ${event.memoryId}`);
      }
    }
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
