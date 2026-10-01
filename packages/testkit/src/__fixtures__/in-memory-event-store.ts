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
import type { InMemoryMemoryStore } from "./in-memory-memory-store.js";

/**
 * `NewMemoryEvent` から永続化済みの `MemoryEvent` を組み立てる。`InMemoryEventStore.append`
 * と `InMemoryMemoryStore.updateStatusWithEvent`（ADR 0031）の両方がこれを使う——
 * 「同じ形の memory_events 行を作る」というロジックを2箇所に複製すると、片方だけ直して
 * もう片方を直し忘れる食い違いを作りかねない。
 */
export function buildStoredMemoryEvent(ctx: Ctx, event: NewMemoryEvent): MemoryEvent {
  // Issue #807: `memory_events.at` は Postgres の `timestamptz` 列であり、Invalid Date
  // （`.getTime()` が `NaN`）を渡すと `PostgresEventStore.append` はクエリ実行時に
  // `invalid input syntax for type timestamp with time zone` で例外を投げる（実測）。
  // `event.at` が省略されている（`undefined`）場合は「無い」であって Invalid Date では
  // ないので検査しない——下の `?? new Date()` で現在時刻になる。この関数は
  // `InMemoryEventStore.append` だけでなく `InMemoryMemoryStore` の
  // `updateStatusWithEvent`/`purgeMemory`/`supersedeWithNewMemories` 等、イベントを積む
  // すべての口が通る単一の合流点であり、ここで検査すればそれらすべてを一度に覆える。
  assertStorableMemoryEvent(event);
  // Issue #1108: 呼び手の入力（`at`・`actor`・`meta`）と切り離して保存する。
  return structuredClone({
    id: nextId("evt"),
    tenantId: ctx.tenantId,
    // ADR 0469: uuid の列は小文字の正規形で読み戻る（`@mnemora/postgres`）。大文字で渡された `memoryId` も小文字にそろえて積む。
    memoryId: event.memoryId === null ? null : event.memoryId.toLowerCase(),
    kind: event.kind,
    at: event.at ?? new Date(),
    actor: event.actor,
    digestSnapshot: event.digestSnapshot ?? null,
    sizeBeforeBytes: event.sizeBeforeBytes ?? null,
    meta: event.meta,
  });
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
 * ⚠ **既定の組み立て（第2引数を省略）では、`InMemoryMemoryStore` が自分の中で書くイベントは
 * この store の `get`/`list` に出ない。**`@mnemora/postgres` は1つの `memory_events` 表なので、
 * 2実装で見えるものが割れる。store の中で書くのは、`updateStatusWithEvent`（forget・
 * restoreArchived など）・`supersedeWithNewMemories`（consolidate・reextract の superseded）・
 * `markContestedPair`・`resolveContestedPair`・`resolveOrphanedContested`・
 * `restoreSupersededBy`（unsuperseded）・`purgeMemory`（purged）・`archiveDecayed`（archived）・
 * `purgeExpiredEvents`（events_purged）の各口である（`runtime` が `EventStore.append` で積む
 * `created` などは、どちらの組み立てでもこの store に入る）。**Postgres と同じく全部を1か所で
 * 見るには、第2引数に `memoryStore.events` を渡すこと:**
 *
 * ```ts
 * const memoryStore = new InMemoryMemoryStore();
 * const eventStore = new InMemoryEventStore(memoryStore, memoryStore.events);
 * ```
 *
 * 組み立て方（既定）は変えていない（2026-09-27、クローン miku の判断。今の振る舞いを記録した）。
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
    assertWellFormedCtx(ctx);
    // 外部キー相当（ADR 0047）: `memoryId` が非 null なら実在する Memory を指さなければ
    // ならない。**NULL は拒まない**——`kind = 'events_purged'` は `memoryId` が無い
    // 正当なケースであり、他の kind であっても NULL 自体を本メソッドは咎めない
    // （0001_init.sql の CHECK 制約が禁じるのは「events_purged なのに非 NULL」の
    // 向きだけであり、その逆は禁じていない）。
    if (event.memoryId !== null) {
      // ADR 0475: 大文字小文字は区別しない（`PostgresEventStore.append` は uuid を小文字にそろえて比べる。この fixture の id は小文字の `mem-N`）。
      // 断るときの message は渡された id のまま。
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
    const event = this.events.find((e) => e.id === id);
    if (!event || event.tenantId !== ctx.tenantId) {
      return null;
    }
    return structuredClone(event);
  }

  async list(ctx: Ctx, filter: EventFilter): Promise<MemoryEvent[]> {
    assertWellFormedCtx(ctx);
    // 条件の日時は Postgres の timestamptz へ変換できなければならない（query-check.ts）。
    assertQueryDate("list", "since", filter.since);
    assertQueryDate("list", "until", filter.until);
    // `PostgresEventStore.list` は `filter.limit` を生 SQL の `LIMIT` にそのまま渡すため、
    // 負数を渡すと Postgres 自身が `LIMIT must not be negative` で例外を投げる
    // （実測済み。in-memory-vector-store.ts の同種の注記参照）。ここで検査せず
    // `sorted.slice(0, filter.limit)` へ渡すと、`Array.prototype.slice` の負数引数は
    // 「末尾から数えた除外」という別の意味になり、ほぼ全件を静かに返してしまう
    // ——クエリを投げる前に弾く Postgres 側に揃える。
    //
    // ⚠ 負数だけでは足りない——`LIMIT` の SQL パラメータは bigint 型であり、`NaN`/
    // `Infinity`/非整数を渡すと Postgres は `invalid input syntax for type bigint: "NaN"`
    // の形で例外を投げる（実測済み。in-memory-vector-store.ts の同種の注記参照）。
    // 既存の「負数」ガード（上の段落）とは別の例外メッセージにして、PR #811 が固定した
    // 「負数は例外」の回帰テストの文言を変えずに済ませる。
    if (filter.limit !== undefined && !Number.isInteger(filter.limit)) {
      throw new Error(`list: limit must be an integer (got ${filter.limit})`);
    }
    if (filter.limit !== undefined && filter.limit < 0) {
      throw new Error(`list: limit must not be negative (got ${filter.limit})`);
    }
    // `LIMIT` の bigint に収まらない値（2^63 以上）も Postgres は拒む（実測: `value
    // "9223372036854776000" is out of range for type bigint`）。
    if (filter.limit !== undefined && filter.limit >= 2 ** 63) {
      throw new Error(`list: limit must fit in a Postgres bigint (got ${filter.limit})`);
    }
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
    return structuredClone(filter.limit !== undefined ? sorted.slice(0, filter.limit) : sorted);
  }
}
