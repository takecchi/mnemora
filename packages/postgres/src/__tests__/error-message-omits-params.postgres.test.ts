import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Ctx, EmbeddingSpaceId, VectorFilter } from "@mnemora/core";
import { buildNewMemoryFixture } from "@mnemora/testkit";
import { createRuntime, isEmbeddingSpaceNotRegisteredError } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresLexicalStore } from "../lexical-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  PostgresTrigramLexicalStore,
  probeTrigramLexicalSupport,
} from "../trigram-lexical-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * 利用者へ伝わる例外の message から、SQL に付けた値（params）を落とす（ADR 0423。ADR 0363 と同じ作法）。
 *
 * 本物の drizzle が包んだ例外（`Failed query: <SQL>\nparams: <値>`）で見る。本文に値を入れた入力で
 * 例外を起こし、message に本文が入らないこと、SQL の文・`cause` の理由と SQLSTATE が残ることを確かめる。
 * 例外の起こし方は、jsonb 列が受けない値（孤立サロゲート）を本文に入れること——本文そのものの扱いは変えない。
 */

const ctx: Ctx = { tenantId: "error-message-omits-params" };
const BODY_MARKER = "本文の目印-0123456789";
const BAD_BODY = `${BODY_MARKER}\uD83D`;

afterAll(async () => {
  await closeTestClient();
});

async function buildRuntime() {
  const { db } = await getTestClient();
  return createRuntime({
    memoryStore: new PostgresMemoryStore(db),
    outboxStore: new PostgresOutboxStore(db),
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
    llmProvider: {
      complete: async () => ({ content: "unused" }),
      completeStructured: async () => {
        throw new Error("not reached");
      },
    },
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
  });
}

async function thrown(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("reject しなかった");
}

describe("runtime.observe の例外の message に、本文は入らない", () => {
  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("SQL の文と cause（pg の理由と SQLSTATE）は残り、params の値は message にも stack にも無い", async () => {
    const runtime = await buildRuntime();
    const error = await thrown(runtime.observe(ctx, { kind: "utterance", text: BAD_BODY }));

    expect(error.message).toContain("Failed query:");
    expect(error.message).toContain("observations");
    expect(error.message).not.toContain(BODY_MARKER);
    expect(String(error.stack)).not.toContain(BODY_MARKER);
    const cause = error.cause as { message?: string; code?: string } | undefined;
    expect(cause?.code).toBe("22P02");
    expect(cause?.message).toMatch(/invalid input syntax for type json/);
  });
});

/**
 * ADR 0504: store を直接呼んだときも、投げる例外の message（`cause` の連鎖を含む）から params の値を落とす。
 * `PostgresVectorStore` の全ての口。`searchMany` は 1 文に最大 16384 件のベクトルが params に載る。
 * 例外の起こし方は2つ: (a) 登録していない空間（42P01 を `EmbeddingSpaceNotRegisteredError` に包む経路）、
 * (b) 登録済みの空間への次元違いの `upsert`（pgvector が拒む。包まずそのまま投げる経路）。
 * `deleteAcrossSpaces`・`eraseTenant` は本物の DB では起こしにくいので、drizzle 形の例外を投げる db で見る。
 */
const VECTOR_MARKER = "0.7312345";
const TENANT_MARKER = "tenant-marker-4d1f";
const storeCtx: Ctx = { tenantId: `omit-params-${TENANT_MARKER}` };
const UNREGISTERED: EmbeddingSpaceId = {
  provider: "test",
  model: "never-registered",
  dimensions: 3,
};
const MEMORY_ID = "11111111-1111-4111-8111-111111111111";
const FILTER: VectorFilter = { tenantId: storeCtx.tenantId, status: ["active"] };

function chainTexts(error: unknown): string[] {
  const texts: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    const { message, stack, cause } = current as {
      message?: unknown;
      stack?: unknown;
      cause?: unknown;
    };
    texts.push(String(message), String(stack));
    current = cause;
  }
  return texts;
}

function expectNoParams(error: unknown): void {
  const texts = chainTexts(error);
  for (const text of texts) {
    expect(text).not.toContain(VECTOR_MARKER);
    expect(text).not.toContain(TENANT_MARKER);
  }
  // やりすぎていない: SQL の文と、落としたことの印は残る
  expect(texts.some((t) => t.includes("Failed query:") && t.includes("(omitted by mnemora,"))).toBe(
    true,
  );
}

describe("PostgresVectorStore を直接呼んだ例外から、params の値を落とす（ADR 0504）", () => {
  const mouths: Array<[string, (store: PostgresVectorStore) => Promise<unknown>]> = [
    ["upsert", (s) => s.upsert(storeCtx, UNREGISTERED, MEMORY_ID, [0.7312345, 0, 0])],
    [
      "search",
      (s) => s.search(storeCtx, UNREGISTERED, [0.7312345, 0, 0], { limit: 5, filter: FILTER }),
    ],
    [
      "searchMany",
      (s) =>
        s.searchMany(storeCtx, UNREGISTERED, [{ key: "a", vector: [0.7312345, 0, 0] }], {
          limit: 5,
          filter: FILTER,
        }),
    ],
    ["delete", (s) => s.delete(storeCtx, UNREGISTERED, MEMORY_ID)],
    ["getVectors", (s) => s.getVectors(storeCtx, UNREGISTERED, [MEMORY_ID])],
  ];

  for (const [name, run] of mouths) {
    it(`${name}（未登録の空間）: cause の連鎖に params の値が無く、kind・SQLSTATE は残る`, async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      const error = await thrown(run(new PostgresVectorStore(db)));
      expect(isEmbeddingSpaceNotRegisteredError(error)).toBe(true);
      expect((error as { kind?: string }).kind).toBe("embedding_space_not_registered");
      expectNoParams(error);
      let code: unknown;
      let cursor: unknown = (error as Error).cause;
      while (typeof cursor === "object" && cursor !== null) {
        code = (cursor as { code?: unknown }).code ?? code;
        cursor = (cursor as { cause?: unknown }).cause;
      }
      expect(code).toBe("42P01");
    });
  }

  it("upsert（登録済みの空間への次元違い。包まずそのまま投げる経路）: message に params の値が無く、原因は残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memory = await new PostgresMemoryStore(db).createMemory(
      storeCtx,
      buildNewMemoryFixture({ tenantId: storeCtx.tenantId, contentHash: "omit-params-0504" }),
    );
    const error = await thrown(
      new PostgresVectorStore(db).upsert(storeCtx, TEST_EMBEDDING_SPACE, memory.id, [0.7312345, 0]),
    );
    expect(isEmbeddingSpaceNotRegisteredError(error)).toBe(false);
    expectNoParams(error);
    expect(chainTexts(error).join("\n")).toMatch(/expected 3 dimensions, not 2/);
  });

  for (const [name, run] of [
    ["deleteAcrossSpaces", (s: PostgresVectorStore) => s.deleteAcrossSpaces(storeCtx, [MEMORY_ID])],
    ["eraseTenant", (s: PostgresVectorStore) => s.eraseTenant(storeCtx, { limit: 10 })],
  ] as const) {
    it(`${name}: トランザクションが投げた drizzle 形の例外から params の値を落とす`, async () => {
      const drizzleLike = Object.assign(
        new Error(
          `Failed query: DELETE FROM t WHERE tenant_id = $1\nparams: ${storeCtx.tenantId},[${VECTOR_MARKER}]`,
        ),
        { cause: Object.assign(new Error("boom"), { code: "57014" }) },
      );
      const failing = {
        transaction: async () => {
          throw drizzleLike;
        },
      } as unknown as ConstructorParameters<typeof PostgresVectorStore>[0];
      const error = await thrown(run(new PostgresVectorStore(failing)));
      expect(error).toBe(drizzleLike);
      expectNoParams(error);
      expect((drizzleLike.cause as { code?: string }).code).toBe("57014");
    });
  }
});

/**
 * ADR 0505（ADR 0504 の負債の返済）: `PostgresEventStore.append`・`PostgresLexicalStore.search` を直接呼んだときも、
 * 投げる例外の message（`cause` の連鎖を含む）から params の値を落とす。
 * 例外の起こし方は、本物の DB が拒む入力:
 * - `append`: `kind` が CHECK 制約（`memory_events_kind_check`）を外れる（`memoryId` が null の経路と、記憶を指す経路の2つ。
 *   INSERT が別の文）。`meta` の孤立サロゲートは、ADR 0499 の入口の検査が先に名指しで断る（値は載らない）ので、
 *   DB に届かない——その入力の message に値が無いことも縛る。
 * - `LexicalStore.search`: `filter.attributes` の孤立サロゲート（`jsonb` が拒む）。
 */
const EVENT_MARKER = "event-marker-7b2e";
const LEX_MARKER = "lex-marker-91c4";

describe("PostgresEventStore.append・PostgresLexicalStore.search を直接呼んだ例外から、params の値を落とす（ADR 0505）", () => {
  const markers = [EVENT_MARKER, LEX_MARKER, TENANT_MARKER];
  function expectNoMarkers(error: unknown): void {
    for (const text of chainTexts(error)) {
      for (const marker of markers) {
        expect(text).not.toContain(marker);
      }
    }
  }
  function expectSqlAndMark(error: unknown): void {
    // やりすぎていない: SQL の文と、落としたことの印は残る
    expect(
      chainTexts(error).some(
        (t) => t.includes("Failed query:") && t.includes("(omitted by mnemora,"),
      ),
    ).toBe(true);
  }

  async function sqlstate(error: unknown): Promise<string | undefined> {
    let code: string | undefined;
    let cursor: unknown = error;
    while (typeof cursor === "object" && cursor !== null) {
      code = (cursor as { code?: string }).code ?? code;
      cursor = (cursor as { cause?: unknown }).cause;
    }
    return code;
  }

  const badKind = { kind: "no_such_kind" } as const;

  it("append（memoryId が null の経路）: 制約違反の例外に meta・digestSnapshot の値が無く、SQLSTATE は残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const error = await thrown(
      new PostgresEventStore(db).append(storeCtx, {
        memoryId: null,
        ...badKind,
        actor: { type: "system" },
        digestSnapshot: EVENT_MARKER,
        meta: { note: EVENT_MARKER },
      } as never),
    );
    expectNoMarkers(error);
    expectSqlAndMark(error);
    expect(await sqlstate(error)).toBe("23514");
  });

  it("append（記憶を指す経路）: 制約違反の例外に meta・digestSnapshot の値が無く、SQLSTATE は残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const memory = await new PostgresMemoryStore(db).createMemory(
      storeCtx,
      buildNewMemoryFixture({ tenantId: storeCtx.tenantId, contentHash: "omit-params-0505" }),
    );
    const error = await thrown(
      new PostgresEventStore(db).append(storeCtx, {
        memoryId: memory.id,
        ...badKind,
        actor: { type: "system" },
        digestSnapshot: EVENT_MARKER,
        meta: { note: EVENT_MARKER },
      } as never),
    );
    expectNoMarkers(error);
    expectSqlAndMark(error);
    expect(await sqlstate(error)).toBe("23514");
  });

  it("append: meta の孤立サロゲートは、入口の検査が名指しで断る（値は message に載らない）", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const error = await thrown(
      new PostgresEventStore(db).append(storeCtx, {
        memoryId: null,
        kind: "events_purged",
        actor: { type: "system" },
        meta: { note: `${EVENT_MARKER}\uD83D` },
      } as never),
    );
    expect(error.message).toMatch(/memory_events\.meta must not contain NUL/);
    expectNoMarkers(error);
  });

  it("LexicalStore.search: filter.attributes の孤立サロゲートの例外に値が無く、SQL の文・SQLSTATE は残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const error = await thrown(
      new PostgresLexicalStore(db).search(storeCtx, "hello", {
        limit: 5,
        filter: { tenantId: storeCtx.tenantId, attributes: { k: `${LEX_MARKER}\uD83D` } },
      }),
    );
    expectNoMarkers(error);
    expectSqlAndMark(error);
    expect(await sqlstate(error)).toBe("22P02");
  });

  it("やりすぎていない: 正常な呼び出しは、これまでどおり結果を返す", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    await expect(
      new PostgresLexicalStore(db).search(storeCtx, "hello", {
        limit: 5,
        filter: { tenantId: storeCtx.tenantId },
      }),
    ).resolves.toEqual([]);
    await expect(
      new PostgresEventStore(db).append(storeCtx, {
        memoryId: null,
        kind: "events_purged",
        actor: { type: "system" },
        meta: { note: "ok" },
      } as never),
    ).resolves.toMatchObject({ kind: "events_purged" });
  });
});

/**
 * ADR 0516（ADR 0504・0505 の負債の返済）: `PostgresTrigramLexicalStore.search`・`PostgresOutboxStore`・
 * `PostgresTenantSettingsStore` を直接呼んだときも、投げる例外の message（`cause` の連鎖を含む）から
 * params の値を落とす。`PostgresMemoryStore`・`PostgresRelationStore` は今回の範囲外（ADR の負債）。
 *
 * 例外の起こし方は、本物の DB が拒む入力:
 * - `PostgresTrigramLexicalStore.search`: `filter.attributes` の孤立サロゲート（`jsonb` が拒む。22P02）。
 * - `PostgresOutboxStore`: `LIMIT` に負の数（2201W）、`attempts`（int4）に収まらない数（22003）。
 * - `PostgresTenantSettingsStore`: 入口の検査を通る入力では DB が拒まないので、トランザクションの中で
 *   `search_path` を空にして `tenant_settings` を見えなくする（42P01）。そのトランザクションの `tx` を store に渡す。
 */
const OBX_MARKER = "obx-marker-5a93";
const obxCtx: Ctx = { tenantId: `omit-params-${OBX_MARKER}` };
const TRI_MARKER = "tri-marker-c07d";
const TS_MARKER = "ts-marker-e418";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function expectNoMarkers2(error: unknown, markers: string[]): void {
  const texts = chainTexts(error);
  for (const text of texts) {
    for (const marker of markers) {
      expect(text).not.toContain(marker);
    }
  }
  // やりすぎていない: SQL の文と、落としたことの印は残る
  expect(texts.some((t) => t.includes("Failed query:") && t.includes("(omitted by mnemora,"))).toBe(
    true,
  );
}

function sqlstateOf(error: unknown): string | undefined {
  let code: string | undefined;
  let cursor: unknown = error;
  while (typeof cursor === "object" && cursor !== null) {
    code = (cursor as { code?: string }).code ?? code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return code;
}

describe("PostgresTrigramLexicalStore.search を直接呼んだ例外から、params の値を落とす（ADR 0516）", () => {
  it("filter.attributes の孤立サロゲートの例外に値が無く、SQL の文・SQLSTATE は残る", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    const probe = await probeTrigramLexicalSupport(db);
    if (!probe.ok) return; // SQL_ASCII の脚などでは create() が拒む（別の歯が見る）
    const store = await PostgresTrigramLexicalStore.create(db);
    const error = await thrown(
      store.search(obxCtx, `東京${TRI_MARKER}`, {
        limit: 5,
        filter: { tenantId: obxCtx.tenantId, attributes: { k: `${TRI_MARKER}\uD83D` } },
      }),
    );
    expectNoMarkers2(error, [TRI_MARKER, OBX_MARKER]);
    expect(sqlstateOf(error)).toBe("22P02");
  });
});

describe("PostgresOutboxStore を直接呼んだ例外から、params の値を落とす（ADR 0516）", () => {
  // 4つ目が true の口は、撃つ前に obxCtx のテナントの claim 可能な行を1本入れる。
  // 表が空のとき、`LIMIT` を含む副問い合わせ・CTE は、プランナの統計の状態によっては結合の
  // 内側に回り、一度も実行されない（`LIMIT` の検査も走らず、reject されない）。同じテナントの
  // 行が1本あれば、どの統計でも `LIMIT` が評価される。
  const mouths: Array<[string, string, (s: PostgresOutboxStore) => Promise<unknown>, boolean?]> = [
    [
      "claimBatch",
      "2201W",
      (s) =>
        s.claimBatch(obxCtx, {
          limit: -1,
          now: new Date(),
          leaseMs: 1000,
          claimedBy: OBX_MARKER,
        } as never),
      true,
    ],
    ["complete", "22003", (s) => s.complete(obxCtx, JOB_ID, 2 ** 40)],
    ["fail", "22003", (s) => s.fail(obxCtx, JOB_ID, OBX_MARKER, 2 ** 40)],
    ["eraseTenant", "2201W", (s) => s.eraseTenant(obxCtx, { limit: -1 }), true],
    ["eraseTenant（dryRun）", "2201W", (s) => s.eraseTenant(obxCtx, { limit: -1, dryRun: true })],
    [
      "purgeCompletedJobs",
      "2201W",
      (s) => s.purgeCompletedJobs(obxCtx, { olderThan: new Date(), limit: -2 }),
    ],
    [
      "purgeCompletedJobs（dryRun）",
      "2201W",
      (s) => s.purgeCompletedJobs(obxCtx, { olderThan: new Date(), limit: -2, dryRun: true }),
    ],
  ];
  for (const [name, code, run, seedRow] of mouths) {
    it(`${name}: 例外に params の値が無く、SQL の文・SQLSTATE は残る`, async () => {
      await resetTestDatabase();
      const { pool, db } = await getTestClient();
      if (seedRow === true) {
        await pool.query(
          `INSERT INTO outbox (id, tenant_id, kind, payload, available_at, attempts, created_at)
           VALUES (gen_random_uuid(), $1, 'embed', '{}'::jsonb, now() - interval '1 hour', 0, now())`,
          [obxCtx.tenantId],
        );
      }
      const error = await thrown(run(new PostgresOutboxStore(db)));
      expectNoMarkers2(error, [OBX_MARKER]);
      expect(sqlstateOf(error)).toBe(code);
    });
  }

  it("complete・fail が CAS の読み直し（raiseIfLeaseConflict）で落ちたときも、params の値を落とす", async () => {
    for (const run of [
      (s: PostgresOutboxStore) => s.complete(obxCtx, JOB_ID, 1),
      (s: PostgresOutboxStore) => s.fail(obxCtx, JOB_ID, "e", 1),
    ]) {
      let calls = 0;
      const drizzleLike = Object.assign(
        new Error(`Failed query: SELECT attempts FROM outbox\nparams: ${OBX_MARKER},${JOB_ID}`),
        { cause: Object.assign(new Error("boom"), { code: "57014" }) },
      );
      const db = {
        execute: async () => {
          calls += 1;
          if (calls === 1) return { rows: [] };
          throw drizzleLike;
        },
      } as unknown as ConstructorParameters<typeof PostgresOutboxStore>[0];
      const error = await thrown(run(new PostgresOutboxStore(db)));
      expect(calls).toBe(2);
      expect(error).toBe(drizzleLike);
      expectNoMarkers2(error, [OBX_MARKER]);
    }
  });

  it("やりすぎていない: 正常な呼び出しは、これまでどおり結果を返す", async () => {
    await resetTestDatabase();
    const { db } = await getTestClient();
    await expect(
      new PostgresOutboxStore(db).claimBatch(obxCtx, {
        limit: 5,
        now: new Date(),
        leaseMs: 1000,
        claimedBy: "w",
      } as never),
    ).resolves.toEqual([]);
  });
});

describe("PostgresTenantSettingsStore を直接呼んだ例外から、params の値を落とす（ADR 0516）", () => {
  const tsCtx: Ctx = { tenantId: `omit-params-${TS_MARKER}` };
  const mouths: Array<[string, (s: PostgresTenantSettingsStore) => Promise<unknown>]> = [
    ["getDefaultHalfLifeHours", (s) => s.getDefaultHalfLifeHours(tsCtx)],
    ["getEventRetention", (s) => s.getEventRetention(tsCtx)],
    ["setEventRetention", (s) => s.setEventRetention(tsCtx, { kind: "days", days: 30 })],
    ["getDecayClock", (s) => s.getDecayClock(tsCtx)],
    ["setDecayClock", (s) => s.setDecayClock(tsCtx, "wall")],
    ["getDefaultHalfLifeRecalls", (s) => s.getDefaultHalfLifeRecalls(tsCtx)],
    ["setDefaultHalfLifeRecalls", (s) => s.setDefaultHalfLifeRecalls(tsCtx, 100)],
    ["getActivitySeq", (s) => s.getActivitySeq(tsCtx)],
    ["hasSubjectActivityCounters", (s) => s.hasSubjectActivityCounters(tsCtx)],
    ["getSubjectActivitySeqs", (s) => s.getSubjectActivitySeqs(tsCtx, ["subject-1"])],
    ["getTaxonomyMode", (s) => s.getTaxonomyMode(tsCtx)],
    ["setTaxonomyMode", (s) => s.setTaxonomyMode(tsCtx, "open")],
    ["eraseTenant", (s) => s.eraseTenant(tsCtx, { limit: 10 })],
    ["eraseTenant（dryRun）", (s) => s.eraseTenant(tsCtx, { limit: 10, dryRun: true })],
  ];
  for (const [name, run] of mouths) {
    it(`${name}: 例外に params の値が無く、SQL の文・SQLSTATE（42P01）は残る`, async () => {
      await resetTestDatabase();
      const { db } = await getTestClient();
      let error: Error | undefined;
      await db
        .transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL search_path = pg_catalog`);
          error = await thrown(run(new PostgresTenantSettingsStore(tx as never)));
          throw new Error("rollback");
        })
        .catch(() => undefined);
      expectNoMarkers2(error, [TS_MARKER]);
      expect(sqlstateOf(error)).toBe("42P01");
    });
  }
});
