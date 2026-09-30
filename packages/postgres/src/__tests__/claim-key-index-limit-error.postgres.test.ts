import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { isClaimKeyIndexLimitError } from "@mnemora/core";
import type { Ctx, Memory, NewMemory } from "@mnemora/core";
import { buildNewMemoryEventFixture, buildNewMemoryFixture } from "@mnemora/testkit";
import { PostgresMemoryStore } from "../memory-store.js";
import { closeTestClient, getTestClient, resetTestDatabase } from "./test-db.js";

/**
 * ADR 0435: claim key の索引（`idx_memories_claim_key`・`idx_memories_claim_predicates`）の1行の上限
 * （SQLSTATE 54000）で落ちる入力は、4つの口（`createMemory`・`createMemoryWithOutbox`・
 * `createMemoriesWithOutboxAndEvents`・`supersedeWithNewMemories`）のどれでも `ClaimKeyIndexLimitError`
 * （`kind: "claim_key_index_limit"`）になる。**断る入力は変えない**: 今通る入力（圧縮で索引の1行に収まる長い文字列、
 * 2600 字）は通り、ほかの索引の 54000・別の SQLSTATE は包まない。message にも `cause` の連鎖にも入力の値を残さない。
 * 書きかけの残り方（トランザクションごと戻る・旧い行は active のまま・一括は悪い候補だけ `dropped`）も縛る。
 */

const ctx: Ctx = { tenantId: "claim-key-index-limit" };

afterAll(async () => {
  await closeTestClient();
});

/** 圧縮が効かない長い hex。⚠ `"ab".repeat(n)` のような繰り返しは圧縮されて通る（実測）。 */
function incompressibleHex(seed: string, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    out += createHash("sha256").update(`${seed}:${i}`).digest("hex");
  }
  return out.slice(0, length);
}

const CONTENT_MARKER = "CONTENT-MARKER-7f3a9c";

function build(over: Partial<NewMemory>): NewMemory {
  return buildNewMemoryFixture({
    tenantId: ctx.tenantId,
    content: CONTENT_MARKER,
    contentHash: `hash-${Math.random()}`,
    ...over,
  });
}

async function setup() {
  await resetTestDatabase();
  const { db } = await getTestClient();
  const store = new PostgresMemoryStore(db);
  const count = async (table: "memories" | "outbox" | "memory_events" | "memory_labels") => {
    const result = await db.execute(
      sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${ctx.tenantId}`,
    );
    return (result.rows[0] as { n: number }).n;
  };
  return { store, count };
}

type Store = PostgresMemoryStore;

/** 4つの口。`run` は1件の `NewMemory` を渡して、書けた Memory を返す（書けなければ投げる）。 */
const PORTS: Array<{
  method: string;
  run: (store: Store, input: NewMemory) => Promise<Memory>;
}> = [
  {
    method: "createMemory",
    run: (store, input) => store.createMemory(ctx, input),
  },
  {
    method: "createMemoryWithOutbox",
    run: async (store, input) => (await store.createMemoryWithOutbox(ctx, input, ["embed"])).memory,
  },
  {
    method: "createMemoriesWithOutboxAndEvents",
    run: async (store, input) => {
      const result = await store.createMemoriesWithOutboxAndEvents(
        ctx,
        [{ input, jobKinds: ["embed"] }],
        (memory) => buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id }),
      );
      return result.written[0]!.memory;
    },
  },
  {
    method: "supersedeWithNewMemories",
    run: async (store, input) => {
      const old = await store.createMemory(ctx, build({ content: "old", contentHash: "old" }));
      const result = await store.supersedeWithNewMemories(
        ctx,
        [{ input, jobKinds: ["embed"] }],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            event: buildNewMemoryEventFixture({
              tenantId: ctx.tenantId,
              memoryId: old.id,
              kind: "superseded",
            }),
          },
        ],
      );
      return result.created[0]!.memory;
    },
  },
];

/** 例外と `cause` の連鎖の、文字列になりうる欄をすべて連結する（message・stack・名前・自前の欄）。 */
function stringifyChain(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    for (const key of Object.getOwnPropertyNames(current)) {
      if (key === "cause") {
        continue;
      }
      parts.push(`${key}=${JSON.stringify((current as Record<string, unknown>)[key])}`);
    }
    current = (current as { cause?: unknown }).cause;
  }
  return parts.join("\n");
}

function expectNoValueLeak(error: unknown, secrets: string[]): void {
  const text = stringifyChain(error);
  for (const secret of [
    ...secrets.filter((s) => s.length >= 40),
    CONTENT_MARKER,
    "params:",
    "Failed query",
    "INSERT INTO",
  ]) {
    expect(text).not.toContain(secret);
  }
}

/** 落ちる入力（名前付きの形〔2700 字〕と、名前の無い形〔1万字〕。subject・predicate のどちら側でも）。 */
const FAILING: Array<[string, () => { subject: string; predicate: string }]> = [
  [
    "predicate 2700 字（index row size … for index）",
    () => ({ subject: "s", predicate: incompressibleHex("p", 2700) }),
  ],
  ["subject 2700 字", () => ({ subject: incompressibleHex("s", 2700), predicate: "p" })],
  [
    "predicate 1万字（index row requires … bytes）",
    () => ({ subject: "s", predicate: incompressibleHex("p", 10000) }),
  ],
  ["subject 1万字", () => ({ subject: incompressibleHex("s", 10000), predicate: "p" })],
  [
    "subject・predicate とも 1万字",
    () => ({ subject: incompressibleHex("a", 10000), predicate: incompressibleHex("b", 10000) }),
  ],
];

describe.each(PORTS)("$method", ({ method, run }) => {
  it.each(FAILING)(
    "今 54000 で落ちる入力（%s）は ClaimKeyIndexLimitError になり、値が message にも cause にも残らない",
    async (_label, claimKey) => {
      const { store, count } = await setup();
      const key = claimKey();
      const error = await run(store, build({ claimKey: key })).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(isClaimKeyIndexLimitError(error)).toBe(true);
      const typed = error as { kind: string; method: string; name: string; cause?: unknown };
      expect(typed.kind).toBe("claim_key_index_limit");
      expect(typed.method).toBe(method);
      expect(typed.name).toBe("ClaimKeyIndexLimitError");
      // cause は値を含まない新しい Error（SQLSTATE だけ写す）。drizzle の例外は残さない。
      expect(typed.cause).toBeInstanceOf(Error);
      expect((typed.cause as { code?: string }).code).toBe("54000");
      expect(Object.getOwnPropertyNames(typed.cause)).not.toContain("params");
      expect(Object.getOwnPropertyNames(typed.cause)).not.toContain("query");
      expect((typed.cause as { cause?: unknown }).cause).toBeUndefined();
      expectNoValueLeak(error, [key.subject.slice(0, 40), key.predicate.slice(0, 40)]);
      // 書きかけの残り方: memory は1件も残らない。
      expect(await count("memories")).toBe(method === "supersedeWithNewMemories" ? 1 : 0);
      expect(await count("outbox")).toBe(0);
    },
  );

  it("今通る入力（圧縮が効く 'a' × 10万字・incompressible でも 2600 字）は今どおり通り、鍵が保存される", async () => {
    for (const claimKey of [
      { subject: "s", predicate: "a".repeat(100_000) },
      { subject: "a".repeat(100_000), predicate: "a".repeat(100_000) },
      { subject: "s", predicate: incompressibleHex("p", 2600) },
    ]) {
      const { store } = await setup();
      const memory = await run(store, build({ claimKey }));
      expect(memory.claimKey).toEqual(claimKey);
    }
  });

  it("ほかの索引の 54000 と別の SQLSTATE は包まない（生のまま出る）", async () => {
    const cases: Array<[string, Partial<NewMemory>]> = [
      // GIN の idx_memories_tags（名前付き）。
      ["tag 2800 字（idx_memories_tags）", { tags: [incompressibleHex("g", 2800)] }],
      // btree の idx_memories_by_subject（名前付き）。claimKey は小さい。
      [
        "subjectId 5000 字（idx_memories_by_subject）",
        { subjectId: incompressibleHex("u", 5000), claimKey: { subject: "s", predicate: "p" } },
      ],
      // 名前の無い形。claimKey が無い・小さいので、claim key は原因ではない。
      ["tag 1万字・claimKey なし（名前の無い形）", { tags: [incompressibleHex("g", 10000)] }],
      [
        "tag 1万字・claimKey あり（名前の無い形。claim key だけが原因とは言えない）",
        { tags: [incompressibleHex("g", 10000)], claimKey: { subject: "s", predicate: "p" } },
      ],
      [
        "subjectId 1万字・claimKey あり（名前の無い形）",
        { subjectId: incompressibleHex("u", 10000), claimKey: { subject: "s", predicate: "p" } },
      ],
      // 別の SQLSTATE（23514 check_violation）。
      ["strength が値域の外（23514）", { strength: 5, claimKey: { subject: "s", predicate: "p" } }],
    ];
    for (const [label, over] of cases) {
      const { store } = await setup();
      const error = await run(store, build(over)).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error, label).toBeInstanceOf(Error);
      expect(isClaimKeyIndexLimitError(error), label).toBe(false);
    }
  });
});

describe("書きかけの残り方（口ごと）", () => {
  it("supersedeWithNewMemories: 旧い行は active のまま、新しい行・created・superseded イベントは1件も残らない", async () => {
    const { store, count } = await setup();
    const old = await store.createMemory(ctx, build({ content: "old", contentHash: "old" }));
    const eventsBefore = await count("memory_events");
    await expect(
      store.supersedeWithNewMemories(
        ctx,
        [
          { input: build({ contentHash: "good" }), jobKinds: ["embed"] },
          {
            input: build({ claimKey: { subject: "s", predicate: incompressibleHex("p", 10000) } }),
            jobKinds: ["embed"],
          },
        ],
        [
          {
            id: old.id,
            supersededByIndex: 0,
            event: buildNewMemoryEventFixture({
              tenantId: ctx.tenantId,
              memoryId: old.id,
              kind: "superseded",
            }),
          },
        ],
      ),
    ).rejects.toSatisfy(isClaimKeyIndexLimitError);
    expect((await store.get(ctx, old.id))?.status).toBe("active");
    expect(await count("memories")).toBe(1);
    expect(await count("outbox")).toBe(0);
    expect(await count("memory_events")).toBe(eventsBefore);
  });

  it("createMemoriesWithOutboxAndEvents: 正常な候補だけ書き、悪い候補は dropped に ClaimKeyIndexLimitError として積む", async () => {
    const { store, count } = await setup();
    const bad = { subject: "s", predicate: incompressibleHex("p", 10000) };
    const droppedSeen: Array<ReadonlyArray<{ index: number; error: unknown }>> = [];
    const result = await store.createMemoriesWithOutboxAndEvents(
      ctx,
      [
        { input: build({ claimKey: bad }), jobKinds: ["embed"] },
        { input: build({ contentHash: "good-1" }), jobKinds: ["embed"] },
        {
          input: build({ contentHash: "good-2", claimKey: { subject: "s", predicate: "ok" } }),
          jobKinds: ["embed"],
        },
      ],
      (memory, dropped) => {
        droppedSeen.push(dropped);
        return buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id });
      },
    );
    expect(result.written.map((w) => w.index)).toEqual([1, 2]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0]!.index).toBe(0);
    expect(isClaimKeyIndexLimitError(result.dropped[0]!.error)).toBe(true);
    expect((result.dropped[0]!.error as { method: string }).method).toBe(
      "createMemoriesWithOutboxAndEvents",
    );
    expectNoValueLeak(result.dropped[0]!.error, [bad.predicate.slice(0, 40)]);
    // Runtime の `describeDroppedCandidate` が読む「最も内側の原因」の `code`・`message` は、型付きにする前と同じ形（SQLSTATE 54000 と pg の文面）。
    const innermost = (result.dropped[0]!.error as { cause: Error }).cause as Error & {
      code?: string;
    };
    expect(innermost.code).toBe("54000");
    expect(innermost.message).toMatch(/^index row requires \d+ bytes, maximum size is 8191$/);
    expect(droppedSeen.every((d) => d.length === 1 && d[0]!.index === 0)).toBe(true);
    expect(await count("memories")).toBe(2);
    expect(await count("outbox")).toBe(2);
    expect(await count("memory_events")).toBe(2);
  });

  it("createMemoriesWithOutboxAndEvents: 全候補が落ちたら最初の例外（ClaimKeyIndexLimitError）を投げ、何も書かない", async () => {
    const { store, count } = await setup();
    const bad = () =>
      build({ claimKey: { subject: "s", predicate: incompressibleHex("p", 10000) } });
    await expect(
      store.createMemoriesWithOutboxAndEvents(
        ctx,
        [
          { input: bad(), jobKinds: ["embed"] },
          { input: bad(), jobKinds: ["embed"] },
        ],
        (memory) => buildNewMemoryEventFixture({ tenantId: ctx.tenantId, memoryId: memory.id }),
      ),
    ).rejects.toSatisfy(isClaimKeyIndexLimitError);
    expect(await count("memories")).toBe(0);
    expect(await count("outbox")).toBe(0);
    expect(await count("memory_events")).toBe(0);
  });

  it("createMemory・createMemoryWithOutbox: tags の proposed ラベルも残らない（トランザクションごと戻る）", async () => {
    const { store, count } = await setup();
    const input = build({
      tags: ["some-tag"],
      claimKey: { subject: "s", predicate: incompressibleHex("p", 10000) },
    });
    await expect(store.createMemory(ctx, input)).rejects.toSatisfy(isClaimKeyIndexLimitError);
    await expect(store.createMemoryWithOutbox(ctx, input, ["embed"])).rejects.toSatisfy(
      isClaimKeyIndexLimitError,
    );
    expect(await count("memories")).toBe(0);
    expect(await count("memory_labels")).toBe(0);
  });
});
