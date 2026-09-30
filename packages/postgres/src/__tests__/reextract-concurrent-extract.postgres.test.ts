import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, MemoryStore } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import { PostgresMemoryStore } from "../memory-store.js";
import { PostgresVectorStore } from "../vector-store.js";
import { PostgresEventStore } from "../event-store.js";
import { PostgresOutboxStore } from "../outbox-store.js";
import { PostgresTenantSettingsStore } from "../tenant-settings-store.js";
import {
  closeTestClient,
  getTestClient,
  resetTestDatabase,
  TEST_EMBEDDING_SPACE,
} from "./test-db.js";

/**
 * `reextract` どうし、`reextract` と `tick` の extract が同時に走ったとき、同じ Observation から
 * 記憶が何件 active になるかを、Postgres で実測して縛る。
 * **今の振る舞いを縛る歯であり、望ましい姿ではない。負債として引き受けている**
 * （ADR 0347「引き受けた負債」の並行の2本の続き。ADR 0347 が実測したのは tick どうしだけで、`reextract` は
 * 扱っていない——`reextract` は決定1の確認を通らない。実測して負債として引き受けた経緯は ADR 0421）。
 * 直すなら、この歯を先に書き換えること。
 *
 * 形は `tick-concurrent-extract.postgres.test.ts` に揃える。順序はタイミングではなく門（Promise）で決める:
 * 先に始めた側が門に止まり、その間に後から始めた側が最後まで走り、その後で先の側を進める。
 * 門は2種類ある。**LLM の中**で止めると、`reextract` は LLM の後で既存の記憶を読むので、結果は1件に収束する
 * （2件にならない）。2件になるのは、`reextract` が既存の記憶を読んだ後・**書く直前**（`supersedeWithNewMemories`）で
 * 止めたときと、tick の抽出が LLM の中で止まる（tick は書く前に読み直さない）ときである。両方を縛る。
 * 2本は1本のテストの中で `Promise.all` で走らせる（プロセスを並列に起こさない）。
 */

interface LlmStep {
  /** 返す候補の本文。 */
  output: readonly string[];
  /** 在れば、呼ばれたことを `entered` で知らせ、`gate` が解決するまで返さない。 */
  gate?: Promise<void>;
  entered?: () => void;
}
let steps: LlmStep[] = [];
const llm: LLMProvider = {
  complete: async () => ({ content: "" }),
  completeStructured: async (_ctx, req) => {
    const step = steps.shift();
    if (step === undefined) throw new Error("unexpected LLM call");
    step.entered?.();
    if (step.gate !== undefined) await step.gate;
    return req.schema.parse({
      memories: step.output.map((content) => ({ content, provenanceKind: "stated" })),
    });
  },
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ctx: Ctx = { tenantId: "reextract-concurrent-extract" };
const LEASE_MS = 60_000;

/** `reextract` の書き込み（`supersedeWithNewMemories`）を、呼ばれた時点で止められる store。 */
function gateWrite(store: MemoryStore) {
  const gate = { armed: false, entered: () => {}, release: Promise.resolve() };
  const wrapped = new Proxy(store, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "supersedeWithNewMemories") {
        return async (
          ...args: Parameters<NonNullable<MemoryStore["supersedeWithNewMemories"]>>
        ) => {
          if (gate.armed) {
            gate.armed = false;
            gate.entered();
            await gate.release;
          }
          return target.supersedeWithNewMemories!(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    store: wrapped,
    /** 次の書き込みを止める。`stopped` は止まったとき、`resume` で進む。 */
    holdNextWrite: (): Hold => {
      const entered = deferred();
      const release = deferred();
      gate.armed = true;
      gate.entered = entered.resolve;
      gate.release = release.promise;
      return { stopped: entered.promise, resume: release.resolve };
    },
  };
}

interface Hold {
  stopped: Promise<void>;
  resume: () => void;
}

async function makeKit() {
  await resetTestDatabase();
  const { db, pool } = await getTestClient();
  const { store, holdNextWrite } = gateWrite(new PostgresMemoryStore(db));
  const runtime = createRuntime({
    llmProvider: llm,
    embeddingProvider: {
      space: TEST_EMBEDDING_SPACE,
      embed: async (_ctx: Ctx, texts: string[]) => texts.map(() => [1, 0, 0]),
    },
    hashContent: (content: string) => createHash("sha256").update(content).digest("hex"),
    clock: { now: () => new Date("2030-01-01T00:00:00.000Z") },
    memoryStore: store,
    vectorStore: new PostgresVectorStore(db),
    eventStore: new PostgresEventStore(db),
    outboxStore: new PostgresOutboxStore(db),
    tenantSettingsStore: new PostgresTenantSettingsStore(db),
  });
  return { runtime, pool, holdNextWrite };
}
type Kit = Awaited<ReturnType<typeof makeKit>>;

async function readState(kit: Kit) {
  const memories = (
    await kit.pool.query(
      `SELECT status, content FROM memories WHERE tenant_id = $1 ORDER BY content`,
      [ctx.tenantId],
    )
  ).rows.map((r) => ({ status: r.status as string, content: r.content as string }));
  const events = (
    await kit.pool.query(
      `SELECT kind, meta->>'reason' AS reason FROM memory_events
        WHERE tenant_id = $1 ORDER BY kind, meta->>'reason'`,
      [ctx.tenantId],
    )
  ).rows.map((r) => `${r.kind as string}:${(r.reason as string | null) ?? "-"}`);
  return { memories, events };
}

/** 先に始めた側（`first`）を `hold` で止め、後から始めた側（`second`）を最後まで走らせてから、`first` を進める。 */
async function race<A, B>(
  hold: Hold,
  first: () => Promise<A>,
  second: () => Promise<B>,
): Promise<{ first: A; second: B }> {
  const [a, b] = await Promise.all([
    first(),
    (async () => {
      await hold.stopped;
      const result = await second();
      hold.resume();
      return result;
    })(),
  ]);
  expect(steps).toEqual([]);
  return { first: a, second: b };
}

/** 先の LLM 呼び出し（①）を門で止め、②の LLM は止めずに返す。 */
function holdFirstLlm(first: readonly string[], second: readonly string[]): Hold {
  const gate = deferred();
  const entered = deferred();
  steps = [{ output: first, gate: gate.promise, entered: entered.resolve }, { output: second }];
  return { stopped: entered.promise, resume: gate.resolve };
}

/** LLM は止めない。 */
function llmOutputs(first: readonly string[], second: readonly string[]) {
  steps = [{ output: first }, { output: second }];
}

async function observeDeferred(kit: Kit) {
  const { observationId } = await kit.runtime.observe(ctx, {
    kind: "utterance",
    text: "発話",
    extract: "deferred",
  });
  return observationId;
}

/** deferred で observe し、tick で1回抽出して、初期の記憶 1 件を作る。 */
async function observeAndExtractOnce(kit: Kit, initial: string) {
  steps = [{ output: [initial] }];
  const observationId = await observeDeferred(kit);
  await kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });
  expect(steps).toEqual([]);
  return observationId;
}

const tickExtract = (kit: Kit) => kit.runtime.tick(ctx, { kinds: ["extract"], leaseMs: LEASE_MS });

afterAll(async () => {
  await closeTestClient();
});

describe("Postgres: reextract の並行（今の振る舞い。ADR 0347 の続き・ADR 0421 の負債）", () => {
  // 窓は「reextract が今の active を読んだ後、書くまで」。tick の抽出は書く前に何も読み直さず（決定1の確認は
  // LLM の前）、reextract の supersede は tick の書いた記憶を知らない。

  it("reextract 対 reextract・記憶がまだ無い Observation（①が書く直前で止まる）: A・B の2件が active（負債: ADR 0421）", async () => {
    const kit = await makeKit();
    const observationId = await observeDeferred(kit);
    llmOutputs(["候補A"], ["候補B"]);
    await race(
      kit.holdNextWrite(),
      () => kit.runtime.reextract(ctx, observationId),
      () => kit.runtime.reextract(ctx, observationId),
    );
    const state = await readState(kit);
    expect(state.memories).toEqual([
      { status: "active", content: "候補A" },
      { status: "active", content: "候補B" },
    ]);
    expect(state.events).toEqual(["created:extracted", "created:extracted"]);
  });

  it("reextract 対 reextract・記憶が1件ある Observation（①が書く直前で止まる）: 初期は②が supersede し、①の supersede は競合で skipped、A・B の2件が active（負債: ADR 0421）", async () => {
    const kit = await makeKit();
    const observationId = await observeAndExtractOnce(kit, "初期");
    llmOutputs(["候補A"], ["候補B"]);
    const got = await race(
      kit.holdNextWrite(),
      () => kit.runtime.reextract(ctx, observationId),
      () => kit.runtime.reextract(ctx, observationId),
    );
    const state = await readState(kit);
    expect(state.memories).toEqual([
      { status: "active", content: "候補A" },
      { status: "active", content: "候補B" },
      { status: "superseded", content: "初期" },
    ]);
    // ②は初期を supersede した。①は初期を supersede しようとしたが、②が先に済ませていて競合になった。
    expect(got.second.supersededMemoryIds).toHaveLength(1);
    expect(got.first.supersededMemoryIds).toEqual([]);
    expect(got.first.skipped.map((k) => k.kind)).toEqual(["status_changed_concurrently"]);
    expect(state.events).toEqual([
      "created:extracted",
      "created:extracted",
      "created:extracted",
      "superseded:reextract_superseded",
    ]);
  });

  it("reextract 対 reextract・①が LLM の中で止まる（読むのは LLM の後）: ②の後に①が読み直すので1件だけ active（A。2件にならない）", async () => {
    const kit = await makeKit();
    const observationId = await observeAndExtractOnce(kit, "初期");
    await race(
      holdFirstLlm(["候補A"], ["候補B"]),
      () => kit.runtime.reextract(ctx, observationId),
      () => kit.runtime.reextract(ctx, observationId),
    );
    const state = await readState(kit);
    expect(state.memories).toEqual([
      { status: "active", content: "候補A" },
      { status: "superseded", content: "候補B" },
      { status: "superseded", content: "初期" },
    ]);
  });

  it("tick の抽出①が LLM の中で止まり、reextract②が先に終わる: A・B の2件が active（負債: ADR 0347・ADR 0421）", async () => {
    const kit = await makeKit();
    const observationId = await observeDeferred(kit);
    const got = await race(
      holdFirstLlm(["候補A"], ["候補B"]),
      () => tickExtract(kit),
      () => kit.runtime.reextract(ctx, observationId),
    );
    const state = await readState(kit);
    expect(state.memories).toEqual([
      { status: "active", content: "候補A" },
      { status: "active", content: "候補B" },
    ]);
    expect(state.events).toEqual(["created:extracted", "created:extracted"]);
    expect(got.first.processed).toBe(1);
    expect(got.second.supersededMemoryIds).toEqual([]);
  });

  it("reextract①が書く直前で止まり、tick の抽出②が先に終わる: A・B の2件が active（負債: ADR 0347・ADR 0421）", async () => {
    const kit = await makeKit();
    const observationId = await observeDeferred(kit);
    llmOutputs(["候補A"], ["候補B"]);
    const got = await race(
      kit.holdNextWrite(),
      () => kit.runtime.reextract(ctx, observationId),
      () => tickExtract(kit),
    );
    const state = await readState(kit);
    expect(state.memories).toEqual([
      { status: "active", content: "候補A" },
      { status: "active", content: "候補B" },
    ]);
    expect(state.events).toEqual(["created:extracted", "created:extracted"]);
    expect(got.second.processed).toBe(1);
    expect(got.first.supersededMemoryIds).toEqual([]);
  });

  it("reextract①が LLM の中で止まり、tick の抽出②が先に終わる（読むのは LLM の後）: ①が B を読んで supersede するので1件だけ active（A。2件にならない）", async () => {
    const kit = await makeKit();
    const observationId = await observeDeferred(kit);
    await race(
      holdFirstLlm(["候補A"], ["候補B"]),
      () => kit.runtime.reextract(ctx, observationId),
      () => tickExtract(kit),
    );
    const state = await readState(kit);
    expect(state.memories).toEqual([
      { status: "active", content: "候補A" },
      { status: "superseded", content: "候補B" },
    ]);
  });
});
