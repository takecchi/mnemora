import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createRuntime } from "@mnemora/core";
import type { Ctx, LLMProvider, MemoryStore, NewObservation } from "@mnemora/core";
import {
  InMemoryEventStore,
  InMemoryMemoryStore,
  InMemoryOutboxStore,
  InMemoryTenantSettingsStore,
  InMemoryVectorStore,
} from "@mnemora/testkit/fixtures";
import { PostgresEventStore } from "../event-store.js";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `observe()` は `data` を `payload` にそのまま入れて `createObservation` へ渡すので、口は `createObservation` と `getObservation` で縛る（`extractData` を通した本文の作られ方は、最後の `describe` で `observe()` を通して縛る）。
 * ⚠ 望ましい姿の主張ではない。TSDoc が「揃える約束はしていない」と書いている今の振る舞いなので、変えるときは TSDoc の表とこの歯を一緒に書き換えること。
 */

const ctx: Ctx = { tenantId: "observation-payload-json-roundtrip" };

beforeEach(async () => {
  await resetTestDatabase();
});

afterAll(async () => {
  await closeTestClient();
});

interface Kit {
  name: "Postgres" | "fixture";
  ms: MemoryStore;
}

const KITS: Array<[Kit["name"], () => Promise<Kit>]> = [
  [
    "Postgres",
    async () => {
      const { db } = await getTestClient();
      return { name: "Postgres", ms: new PostgresMemoryStore(db) };
    },
  ],
  ["fixture", async () => ({ name: "fixture", ms: new InMemoryMemoryStore() })],
];

let n = 0;
function eventObservation(data: unknown): NewObservation {
  n += 1;
  return {
    tenantId: ctx.tenantId,
    kind: "event",
    payload: { name: "n", data },
    externalId: `ext-json-${n}`,
    recordedAt: new Date("2026-01-01T00:00:00Z"),
  } as NewObservation;
}

async function roundtrip(kit: Kit, data: unknown): Promise<Record<string, unknown>> {
  const created = await kit.ms.createObservation(ctx, eventObservation(data));
  const read = await kit.ms.getObservation(ctx, created.id);
  return (read?.payload as { data: Record<string, unknown> }).data;
}

describe.each(KITS)("%s: payload（event の data）の JSON で往復しない値", (kitName, makeKit) => {
  it("NaN・Infinity・-Infinity: Postgres は null、fixture はそのまま", async () => {
    const kit = await makeKit();
    const data = await roundtrip(kit, { a: Number.NaN, b: Infinity, c: -Infinity });
    if (kitName === "Postgres") {
      expect(data).toEqual({ a: null, b: null, c: null });
    } else {
      expect(data).toEqual({ a: Number.NaN, b: Infinity, c: -Infinity });
    }
  });

  it("-0: Postgres は 0、fixture はそのまま", async () => {
    const kit = await makeKit();
    const data = await roundtrip(kit, { a: -0 });
    expect(Object.is(data.a, kitName === "Postgres" ? 0 : -0)).toBe(true);
  });

  it("Date: Postgres は ISO 8601 の文字列、fixture は Date のまま", async () => {
    const kit = await makeKit();
    const date = new Date("2026-02-03T04:05:06.789Z");
    const data = await roundtrip(kit, { a: date });
    if (kitName === "Postgres") {
      expect(data.a).toBe("2026-02-03T04:05:06.789Z");
    } else {
      expect(data.a).toBeInstanceOf(Date);
      expect((data.a as Date).getTime()).toBe(date.getTime());
    }
  });

  it("値が undefined の欄: Postgres は欄ごと消える、fixture は欄が残る", async () => {
    const kit = await makeKit();
    const data = await roundtrip(kit, { a: undefined, b: 1 });
    expect("a" in data).toBe(kitName !== "Postgres");
    expect(data.b).toBe(1);
  });

  it("BigInt: どちらも TypeError で、行を書かない", async () => {
    const kit = await makeKit();
    const input = eventObservation({ a: 1n });
    await expect(kit.ms.createObservation(ctx, input)).rejects.toBeInstanceOf(TypeError);
    const retried = await kit.ms.createObservationWithOutbox(
      ctx,
      { ...input, payload: { name: "n", data: {} } },
      [],
    );
    expect(retried.created).toBe(true);
  });

  it("関数・Symbol の値: どちらも欄ごと消える（配列の中なら null）", async () => {
    const kit = await makeKit();
    for (const value of [() => 1, Symbol("s")]) {
      expect(await roundtrip(kit, { a: value, b: 1 })).toEqual({ b: 1 });
      expect(await roundtrip(kit, { a: [value, 2] })).toEqual({ a: [null, 2] });
    }
  });

  it("toJSON を持つ値: どちらも toJSON の戻り値で保存する（data そのものが object でなくなりうる）", async () => {
    const kit = await makeKit();
    expect(await roundtrip(kit, { a: { toJSON: () => "z" } })).toEqual({ a: "z" });
    expect(await roundtrip(kit, { toJSON: () => 1 })).toBe(1);
    expect(await roundtrip(kit, { k: { toJSON: (key: string) => key } })).toEqual({ k: "k" });
    expect(await roundtrip(kit, { a: { toJSON: () => ({ f: () => 1, b: 2 }) } })).toEqual({
      a: { b: 2 },
    });
  });

  it("createObservationWithOutbox も同じ（関数の欄・toJSON）", async () => {
    const kit = await makeKit();
    const { observation } = await kit.ms.createObservationWithOutbox(
      ctx,
      eventObservation({ a: () => 1, b: { toJSON: () => 5 } }),
      [],
    );
    const read = await kit.ms.getObservation(ctx, observation.id);
    expect((read?.payload as { data: unknown }).data).toEqual({ b: 5 });
  });
});

/**
 * `extractData: true` のプロンプトと全文フォールバックの本文は、JSON 往復を経た後の `data` から作られる
 * （`observationPayloadText`、`ObserveEventInput.data` の TSDoc）。値が undefined の欄だけの `data` は、
 * Postgres では欄が消えて `{}`（キー0個）になり本文は `name` だけ、fixture では欄が残り（キー1個）、
 * 本文は `name` に `{}` が続く。LLM を失敗させ、全文フォールバックの Memory の本文で見る。
 */
describe("extractData: true の本文（LLM 失敗の全文フォールバックで見る）", () => {
  const llm: LLMProvider = {
    complete: async () => ({ content: "" }),
    completeStructured: async () => {
      throw new Error("llm down");
    },
  };
  const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");
  const embed = async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]);

  async function fallbackContent(kitName: Kit["name"], data: Record<string, unknown>) {
    if (kitName === "Postgres") {
      const { db, pool } = await getTestClient();
      const runtime = createRuntime({
        llmProvider: llm,
        embeddingProvider: { space: TEST_EMBEDDING_SPACE, embed },
        hashContent,
        memoryStore: new PostgresMemoryStore(db),
        vectorStore: new PostgresVectorStore(db),
        eventStore: new PostgresEventStore(db),
        outboxStore: new PostgresOutboxStore(db),
        tenantSettingsStore: new PostgresTenantSettingsStore(db),
      });
      await runtime.observe(ctx, { kind: "event", name: "n", data, extractData: true });
      const rows = await pool.query(`SELECT content FROM memories WHERE tenant_id = $1`, [
        ctx.tenantId,
      ]);
      return rows.rows.map((r) => r.content as string);
    }
    const memoryStore = new InMemoryMemoryStore();
    const runtime = createRuntime({
      llmProvider: llm,
      embeddingProvider: { space: { provider: "test", model: "json", dimensions: 3 }, embed },
      hashContent,
      memoryStore,
      vectorStore: new InMemoryVectorStore(memoryStore),
      eventStore: new InMemoryEventStore(memoryStore, memoryStore.events),
      outboxStore: new InMemoryOutboxStore(memoryStore.outboxJobs),
      tenantSettingsStore: new InMemoryTenantSettingsStore(memoryStore.activitySeq),
    });
    const result = await runtime.observe(ctx, {
      kind: "event",
      name: "n",
      data,
      extractData: true,
    });
    expect(result.memoryIds).toHaveLength(1);
    const memory = await memoryStore.get(ctx, result.memoryIds[0]!);
    return [memory!.content];
  }

  it.each(KITS)("%s", async (kitName) => {
    expect(await fallbackContent(kitName, { a: 1 })).toEqual(['n\n\n{"a":1}']);
    await resetTestDatabase();
    expect(await fallbackContent(kitName, { a: undefined })).toEqual([
      kitName === "Postgres" ? "n" : "n\n\n{}",
    ]);
  });
});
