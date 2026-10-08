import type {
  Ctx,
  EventFilter,
  EventId,
  EventStore,
  MemoryEvent,
  NewMemoryEvent,
} from "@mnemora/core";
import { assertWellFormedCtx } from "@mnemora/core";
import { nextId } from "./id.js";
import { assertQueryDate } from "./query-check.js";
import { assertStorableMemoryEvent } from "./memory-event-check.js";
import { replaceLoneSurrogates } from "./well-formed-text.js";
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";

/** `NewMemoryEvent` から永続化済みの `MemoryEvent` を組み立てる。イベントを積むすべての口がここを通る。 */
export function buildStoredMemoryEvent(ctx: Ctx, event: NewMemoryEvent): MemoryEvent {
  // 検査はここに置く: イベントを積むすべての口が通る合流点なので、1か所で全部を覆える。`event.at` の省略（`undefined`）は検査しない。
  assertStorableMemoryEvent(event);
  // 呼び手の入力と切り離して保存する。
  return structuredClone({
    id: nextId("evt"),
    tenantId: ctx.tenantId,
    // uuid の列は小文字の正規形で読み戻る（`@mnemora/postgres`）ので、小文字にそろえて積む。
    memoryId: event.memoryId,
    kind: event.kind,
    at: event.at ?? new Date(),
    actor: event.actor,
    // `text` 列なので、孤立サロゲートは U+FFFD に置き換える。
    digestSnapshot: replaceLoneSurrogates(event.digestSnapshot) ?? null,
    sizeBeforeBytes: event.sizeBeforeBytes ?? null,
    meta: event.meta,
  });
}

/**
 * `EventStore` のインメモリ・プレースホルダ実装。append-only（`update`/`delete` に相当するメソッドを持たない）。
 *
 * 第2引数に既存の配列を渡せる。省略（既定）では、`InMemoryMemoryStore` が自分の中で書くイベント
 * （forget・archive・purge・contested・supersede・unsuperseded・events_purged など）はこの store の `get`/`list` に出ない。
 * `@mnemora/postgres` と同じく全部を1か所で見るには、`memoryStore.events` を渡すこと:
 *
 * ```ts
 * const memoryStore = new InMemoryMemoryStore();
 * const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
 * ```
 *
 * `memoryStore` は必須: 省略できると、外部キーを検査できる adapter と検査できない adapter が同じ緑の出力になる。
 */
export class InMemoryEventStore implements EventStore {
  constructor(
    private readonly memoryStore: InMemoryMemoryStore,
    private readonly events: MemoryEvent[] = [],
  ) {}

  async append(ctx: Ctx, event: NewMemoryEvent): Promise<MemoryEvent> {
    assertWellFormedCtx(ctx);
    // 外部キー相当: 非 null の `memoryId` は実在する Memory を指す。NULL は拒まない（`events_purged` などで正当）。
    if (event.memoryId !== null) {
      // 大文字小文字は区別しない（Postgres は uuid を小文字にそろえて比べる）。断る message は渡された id のまま。
      const memory = await this.memoryStore.get(ctx, event.memoryId.toLowerCase());
      if (!memory) {
        throw new Error(`InMemoryEventStore: memory not found for tenant: ${event.memoryId}`);
      }
    }
    const stored = buildStoredMemoryEvent(ctx, event);
    this.events.push(stored);
    return structuredClone(stored);
  }

  async get(ctx: Ctx, id: EventId): Promise<MemoryEvent | null> {
    assertWellFormedCtx(ctx);
    // 大文字小文字は区別しない（Postgres は uuid 型の列で比べる）。
    const lowered = id.toLowerCase();
    const event = this.events.find((e) => e.id === lowered);
    if (!event || event.tenantId !== ctx.tenantId) {
      return null;
    }
    return structuredClone(event);
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    assertWellFormedCtx(ctx);
    // 読みの口の日時は下限（4714-11-24 BC）より前でも断らず、そのまま比べる（Postgres は下限へ寄せるが答えは同じ）。Invalid Date だけ断る。
    assertQueryDate("list", "since", filter.since);
    assertQueryDate("list", "until", filter.until);
    // `slice` の負数は「末尾から数えた除外」になり、ほぼ全件を静かに返す。Postgres が `LIMIT` で拒むのに揃え、先に弾く。
    if (filter.limit !== undefined && !Number.isInteger(filter.limit)) {
      throw new Error(`list: limit must be an integer (got ${filter.limit})`);
    }
    if (filter.limit !== undefined && filter.limit < 0) {
      throw new Error(`list: limit must not be negative (got ${filter.limit})`);
    }
    // `LIMIT` の bigint に収まらない値も Postgres は拒む。
    if (filter.limit !== undefined && filter.limit >= 2 ** 63) {
      throw new Error(`list: limit must fit in a Postgres bigint (got ${filter.limit})`);
    }
    const matched = this.events.filter((event) => {
      if (event.tenantId !== ctx.tenantId) {
        return false;
      }
      if (filter.memoryId !== undefined && event.memoryId !== filter.memoryId.toLowerCase()) {
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
    // `at` 昇順に並べてから `limit` を適用する。`this.events`（`InMemoryMemoryStore` と共有されうる）を in-place で壊さないよう、`filter()` の新しい配列を並べる。
    const sorted = matched.sort((a, b) => a.at.getTime() - b.at.getTime());
    return structuredClone(filter.limit !== undefined ? sorted.slice(0, filter.limit) : sorted);
  }
}
