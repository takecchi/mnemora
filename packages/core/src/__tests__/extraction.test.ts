import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  buildExtractionPrompt,
  buildNewMemoryFromCandidate,
  describeExtractionFailure,
  extractCandidates,
  resolveDigest,
  sanitizeCandidateSubjectId,
  truncateForFallbackDigest,
  type ExtractedMemoryCandidate,
} from "../extraction.js";
import { z } from "zod";
import type { LLMProvider, PromptSpec, StructuredRequest } from "../interfaces/llm-provider.js";
import type { Observation } from "../observation.js";

/**
 * `llmCassetteKey`（`packages/testkit/src/__fixtures__/cassette.ts`）と同じ
 * 正規化・ハッシュ手順のローカル再実装。**core は testkit に devDependency を持てない**
 * （`dependency-boundary.test.ts` が「dependencies のキーは ['zod'] のみ」と機械的に
 * 検査しており、`testkit` は `core` に依存する側なので循環になる）ため、ここでは
 * `node:crypto` だけで同じ手順を再現し、「`PromptSpec` が1バイトも変わらなければ
 * 鍵も変わらない」ことを、鍵そのものの計算で確かめる（Issue #608 項目②(b)、
 * ADR 0271 前提1と同じ検証手順）。
 */
function llmCassetteKeyLocal(prompt: PromptSpec): string {
  const canonical = JSON.stringify({
    system: prompt.system ?? null,
    messages: prompt.messages.map((m) => ({ role: m.role, content: m.content })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const ctx: Ctx = { tenantId: "tenant-1" };

function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    id: "obs-1",
    tenantId: "tenant-1",
    subjectId: "user-1",
    externalId: null,
    kind: "utterance",
    payload: { text: "明日は東京に出張する予定です", speaker: "田中" },
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    recordedAt: new Date("2026-01-01T00:00:01.000Z"),
    ...overrides,
  };
}

/** テストごとに固定の候補集合を返すだけの LLMProvider フェイク。 */
function llmProviderReturning(memories: ExtractedMemoryCandidate[]): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
      return req.schema.parse({ memories }) as T;
    },
  };
}

function throwingLlmProvider(): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async () => {
      throw new Error("simulated LLM failure (timeout/network)");
    },
  };
}

/** provider が `kind` 付きで投げる想定（`@mnemora/openai` / `@mnemora/anthropic` の模倣）。 */
function throwingLlmProviderWithKind(kind: string, message: string): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async () => {
      const error = new Error(message) as Error & { kind: string };
      error.kind = kind;
      throw error;
    },
  };
}

describe("extractCandidates（roadmap.md 段階3の基本抽出）", () => {
  it("LLM が候補を返せば、そのまま candidates として返す（フォールバックしない）", async () => {
    const provider = llmProviderReturning([
      { content: "東京出張の予定がある", digest: "東京出張予定", provenanceKind: "stated" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation());
    expect(result.usedWholeObservationFallback).toBe(false);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.content).toBe("東京出張の予定がある");
    // 成功経路（0件を含む）は必ず failure: null（「間違った有る」を作らない）。
    expect(result.failure).toBeNull();
  });

  it("LLM が0件を返した場合はフォールバックしない（『何も無い』は正常系）", async () => {
    const provider = llmProviderReturning([]);
    const result = await extractCandidates(provider, ctx, makeObservation());
    expect(result.usedWholeObservationFallback).toBe(false);
    expect(result.candidates).toEqual([]);
    expect(result.failure).toBeNull();
  });

  it("LLM 呼び出し自体が失敗したら、全文をそのまま1件の stated Memory 候補として残す（安全弁）", async () => {
    const provider = throwingLlmProvider();
    const observation = makeObservation();
    const result = await extractCandidates(provider, ctx, observation);
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.content).toBe("明日は東京に出張する予定です");
    expect(result.candidates[0]?.provenanceKind).toBe("stated");
    // 失敗経路は必ず failure が非 null。kind を名乗らない Error は kind: null になる。
    expect(result.failure).toEqual({
      kind: null,
      message: "simulated LLM failure (timeout/network)",
    });
  });

  it("provider が kind 付きで投げたら、failure.kind にその値がそのまま運ばれる（中身を捨てない）", async () => {
    const provider = throwingLlmProviderWithKind("refusal", "the model refused to answer");
    const result = await extractCandidates(provider, ctx, makeObservation());
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.failure).toEqual({ kind: "refusal", message: "the model refused to answer" });
  });

  it("フォールバック候補は payload.text が無い document/event でも空文字にならない", async () => {
    const provider = throwingLlmProvider();
    const observation = makeObservation({
      kind: "event",
      payload: { name: "login", data: { ip: "127.0.0.1" } },
    });
    const result = await extractCandidates(provider, ctx, observation);
    expect(result.candidates[0]?.content).toBe("login");
  });
});

describe("resolveDigest（docs/memory-model.md §4 の安全弁）", () => {
  it("LLM の digest が非空なら、それをそのまま使い digestSource は 'llm'", () => {
    const resolved = resolveDigest({ content: "本文", digest: "要旨" }, 200);
    expect(resolved).toEqual({ digest: "要旨", digestSource: "llm" });
  });

  it("digest が undefined ならフォールバックし digestSource は 'fallback'", () => {
    const resolved = resolveDigest({ content: "本文がここに入る", digest: undefined }, 200);
    expect(resolved.digestSource).toBe("fallback");
    expect(resolved.digest).toBe("本文がここに入る");
  });

  it("digest が空白のみならフォールバックする（LLM が空文字を返した場合と同じ扱い）", () => {
    const resolved = resolveDigest({ content: "本文", digest: "   " }, 200);
    expect(resolved.digestSource).toBe("fallback");
  });
});

describe("truncateForFallbackDigest", () => {
  it("maxLength 以下ならそのまま（末尾の … を付けない）", () => {
    expect(truncateForFallbackDigest("短い本文", 200)).toBe("短い本文");
  });

  it("maxLength を超えたら切り詰めて … を付ける", () => {
    const long = "あ".repeat(10);
    const result = truncateForFallbackDigest(long, 5);
    expect(result).toBe(`${"あ".repeat(5)}…`);
  });

  it("空文字（trim後）には固定のプレースホルダを返す（NOT NULL 制約を満たすため）", () => {
    expect(truncateForFallbackDigest("   ", 200)).toBe("（内容なし）");
  });
});

describe("buildNewMemoryFromCandidate", () => {
  const baseParams = {
    ctx,
    hashContent: (content: string) => `hash(${content})`,
    extractorVersion: "v1",
    llmModelId: "test-model",
    promptVersion: "prompt-v1",
    halfLifeHours: 720,
    now: new Date("2026-02-01T00:00:00.000Z"),
    digestFallbackLength: 200,
  };

  it("provenanceKind: 'stated' は sourceObservationId・at・speaker を持つ", () => {
    const observation = makeObservation();
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "本文", digest: "要旨", provenanceKind: "stated" },
    });
    expect(memory.provenance).toEqual({
      kind: "stated",
      sourceObservationId: "obs-1",
      at: observation.occurredAt!.toISOString(),
      speaker: "田中",
    });
    expect(memory.sourceObservationId).toBe("obs-1");
    expect(memory.extractorVersion).toBe("v1");
    expect(memory.contentHash).toBe("hash(本文)");
    expect(memory.digestSource).toBe("llm");
    expect(memory.embeddingStatus).toBe("pending");
  });

  it("speaker が payload に無い場合、stated provenance に speaker フィールドを含めない", () => {
    const observation = makeObservation({ payload: { text: "本文のみ" } });
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "本文", provenanceKind: "stated" },
    });
    expect(memory.provenance.kind).toBe("stated");
    expect("speaker" in memory.provenance).toBe(false);
  });

  it("provenanceKind: 'inferred' は model/promptVersion/basis/confidence を持つ", () => {
    const observation = makeObservation();
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "推論した内容", provenanceKind: "inferred", confidence: 0.8 },
    });
    expect(memory.provenance).toEqual({
      kind: "inferred",
      model: "test-model",
      promptVersion: "prompt-v1",
      basis: { memoryIds: [], observationIds: ["obs-1"] },
      confidence: 0.8,
    });
  });

  it("provenanceKind: 'inferred' で confidence が省略されたら既定値 0.5 を使う", () => {
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation: makeObservation(),
      candidate: { content: "推論した内容", provenanceKind: "inferred" },
    });
    expect(memory.provenance.kind === "inferred" && memory.provenance.confidence).toBe(0.5);
  });

  it("occurredAt が無い Observation では recordedAt を freshness の起点として使う（stated.at）", () => {
    const observation = makeObservation({ occurredAt: null });
    const memory = buildNewMemoryFromCandidate({
      ...baseParams,
      observation,
      candidate: { content: "本文", provenanceKind: "stated" },
    });
    expect(memory.occurredAt).toBeNull();
    expect(memory.provenance.kind === "stated" && memory.provenance.at).toBe(
      observation.recordedAt.toISOString(),
    );
  });

  /**
   * Issue #608 項目①: 抽出候補ごとに `subjectId` を持てるようにする。
   *
   * 「候補が subjectId を持たない（省略・undefined）」＝**未指定**として従来どおり
   * observation の値へ落ちる。「候補が明示的に null を持つ」＝**主題なしを明示**として、
   * observation の値があっても null で上書きする。この線引きの理由・採らなかった案
   * （null を「未指定」と読む案）は ADR 0271 を見ること。
   */
  describe("candidate.subjectId（Issue #608 項目①）", () => {
    it("候補が subjectId を持てば、observation の値より優先される", () => {
      const observation = makeObservation({ subjectId: "user-observation" });
      const memory = buildNewMemoryFromCandidate({
        ...baseParams,
        observation,
        candidate: { content: "本文", provenanceKind: "stated", subjectId: "user-candidate" },
      });
      expect(memory.subjectId).toBe("user-candidate");
    });

    it("候補の subjectId が明示的に null なら、observation の値があっても『主題なし』にする", () => {
      const observation = makeObservation({ subjectId: "user-observation" });
      const memory = buildNewMemoryFromCandidate({
        ...baseParams,
        observation,
        candidate: { content: "本文", provenanceKind: "stated", subjectId: null },
      });
      expect(memory.subjectId).toBeNull();
    });

    it("候補が subjectId を持たない（未指定）なら、従来どおり observation の値へ落ちる", () => {
      const observation = makeObservation({ subjectId: "user-observation" });
      const memory = buildNewMemoryFromCandidate({
        ...baseParams,
        observation,
        candidate: { content: "本文", provenanceKind: "stated" },
      });
      expect(memory.subjectId).toBe("user-observation");
    });

    it("候補が subjectId を持たず、observation にも無ければ null になる（既存の振る舞い）", () => {
      const observation = makeObservation({ subjectId: null });
      const memory = buildNewMemoryFromCandidate({
        ...baseParams,
        observation,
        candidate: { content: "本文", provenanceKind: "stated" },
      });
      expect(memory.subjectId).toBeNull();
    });
  });
});

/**
 * `describeExtractionFailure`（ADR 0072 追記）の単体の歯。
 *
 * ⚠ core は provider のクラスを知らない（`instanceof` は使えない）ので、`kind` を名乗らない
 * エラーで `kind` を勝手な種類に読み替えないことを固定する。
 */
describe("describeExtractionFailure", () => {
  it("kind: string を持つオブジェクトが投げられたら、その値をそのまま kind として運ぶ", () => {
    const error = new Error("truncated") as Error & { kind: string };
    error.kind = "truncated";
    expect(describeExtractionFailure(error)).toEqual({ kind: "truncated", message: "truncated" });
  });

  it("素の Error（kind を持たない）は kind: null になる", () => {
    const error = new Error("simulated LLM outage");
    expect(describeExtractionFailure(error)).toEqual({
      kind: null,
      message: "simulated LLM outage",
    });
  });

  it("ZodError（スキーマ不適合）は kind: null、message は Error のものになる", () => {
    const schema = z.object({ memories: z.array(z.string()) });
    const parseResult = schema.safeParse({ memories: [123] });
    expect(parseResult.success).toBe(false);
    const zodError = parseResult.success ? undefined : parseResult.error;
    const result = describeExtractionFailure(zodError);
    expect(result.kind).toBeNull();
    expect(result.message).toBe(zodError!.message);
  });

  it("文字列がそのまま投げられても（非 Error）落ちず、message は String(error) 相当、kind は null", () => {
    expect(describeExtractionFailure("plain string thrown")).toEqual({
      kind: null,
      message: "plain string thrown",
    });
  });

  it("undefined が投げられても落ちず、kind は null", () => {
    expect(describeExtractionFailure(undefined)).toEqual({ kind: null, message: "undefined" });
  });

  it("null が投げられても落ちない（オプショナルチェイニングで kind を安全に読む）", () => {
    expect(describeExtractionFailure(null)).toEqual({ kind: null, message: "null" });
  });

  it("kind が空文字なら null 扱いにする（『分からない』を空文字という別の種類に読み替えない）", () => {
    const error = new Error("empty kind") as Error & { kind: string };
    error.kind = "";
    expect(describeExtractionFailure(error).kind).toBeNull();
  });

  it("kind が数値など非文字列なら null 扱いにする", () => {
    const error = new Error("numeric kind") as unknown as Error & { kind: number };
    error.kind = 42;
    expect(describeExtractionFailure(error).kind).toBeNull();
  });

  it("プレーンオブジェクト（Error ではない）が投げられても落ちず、message は String(error) 相当", () => {
    const result = describeExtractionFailure({ someField: "value" });
    expect(result.kind).toBeNull();
    expect(result.message).toBe(String({ someField: "value" }));
  });
});

/**
 * Issue #608 項目②(b): 呼び出し側が subject の候補一覧を渡し、抽出器（LLM）に選ばせる口。
 * `buildExtractionPrompt` の文面がどう変わるか／変わらないかを固定する
 * （ADR 0NNN 変異試験1・2 に対応）。
 */
describe("buildExtractionPrompt（Issue #608 項目②(b)）", () => {
  const BASE_SYSTEM =
    "あなたは会話・イベント・文書から再利用可能な記憶を抽出するアシスタントです。" +
    "本人が明示的に述べた事実は provenanceKind: 'stated' として、それ以外の推論は " +
    "'inferred' として区別してください。何も記憶に値しない場合は空配列を返してください。";

  it("subjectCandidates を渡さなければ、PromptSpec は①以前の文面と1バイトも違わない", () => {
    const observation = makeObservation();
    const prompt = buildExtractionPrompt(observation);
    expect(prompt).toEqual({
      system: BASE_SYSTEM,
      messages: [{ role: "user", content: "明日は東京に出張する予定です" }],
    });
  });

  it("subjectCandidates: undefined と省略は、同じ PromptSpec になる", () => {
    const observation = makeObservation();
    expect(buildExtractionPrompt(observation, undefined)).toEqual(
      buildExtractionPrompt(observation),
    );
  });

  it("subjectCandidates: [] （空配列）は『渡していない』と同じ PromptSpec になる", () => {
    const observation = makeObservation();
    expect(buildExtractionPrompt(observation, [])).toEqual(buildExtractionPrompt(observation));
  });

  it("subjectCandidates 省略時の鍵（llmCassetteKey 相当）は固定値のまま動かない", () => {
    const observation = makeObservation();
    const key = llmCassetteKeyLocal(buildExtractionPrompt(observation));
    // 2026-09-24、subjectCandidates を足す前の文面から計算した鍵をそのまま固定する。
    // この値が変わったら、既存の録音済みカセット（examples/chat/cassettes/*.json）の
    // 照合鍵と食い違う——このテストが赤くなれば、それが実際に壊れた合図になる。
    expect(key).toBe("7f158f7ed09fdfd049d8b833e53e8a2c8d550edf8c621bb20d5b99039c1e02f6");
  });

  it("subjectCandidates を渡すと、候補一覧と null の指示の両方が system に足される", () => {
    const observation = makeObservation();
    const prompt = buildExtractionPrompt(observation, ["user:a", "user:b"]);
    // ベースの文面はそのまま残る（先頭に含まれる）——足すだけで、削ったり書き換えたり
    // しないことを固定する。
    expect(prompt.system?.startsWith(BASE_SYSTEM)).toBe(true);
    expect(prompt.system).toContain("user:a");
    expect(prompt.system).toContain("user:b");
    // ADR 0271「引き受けた負債1」の申し送り: 一覧に無い・主題が無いなら null を明示させる。
    expect(prompt.system).toContain("null");
    // messages（ユーザー発話本文）は候補一覧の影響を受けない。
    expect(prompt.messages).toEqual([{ role: "user", content: "明日は東京に出張する予定です" }]);
  });

  it("subjectCandidates を渡すと、鍵（llmCassetteKey 相当）は渡さない場合と異なる", () => {
    const observation = makeObservation();
    const withoutCandidates = llmCassetteKeyLocal(buildExtractionPrompt(observation));
    const withCandidates = llmCassetteKeyLocal(buildExtractionPrompt(observation, ["user:a"]));
    expect(withCandidates).not.toBe(withoutCandidates);
  });
});

describe("sanitizeCandidateSubjectId（Issue #608 項目②(b)）", () => {
  it("一覧に含まれる文字列は、そのまま有効", () => {
    expect(sanitizeCandidateSubjectId("user:a", ["user:a", "user:b"])).toEqual({
      subjectId: "user:a",
      rejected: false,
    });
  });

  it("一覧に無い文字列は弾かれ、undefined（未指定）へ戻る", () => {
    expect(sanitizeCandidateSubjectId("user:c", ["user:a", "user:b"])).toEqual({
      subjectId: undefined,
      rejected: true,
    });
  });

  it("null は一覧に無くても常に有効（『主題なし』は一覧の値とは別のもの）", () => {
    expect(sanitizeCandidateSubjectId(null, ["user:a"])).toEqual({
      subjectId: null,
      rejected: false,
    });
    expect(sanitizeCandidateSubjectId(null, [])).toEqual({ subjectId: null, rejected: false });
    expect(sanitizeCandidateSubjectId(null, undefined)).toEqual({
      subjectId: null,
      rejected: false,
    });
  });

  it("undefined（省略）は一覧の有無に関わらず常に有効", () => {
    expect(sanitizeCandidateSubjectId(undefined, ["user:a"])).toEqual({
      subjectId: undefined,
      rejected: false,
    });
  });

  it("一覧が undefined なら、どんな文字列も検証せず素通しする（① だけの既存呼び出しと同じ）", () => {
    expect(sanitizeCandidateSubjectId("user:anything", undefined)).toEqual({
      subjectId: "user:anything",
      rejected: false,
    });
  });

  it("一覧が空配列なら、『渡していない』と同じで素通しする", () => {
    expect(sanitizeCandidateSubjectId("user:anything", [])).toEqual({
      subjectId: "user:anything",
      rejected: false,
    });
  });

  /**
   * 【実測】gpt-4o-mini に実 API を当てて確認した事象（調査タスク、コミットなし）:
   * `subjectCandidates` を渡したときのプロンプト指示（「主題が無いなら明示的に null を
   * 設定してください」）に対し、モデルは JSON の `null` リテラルではなく**文字列
   * `"null"`（ダブルクォート付き）**を5/5回返した。この文字列は一覧に含まれないため、
   * 修正前のコードでは「一覧外の値」として弾かれ（`rejected: true`）、
   * `undefined`（未指定）へ戻り、observation の値へフォールバックしていた——
   * Issue #608 の例2（「明日台風が来る 主題＝なし」）が実現できない、という形で現れる。
   */
  describe('文字列 "null"（LLM が JSON null の代わりに返す既知の事象）', () => {
    it('一覧に "null" という文字列自体が候補として含まれていなければ、明示的な null（主題なし）として扱う', () => {
      expect(sanitizeCandidateSubjectId("null", ["A", "B", "movie-1"])).toEqual({
        subjectId: null,
        rejected: false,
      });
    });

    it('一覧に "null" という文字列自体が候補として含まれているなら、通常の一覧内の値として扱う（この規約が優先）', () => {
      expect(sanitizeCandidateSubjectId("null", ["A", "null"])).toEqual({
        subjectId: "null",
        rejected: false,
      });
    });

    it('一覧が undefined なら、文字列 "null" もただの文字列として素通しする（候補なし経路は1バイトも変えない）', () => {
      expect(sanitizeCandidateSubjectId("null", undefined)).toEqual({
        subjectId: "null",
        rejected: false,
      });
    });

    it('一覧が空配列なら、文字列 "null" もただの文字列として素通しする（候補なし経路は1バイトも変えない）', () => {
      expect(sanitizeCandidateSubjectId("null", [])).toEqual({
        subjectId: "null",
        rejected: false,
      });
    });
  });
});

describe("extractCandidates × subjectCandidates（Issue #608 項目②(b)）", () => {
  it("一覧内の subjectId はそのまま候補に残る", async () => {
    const provider = llmProviderReturning([
      { content: "Aさんは面白いと思った", provenanceKind: "stated", subjectId: "user:a" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation(), ["user:a", "user:b"]);
    expect(result.candidates[0]?.subjectId).toBe("user:a");
    expect(result.rejectedSubjectIds).toEqual([]);
  });

  it("一覧外の subjectId は弾かれ、未指定（undefined）になる。弾いた値は rejectedSubjectIds に残る", async () => {
    const provider = llmProviderReturning([
      { content: "Cさんは...", provenanceKind: "stated", subjectId: "user:c" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation(), ["user:a", "user:b"]);
    expect(result.candidates[0]?.subjectId).toBeUndefined();
    expect(result.rejectedSubjectIds).toEqual(["user:c"]);
  });

  it("null（主題なし）は一覧外でも弾かれない", async () => {
    const provider = llmProviderReturning([
      { content: "主題なしの記憶", provenanceKind: "stated", subjectId: null },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation(), ["user:a"]);
    expect(result.candidates[0]?.subjectId).toBeNull();
    expect(result.rejectedSubjectIds).toEqual([]);
  });

  it('LLM が文字列 "null" を返した場合（実 API の既知の事象）、一覧外でも弾かれず null（主題なし）になる', async () => {
    const provider = llmProviderReturning([
      { content: "明日台風が来るらしい", provenanceKind: "stated", subjectId: "null" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation(), ["A", "B", "movie-1"]);
    expect(result.candidates[0]?.subjectId).toBeNull();
    expect(result.rejectedSubjectIds).toEqual([]);
  });

  it("subjectCandidates を渡さなければ、①の挙動（検証なし）のまま", async () => {
    const provider = llmProviderReturning([
      { content: "任意の主題", provenanceKind: "stated", subjectId: "anything-goes" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation());
    expect(result.candidates[0]?.subjectId).toBe("anything-goes");
    expect(result.rejectedSubjectIds).toEqual([]);
  });

  it("空配列を渡した場合も、①の挙動（検証なし）のまま", async () => {
    const provider = llmProviderReturning([
      { content: "任意の主題", provenanceKind: "stated", subjectId: "anything-goes" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation(), []);
    expect(result.candidates[0]?.subjectId).toBe("anything-goes");
    expect(result.rejectedSubjectIds).toEqual([]);
  });

  it("複数候補が混在しても、候補ごとに独立して検証される", async () => {
    const provider = llmProviderReturning([
      { content: "Aさん", provenanceKind: "stated", subjectId: "user:a" },
      { content: "一覧外", provenanceKind: "stated", subjectId: "user:z" },
      { content: "主題なし", provenanceKind: "stated", subjectId: null },
      { content: "省略", provenanceKind: "stated" },
    ]);
    const result = await extractCandidates(provider, ctx, makeObservation(), ["user:a"]);
    expect(result.candidates.map((c) => c.subjectId)).toEqual([
      "user:a",
      undefined,
      null,
      undefined,
    ]);
    expect(result.rejectedSubjectIds).toEqual(["user:z"]);
  });

  it("LLM 呼び出しが失敗した場合（全文フォールバック）は、rejectedSubjectIds は空配列", async () => {
    const provider = throwingLlmProvider();
    const result = await extractCandidates(provider, ctx, makeObservation(), ["user:a"]);
    expect(result.usedWholeObservationFallback).toBe(true);
    expect(result.rejectedSubjectIds).toEqual([]);
  });
});
