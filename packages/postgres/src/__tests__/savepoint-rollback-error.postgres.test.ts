import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, NewMemory } from "@mnemora/core";
import { ContestedWithoutCompanionError, createRuntime } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { closePostgresClient, createPostgresClient, type PostgresClient } from "../client.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { killConnectionBeforeStatement, rejectStatement } from "./pool-fault-injection.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * ADR 0451: `createMemoriesWithOutboxAndEvents` は候補ごとに SAVEPOINT（drizzle の入れ子の `tx.transaction`）を張る。
 * drizzle-orm 0.45.2 の `NodePgTransaction.transaction` は `catch { await rollback to savepoint; throw err }` で、
 * `rollback to savepoint` が投げると元のエラーを消す（ADR 0444 の `begin`・`rollback` と同じ形）。以前は、その失敗が
 * `dropped` に積まれ、全候補が落ちたら投げられ、一部が成功したら `created` の `meta` に載った。
 *
 * 直した形: 巻き戻しそのものが失敗したら、続けず・`dropped` に積まず、**元のエラー**を投げる（外側のトランザクションごと戻る）。
 * 失敗は元のエラーの `cause`（空いていれば）か `rollbackError` に残す。新しい例外の型は作らない。
 * rollback が成功する悪い候補は、従来どおり `dropped` に積んで他を書く。
 *
 * 直列の群に置く（`Client.prototype.query` の差し替えと `pg_terminate_backend`。`vitest.config.mts` の `SERIAL_TEST_FILES`）。
 */
const ctx: Ctx = { tenantId: "savepoint-rollback-error" };
const APP = "adr0451";
const INJECTED = "INJECTED: rollback to savepoint failure";
const ROLLBACK_TO_SAVEPOINT = (text: string) => /^\s*rollback to savepoint\b/i.test(text);

function good(hash: string): NewMemory {
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    content: `good ${hash}`,
    contentHash: hash,
    digest: hash,
  });
}
/**
 * DB の CHECK 制約（`memories_strength_range`: `strength` は `(0, 1]`）が拒む（SQLSTATE 23514。トランザクションが aborted になる）。
 * ADR 0499 より前は、本文の NUL（22021）をここに使っていた。いまは NUL を DB に触れる前の名指しの例外で断る
 * （トランザクションは aborted にならない）ので、「DB の失敗でトランザクションが aborted になる」候補は別の値で作る。
 * 関数名の `nul` は、この歯の各 it の名前（悪い候補）を変えないために残した。
 */
function nul(hash: string): NewMemory {
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    content: `bad ${hash}`,
    contentHash: hash,
    digest: hash,
    strength: 2,
  });
}
/** `status: "contested"` で相手が無い（SQL を撃つ前に `ContestedWithoutCompanionError`）。 */
function contestedWithoutCompanion(hash: string): NewMemory {
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    content: `contested ${hash}`,
    contentHash: hash,
    digest: hash,
    status: "contested",
  });
}

describe("createMemoriesWithOutboxAndEvents: savepoint の rollback が失敗しても元のエラーを投げる（ADR 0451）", () => {
  let admin: PostgresClient;
  let victimClient: PostgresClient;
  let store: PostgresMemoryStore;
  let ghostCount: () => Promise<{ memories: number; events: number; outbox: number }>;

  beforeAll(async () => {
    await getTestClient();
    admin = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: "adr0451-admin",
    });
    ghostCount = async () => {
      const q = async (table: string) =>
        Number(
          (
            await admin.pool.query(`SELECT count(*) AS c FROM ${table} WHERE tenant_id = $1`, [
              ctx.tenantId,
            ])
          ).rows[0].c,
        );
      return {
        memories: await q("memories"),
        events: await q("memory_events"),
        outbox: await q("outbox"),
      };
    };
  });
  afterAll(async () => {
    await Promise.race([closePostgresClient(victimClient), sleep(2000)]);
    await closePostgresClient(admin);
    await closeTestClient();
  });

  async function fresh(): Promise<void> {
    await resetTestDatabase();
    if (victimClient !== undefined) {
      await Promise.race([closePostgresClient(victimClient), sleep(2000)]);
    }
    victimClient = createPostgresClient(requireDatabaseUrl(), {
      max: 2,
      application_name: APP,
      onPoolError: () => {},
    });
    store = new PostgresMemoryStore(victimClient.db);
  }

  function write(news: NewMemory[]) {
    const seen: Array<ReadonlyArray<{ index: number; error: unknown }>> = [];
    const promise = store.createMemoriesWithOutboxAndEvents(
      ctx,
      news.map((input) => ({ input, jobKinds: ["embed"] })),
      (memory, dropped) => {
        seen.push(dropped);
        return buildNewMemoryEventFixture({
          tenantId: ctx.tenantId,
          memoryId: memory.id,
          meta: { droppedCount: dropped.length },
        });
      },
    );
    return { promise, seen };
  }

  /** `cause` の連鎖の message を、外側から順に並べる（drizzle は元の失敗を `DrizzleQueryError` で包む）。 */
  const chain = (error: unknown): string[] => {
    const out: string[] = [];
    let x: unknown = error;
    for (let i = 0; i < 6 && x instanceof Error; i++) {
      out.push(x.message);
      x = x.cause;
    }
    return out;
  };

  const innermostCode = (error: unknown): string | undefined => {
    let x: unknown = error;
    let code: string | undefined;
    for (let i = 0; i < 6 && x instanceof Error; i++) {
      const c = (x as { code?: unknown }).code;
      if (typeof c === "string") code = c;
      x = x.cause;
    }
    return code;
  };

  it("S1 全候補が悪く、rollback to savepoint も失敗: 投げられるのは元の 23514。失敗は rollbackError に残り、何も書かれない", async () => {
    await fresh();
    const restore = rejectStatement({
      applicationName: APP,
      matches: ROLLBACK_TO_SAVEPOINT,
      error: new Error(INJECTED),
    });
    let error: unknown;
    try {
      error = await write([nul("a"), nul("b")]).promise.catch((e: unknown) => e);
    } finally {
      restore();
    }
    expect(error).toBeInstanceOf(Error);
    expect(innermostCode(error)).toBe("23514");
    expect((error as Error).message).not.toMatch(/rollback to savepoint/i);
    // drizzle の DrizzleQueryError は cause が埋まっているので、巻き戻しの失敗は rollbackError に置く。
    expect(chain((error as { rollbackError?: unknown }).rollbackError)).toContain(INJECTED);
    expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
  });

  it("S2 良い→悪い、rollback to savepoint も失敗: 25P02（aborted）ではなく元の 23514 が投げられ、良い候補も残らない", async () => {
    await fresh();
    const restore = rejectStatement({
      applicationName: APP,
      matches: ROLLBACK_TO_SAVEPOINT,
      error: new Error(INJECTED),
    });
    let error: unknown;
    try {
      error = await write([good("a"), nul("b")]).promise.catch((e: unknown) => e);
    } finally {
      restore();
    }
    expect(error).toBeInstanceOf(Error);
    expect(innermostCode(error)).toBe("23514");
    expect(innermostCode(error)).not.toBe("25P02");
    expect(chain((error as { rollbackError?: unknown }).rollbackError)).toContain(INJECTED);
    expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
  });

  it("S3 良い→JS 側で落ちる候補（トランザクションは生きている）、rollback も失敗: 正常終了せず、元の ContestedWithoutCompanionError が投げられ、何も残らない", async () => {
    await fresh();
    const restore = rejectStatement({
      applicationName: APP,
      matches: ROLLBACK_TO_SAVEPOINT,
      error: new Error(INJECTED),
    });
    let error: unknown;
    let seen: unknown[] | undefined;
    try {
      const w = write([good("a"), contestedWithoutCompanion("b")]);
      seen = w.seen;
      error = await w.promise.then(
        () => "RESOLVED",
        (e: unknown) => e,
      );
    } finally {
      restore();
    }
    expect(error).toBeInstanceOf(ContestedWithoutCompanionError);
    // 元のエラーは cause が空だったので、巻き戻しの失敗は cause に置く。
    expect(chain((error as Error).cause)).toContain(INJECTED);
    expect(seen).toEqual([]); // `created` を積むところまで進んでいない
    expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
  });

  it("S6 最初の候補の outbox INSERT がクライアント側だけで失敗し、rollback も失敗: 記憶だけ残る行（ghost）を作らず、全体が戻る", async () => {
    await fresh();
    const outboxFailure = new Error("INJECTED: outbox INSERT failure (client side)");
    const restoreOutbox = rejectStatement({
      applicationName: APP,
      matches: (text) => /INSERT INTO outbox/i.test(text),
      error: outboxFailure,
      times: 1,
    });
    const restoreRollback = rejectStatement({
      applicationName: APP,
      matches: ROLLBACK_TO_SAVEPOINT,
      error: new Error(INJECTED),
    });
    let error: unknown;
    try {
      error = await write([good("a"), good("b")]).promise.then(
        () => "RESOLVED",
        (e: unknown) => e,
      );
    } finally {
      restoreRollback();
      restoreOutbox();
    }
    // 元の失敗（drizzle が DrizzleQueryError で包んでいる）が届き、巻き戻しの失敗は rollbackError に残る。
    expect(chain(error)).toContain(outboxFailure.message);
    expect(chain(error)).not.toContain(INJECTED);
    expect(chain((error as { rollbackError?: unknown }).rollbackError)).toContain(INJECTED);
    expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
  });

  it("release savepoint の失敗: その候補を dropped に積んで続けず、その失敗を投げる（何も残らない）", async () => {
    await fresh();
    const releaseFailure = new Error("INJECTED: release savepoint failure");
    const restore = rejectStatement({
      applicationName: APP,
      matches: (text) => /^\s*release savepoint\b/i.test(text),
      error: releaseFailure,
      times: 1,
    });
    let error: unknown;
    try {
      error = await write([good("a"), good("b")]).promise.then(
        () => "RESOLVED",
        (e: unknown) => e,
      );
    } finally {
      restore();
    }
    expect(chain(error)).toContain(releaseFailure.message);
    expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
  });

  it("悪い候補（rollback は成功して dropped）のあとの良い候補で release savepoint が失敗: 前の候補の失敗ではなく、release の失敗を投げる（何も残らない）", async () => {
    await fresh();
    const releaseFailure = new Error("INJECTED: release savepoint failure");
    const restore = rejectStatement({
      applicationName: APP,
      matches: (text) => /^\s*release savepoint\b/i.test(text),
      error: releaseFailure,
      times: 1,
    });
    let error: unknown;
    try {
      error = await write([nul("a"), good("b")]).promise.then(
        () => "RESOLVED",
        (e: unknown) => e,
      );
    } finally {
      restore();
    }
    expect(error).not.toBe("RESOLVED");
    expect(chain(error)).toContain(releaseFailure.message);
    // 前の候補（a）の DB の拒否（23514）が、いまの失敗として投げられていない。
    expect(innermostCode(error)).not.toBe("23514");
    expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
  });

  it("接続ごと切られた（実際の kill）: 元の 23514 が投げられ、pool は枯れない", async () => {
    await fresh();
    const restore = killConnectionBeforeStatement({
      admin: admin.pool,
      applicationName: APP,
      matches: ROLLBACK_TO_SAVEPOINT,
    });
    let error: unknown;
    try {
      error = await write([nul("a"), good("b")]).promise.catch((e: unknown) => e);
    } finally {
      restore();
    }
    expect(error).toBeInstanceOf(Error);
    expect(innermostCode(error)).toBe("23514");
    expect((error as Error).message).not.toMatch(/rollback to savepoint/i);
    expect(victimClient.pool.totalCount - victimClient.pool.idleCount).toBe(0);
    expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
  });

  describe("やりすぎの歯: rollback が成功する悪い候補は、従来どおり dropped に積んで他を書く", () => {
    it("悪い（DB が拒む）候補: dropped に 23514、良い候補は書かれ created の meta に落とした数。rollbackError・cause の足しは無い", async () => {
      await fresh();
      const w = write([good("a"), nul("b"), good("c")]);
      const result = await w.promise;
      expect(result.written.map((e) => e.index)).toEqual([0, 2]);
      expect(result.dropped.map((d) => d.index)).toEqual([1]);
      const droppedError = result.dropped[0]!.error;
      expect(innermostCode(droppedError)).toBe("23514");
      expect("rollbackError" in (droppedError as object)).toBe(false);
      expect(w.seen.every((d) => d.length === 1)).toBe(true);
      const c = await ghostCount();
      expect(c.memories).toBe(2);
      expect(c.events).toBe(2);
    });

    it("JS 側で落ちる候補: dropped の error は ContestedWithoutCompanionError そのもの（cause なし）", async () => {
      await fresh();
      const result = await write([contestedWithoutCompanion("a"), good("b")]).promise;
      expect(result.written.map((e) => e.index)).toEqual([1]);
      const droppedError = result.dropped[0]!.error;
      expect(droppedError).toBeInstanceOf(ContestedWithoutCompanionError);
      expect((droppedError as Error).cause).toBeUndefined();
      expect("rollbackError" in (droppedError as object)).toBe(false);
    });

    it("全候補が悪く rollback は成功: 最初の候補のエラーがそのまま投げられる（今までどおり）", async () => {
      await fresh();
      const error: unknown = await write([nul("a"), nul("b")]).promise.catch((e: unknown) => e);
      expect(innermostCode(error)).toBe("23514");
      expect("rollbackError" in (error as object)).toBe(false);
      expect(await ghostCount()).toEqual({ memories: 0, events: 0, outbox: 0 });
    });
  });

  describe("runtime.observe 経由", () => {
    function runtimeOn(client: PostgresClient, jsSideFailure = false) {
      const llm: LLMProvider = {
        complete: async () => ({ content: "unused" }),
        completeStructured: (async () => ({
          memories: [
            { content: "良い事実", digest: "良い", tags: [], provenanceKind: "stated" },
            jsSideFailure
              ? {
                  content: "もう一つの事実",
                  digest: "もう一つ",
                  tags: [],
                  provenanceKind: "stated",
                }
              : { content: "悪い事実", digest: "悪い", tags: [], provenanceKind: "stated" },
          ],
        })) as LLMProvider["completeStructured"],
      };
      const realStore = new PostgresMemoryStore(client.db);
      // 落ちる候補を、runtime が store に渡す2件目へ差し込む。runtime 自身はそういう候補を作らないので、store の手前で書き換える。
      // JS 側で落ちる候補は `status: "contested"` で相手なし。DB が拒む候補は `strength: 2`（CHECK 制約 23514。ADR 0499 より前は
      // 本文の NUL を LLM に返させていたが、NUL は DB に触れる前の名指しの例外になり、トランザクションが aborted にならない）。
      const memoryStore = new Proxy(realStore, {
        get(target, prop, receiver) {
          if (prop === "createMemoriesWithOutboxAndEvents") {
            return (
              c: Ctx,
              news: Parameters<PostgresMemoryStore["createMemoriesWithOutboxAndEvents"]>[1],
              ...rest: unknown[]
            ) =>
              (target.createMemoriesWithOutboxAndEvents as (...a: unknown[]) => unknown)(
                c,
                news.map((n, i) =>
                  i === 1
                    ? {
                        ...n,
                        input: jsSideFailure
                          ? { ...n.input, status: "contested" as const }
                          : { ...n.input, strength: 2 },
                      }
                    : n,
                ),
                ...rest,
              );
          }
          const v = Reflect.get(target, prop, receiver) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        },
      });
      return createRuntime({
        memoryStore,
        vectorStore: new PostgresVectorStore(client.db),
        eventStore: new PostgresEventStore(client.db),
        outboxStore: new PostgresOutboxStore(client.db),
        tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
        llmProvider: llm,
        embeddingProvider: {
          space: TEST_EMBEDDING_SPACE,
          embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
        },
        hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
      });
    }

    it("rollback が成功: ObserveResult は書けた1件と、落とした候補を created の meta に持つ（対照）", async () => {
      await fresh();
      const runtime = runtimeOn(victimClient);
      const result = await runtime.observe(ctx, {
        kind: "utterance",
        text: "二つの事実",
        extract: "sync",
      });
      expect(result.memoryIds).toHaveLength(1);
      const events = (
        await admin.pool.query(
          "SELECT meta FROM memory_events WHERE tenant_id = $1 AND kind = 'created'",
          [ctx.tenantId],
        )
      ).rows as Array<{ meta: { droppedCandidates?: Array<{ code: string | null }> } }>;
      expect(events[0]!.meta.droppedCandidates?.[0]?.code).toBe("23514");
    });

    it("rollback to savepoint も失敗: 25P02 でも『rollback の失敗』でもなく、元の 23514 が呼び出し側へ届き、何も残らない", async () => {
      await fresh();
      const runtime = runtimeOn(victimClient);
      const restore = rejectStatement({
        applicationName: APP,
        matches: ROLLBACK_TO_SAVEPOINT,
        error: new Error(INJECTED),
      });
      let outcome: unknown;
      try {
        outcome = await runtime
          .observe(ctx, { kind: "utterance", text: "二つの事実", extract: "sync" })
          .then(
            (r) => r,
            (e: unknown) => ({ threw: e }),
          );
      } finally {
        restore();
      }
      // どの形で返るにせよ、イベントの meta に注入した失敗の文言は載らない。
      const metas = (
        await admin.pool.query("SELECT meta FROM memory_events WHERE tenant_id = $1", [
          ctx.tenantId,
        ])
      ).rows;
      expect(JSON.stringify(metas)).not.toContain("rollback to savepoint");
      expect(JSON.stringify(metas)).not.toContain(INJECTED);
      // 全体が戻り、呼び出し側へ届くのは元の失敗（23514）。巻き戻しの失敗は rollbackError に残る。
      const thrown = (outcome as { threw?: unknown }).threw;
      expect(thrown).toBeInstanceOf(Error);
      expect(innermostCode(thrown)).toBe("23514");
      expect(chain((thrown as { rollbackError?: unknown }).rollbackError)).toContain(INJECTED);
      // 記憶と created は残らない（outbox には、観測そのものの抽出ジョブが別のトランザクションで1件ある）。
      const left = await ghostCount();
      expect({ memories: left.memories, events: left.events }).toEqual({ memories: 0, events: 0 });
    });

    it("S3 を runtime.observe 経由で: JS 側で落ちる候補＋rollback to savepoint の失敗。直す前は ObserveResult が正常に返り、created の meta に『rollback の失敗』が載った。直したあとは observe が元のエラーで落ち、何も残らない", async () => {
      await fresh();
      const runtime = runtimeOn(victimClient, true);
      const restore = rejectStatement({
        applicationName: APP,
        matches: ROLLBACK_TO_SAVEPOINT,
        error: new Error(INJECTED),
      });
      let outcome: unknown;
      try {
        outcome = await runtime
          .observe(ctx, { kind: "utterance", text: "二つの事実", extract: "sync" })
          .then(
            (r) => r,
            (e: unknown) => ({ threw: e }),
          );
      } finally {
        restore();
      }
      const metas = JSON.stringify(
        (
          await admin.pool.query("SELECT meta FROM memory_events WHERE tenant_id = $1", [
            ctx.tenantId,
          ])
        ).rows,
      );
      // 直す前: ObserveResult（memoryIds が1件）が返り、metas に注入した失敗の文言（Failed query: rollback to savepoint）が載る。
      expect(metas).not.toContain("rollback to savepoint");
      expect(metas).not.toContain(INJECTED);
      const thrown = (outcome as { threw?: unknown }).threw;
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toBeInstanceOf(ContestedWithoutCompanionError);
      expect(chain((thrown as Error).cause)).toContain(INJECTED);
      const left = await ghostCount();
      expect({ memories: left.memories, events: left.events }).toEqual({ memories: 0, events: 0 });
    });

    it("S3 の対照（rollback は成功）: observe は書けた1件を返し、created の meta に落とした理由（ContestedWithoutCompanionError）が載る", async () => {
      await fresh();
      const runtime = runtimeOn(victimClient, true);
      const result = await runtime.observe(ctx, {
        kind: "utterance",
        text: "二つの事実",
        extract: "sync",
      });
      expect(result.memoryIds).toHaveLength(1);
      const metas = JSON.stringify(
        (
          await admin.pool.query("SELECT meta FROM memory_events WHERE tenant_id = $1", [
            ctx.tenantId,
          ])
        ).rows,
      );
      expect(metas).toMatch(/ContestedWithoutCompanion|contested/i);
      expect(metas).not.toContain("rollback to savepoint");
    });
  });
});
