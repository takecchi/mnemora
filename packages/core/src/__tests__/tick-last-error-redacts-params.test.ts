import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";
import { defaultDecayStrategy } from "../strategies/decay.js";
import { createRuntime } from "../runtime.js";
import { createFakeRuntimeStores } from "./runtime-fakes.js";

import type { NewMemory } from "../memory.js";

/**
 * Issue #1064（[ADR 0363](../../../docs/decisions/0363-outbox-last-error-omit-params-and-cap-length.md)）:
 * `tick()` の `lastError`（`describeJobFailure`）は、drizzle が包んだエラー文の `params:` 以降
 * （失敗したクエリに渡した値そのもの）を印に置き換え、戻り値全体の長さに上限（4096文字）を
 * 掛ける。
 *
 * 本物の drizzle/pg の包み方での「params が落ちること」の歯は `packages/postgres` の
 * `outbox-last-error-omits-params.postgres.test.ts` にある——ここでは Fake（testkit を経由しない、
 * `runtime-fakes.ts` の fake store）で、`describeJobFailure` そのものの2つの新しい振る舞い
 * （params の印への置き換え／全体の長さの上限）だけを、DB 無しで測る。
 *
 * `@mnemora/openai` の拒否の文面（ADR 0075）は `params:` という目印を持たないので、
 * params の置き換えでは塞がらない——長さの上限だけがこれを抑える。ここではその形を、
 * LLM provider が `params:` を持たない長大なメッセージを投げる形で模している
 * （Issue #1064 のコメント2件目が実測した経路と同じ形）。
 */

const ctx: Ctx = { tenantId: "tenant-1" };
// 以前の Fake は outbox 行の `availableAt` を実時刻で付けたため、runtime の時計を実時刻より後にしている。今の Fake は `opts.now` に従う（ADR 0555）ので、この置き方は必須ではない（組み替えは ADR 0555 の「残り」）。
const LATER = new Date(Date.now() + 60_000);

function newMemory(): NewMemory {
  const recordedAt = LATER;
  return {
    tenantId: "tenant-1",
    subjectId: null,
    sourceObservationId: null,
    extractorVersion: null,
    content: "本文",
    contentHash: `hash-${Math.random()}`,
    digest: "digest",
    digestSource: "llm",
    provenance: { kind: "imported", batchId: "fixture" },
    tags: [],
    occurredAt: null,
    recordedAt,
    lastReinforcedAt: null,
    strength: 1,
    halfLifeHours: 24,
    decayFloorAt: defaultDecayStrategy.floorAt({
      recordedAt,
      lastReinforcedAt: null,
      strength: 1,
      halfLifeHours: 24,
    }),
    embeddingStatus: "pending",
  };
}

const notUsedLlm: LLMProvider = {
  complete: async () => {
    throw new Error("not used");
  },
  completeStructured: async () => {
    throw new Error("not used");
  },
};

async function lastErrorFor(thrown: unknown): Promise<string | null | undefined> {
  const stores = createFakeRuntimeStores();
  const runtime = createRuntime({
    memoryStore: stores.memoryStore,
    outboxStore: stores.outboxStore,
    vectorStore: stores.vectorStore,
    eventStore: stores.eventStore,
    tenantSettingsStore: stores.tenantSettingsStore,
    llmProvider: notUsedLlm,
    embeddingProvider: stores.embeddingProvider,
    hashContent: (content: string) => `sha256(${content})`,
    clock: { now: () => LATER },
  });
  await stores.memoryStore.createMemoryWithOutbox(ctx, newMemory(), ["embed"]);
  stores.embeddingProvider.embed = async () => {
    throw thrown;
  };
  const result = await runtime.tick(ctx, { leaseMs: 60_000 });
  expect(result.failed).toBe(1);
  return stores.outboxStore.listJobs(ctx)[0]?.lastError;
}

describe("tick() の lastError は drizzle の params を落とし、長さに上限を掛ける（Issue #1064、ADR 0363）", () => {
  it("drizzle 形の 'Failed query: <SQL>\\nparams: <値>' は、params 側だけが印に置き換わる", async () => {
    const secretBody = `ユーザーの秘密の本文-${"x".repeat(500)}`;
    const drizzleShaped = new Error(
      `Failed query: \n  INSERT INTO memories (id, content)\n  VALUES ($1, $2)\nparams: mem-1,${secretBody}`,
    );
    const lastError = await lastErrorFor(drizzleShaped);

    expect(lastError).toBeDefined();
    // SQL の形は残る。
    expect(lastError).toContain("Failed query:");
    expect(lastError).toContain("INSERT INTO memories (id, content)");
    // params の値そのものはもう無い。
    expect(lastError).not.toContain(secretBody);
    expect(lastError).not.toContain("mem-1");
    // 印には、落とした文字数が読める。
    // "mem-1,<secretBody>" の文字数がそのまま omittedChars になる。
    const omittedChars = `mem-1,${secretBody}`.length;
    expect(lastError).toBe(
      `Failed query: \n  INSERT INTO memories (id, content)\n  VALUES ($1, $2)\nparams: (omitted by mnemora, ${omittedChars} chars)`,
    );
  });

  it("cause の連鎖の途中にある drizzle 形のメッセージも、その段だけ params が落ちる", async () => {
    const secretBody = "cause 側に載った秘密の値";
    const root = Object.assign(new Error(`Failed query: SELECT 1\nparams: ${secretBody}`), {
      code: "22021",
    });
    const outer = new Error("runtime.tick: embed job failed", { cause: root });
    const lastError = await lastErrorFor(outer);

    expect(lastError).toBe(
      `runtime.tick: embed job failed <- caused by: Failed query: SELECT 1\nparams: (omitted by mnemora, ${secretBody.length} chars) (code: 22021)`,
    );
    expect(lastError).not.toContain(secretBody);
  });

  it("params の値の中に '\\nparams: ' という文字列が含まれていても、最初の出現で切る（値の前半が残らない）", async () => {
    const paramsValue = "最初の秘密の値\nparams: 次の秘密の値";
    const lastError = await lastErrorFor(
      new Error(`Failed query: SELECT 1\nparams: ${paramsValue}`),
    );

    expect(lastError).toBe(
      `Failed query: SELECT 1\nparams: (omitted by mnemora, ${paramsValue.length} chars)`,
    );
    expect(lastError).not.toContain("最初の秘密の値");
  });

  it("'params: ' が改行の直後に付いていない文面（SQL の中の文字列など）は、落とさず今までどおり残す", async () => {
    const message = "Failed query: SELECT 'see params: not a drizzle marker'";
    expect(await lastErrorFor(new Error(message))).toBe(message);
  });

  it("params: を持たない長大なメッセージ（openai の拒否の文面のような形）は、長さの上限で切られる", async () => {
    // ADR 0075 の refusalMessage のように、モデルが利用者の本文を引用して拒否した体で、
    // "params:" という目印を持たない長い文面を作る（実際の OpenAILLMProviderError と同型ではなく、
    // 「params: を持たない・上限を超える長さ」という性質だけを模している）。
    const quotedSecret = "ユーザーの口座番号は1234-5678-9012です".repeat(200);
    const refusalShaped = new Error(
      `runtime.tick: consolidate job failed because the llm call failed: OpenAILLMProvider: the model refused to answer (I can't help with ${quotedSecret}) (finish_reason: stop)`,
    );
    expect(refusalShaped.message.length).toBeGreaterThan(4096);
    expect(refusalShaped.message).not.toContain("\nparams: ");

    const lastError = await lastErrorFor(refusalShaped);
    expect(lastError).toBeDefined();
    const value = lastError as string;

    // 上限より長くはならない（切り詰めの印の分だけ多少超えることはあるので、
    // 「元の長さよりはっきり短い」ことと「一定の余裕の範囲に収まる」ことを測る）。
    expect(value.length).toBeLessThan(refusalShaped.message.length);
    expect(value.length).toBeLessThan(4200);
    // 末尾に「切ったこと」と「元の長さ」が読める印が付く。
    expect(value).toContain("… (truncated by mnemora, original length");
    expect(value).toContain(`${refusalShaped.message.length} chars)`);
    // 引用された秘密の値の末尾側は、もう残っていない。
    expect(value).not.toContain(quotedSecret);
  });

  it("上限以下のメッセージは、今までどおり変わらない（回帰）", async () => {
    expect(await lastErrorFor(new Error("just a message"))).toBe("just a message");
  });
});
