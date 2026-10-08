import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  buildClaimKeyPrompt,
  ClaimKeyBatchResultSchema,
  deriveClaimKeys,
  normalizeClaimKey,
  normalizeClaimKeyPart,
} from "../claim-key.js";
import { describeExtractionFailure } from "../extraction.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("normalizeClaimKeyPart（Issue #371、ADR 0185/0315 決定3）", () => {
  it("NFKC正規化・前後空白除去・小文字化・内部空白の _ への畳み込みを行う", () => {
    expect(normalizeClaimKeyPart("  Favorite Food  ")).toBe("favorite_food");
  });

  it("全角文字を NFKC で半角相当に正規化する", () => {
    expect(normalizeClaimKeyPart("ＵＳＥＲ")).toBe("user");
  });

  it("べき等——2回適用しても結果が変わらない", () => {
    const once = normalizeClaimKeyPart("  Favorite   Food  ");
    const twice = normalizeClaimKeyPart(once);
    expect(twice).toBe(once);
  });

  it("複数の連続空白を単一の _ に畳む", () => {
    expect(normalizeClaimKeyPart("favorite   food")).toBe("favorite_food");
  });

  it("空白でない区切り（ハイフン・ドット・スラッシュ）は畳まず、そのまま残す", () => {
    expect(normalizeClaimKeyPart("favorite-food")).toBe("favorite-food");
    expect(normalizeClaimKeyPart("home.city")).toBe("home.city");
    expect(normalizeClaimKeyPart("Work / Role")).toBe("work_/_role");
  });

  it("normalizeClaimKey は subject/predicate の両方に正規化を適用する", () => {
    expect(normalizeClaimKey({ subject: " User ", predicate: "Favorite Food" })).toEqual({
      subject: "user",
      predicate: "favorite_food",
    });
  });
});

describe("buildClaimKeyPrompt（Issue #371）", () => {
  it("既知 predicate 一覧を渡さなければ、その文言を含まない", () => {
    const prompt = buildClaimKeyPrompt(["ラーメンが好き"]);
    expect(prompt.system).not.toContain("既知の predicate 候補一覧");
  });

  it("既知 predicate 一覧を渡すと、system にその一覧が足される（ADR 0271 と同型）", () => {
    const prompt = buildClaimKeyPrompt(["ラーメンが好き"], ["favorite_food", "favorite_color"]);
    expect(prompt.system).toContain("favorite_food");
    expect(prompt.system).toContain("favorite_color");
    expect(prompt.system).toContain("既知の predicate 候補一覧");
  });

  it("空配列の既知 predicate 一覧は『渡していない』と同じ（subjectCandidates と同じ規約）", () => {
    const withEmpty = buildClaimKeyPrompt(["発話"], []);
    const withoutAny = buildClaimKeyPrompt(["発話"]);
    expect(withEmpty).toEqual(withoutAny);
  });

  it("messages には各候補の content がそのまま入る（順序を保つ）", () => {
    const prompt = buildClaimKeyPrompt(["第一の記憶", "第二の記憶"]);
    const parsed = JSON.parse(prompt.messages[0]!.content) as { memories: { content: string }[] };
    expect(parsed.memories).toEqual([{ content: "第一の記憶" }, { content: "第二の記憶" }]);
  });

  it("この system 文面は extraction.ts の EXTRACTION_PROMPT_SYSTEM_BASE と共有しない（別の独立したプロンプト）", () => {
    const prompt = buildClaimKeyPrompt(["発話"]);
    expect(prompt.system).not.toContain("provenanceKind");
  });

  // 逐語で固定する: 既存カセットの `llmCassetteKey` が動かないことの直接の証拠になる。
  const CLAIM_KEY_PROMPT_SYSTEM_LITERAL =
    "あなたは、複数の記憶候補それぞれが「何についての主張か」を判定するアシスタントです。" +
    "入力は記憶候補の配列であり、各要素の content がその記憶の本文です。" +
    "各記憶候補について、その記憶が何についての主張かを表す claim key（subject と predicate の組）を" +
    "1つずつ、入力と同じ順序・同じ件数で返してください。" +
    "subject は主張の主語（例: 'user'）、predicate は属性名を表す正規化済みの英語 snake_case 文字列" +
    "（例: 'favorite_food'）です。同じ主題・属性について複数回言及されている記憶には、" +
    "値や表現が違っていても同じ subject と predicate を返してください（言い換えを統合すること）。" +
    "無関係な主題の記憶には異なる predicate を割り当ててください。";

  it("knownPredicates も knownSubjects も渡さない（off）と、system は CLAIM_KEY_PROMPT_SYSTEM と1バイトも違わない", () => {
    const prompt = buildClaimKeyPrompt(["ラーメンが好き"]);
    expect(prompt.system).toBe(CLAIM_KEY_PROMPT_SYSTEM_LITERAL);
  });

  it("既知 subject 一覧を渡さなければ、その文言を含まない", () => {
    const prompt = buildClaimKeyPrompt(["ラーメンが好き"]);
    expect(prompt.system).not.toContain("既知の subject 候補一覧");
  });

  it("既知 subject 一覧を渡すと、system にその一覧が足される（knownPredicates と同型）", () => {
    const prompt = buildClaimKeyPrompt(["姉は福岡で働いています。"], undefined, ["user", "姉"]);
    expect(prompt.system).toContain("既知の subject 候補一覧");
    expect(prompt.system).toContain("user");
    expect(prompt.system).toContain("姉");
  });

  it("既知 subject 一覧を渡すと、第三者の主語は 'user' ではなくその第三者を指す subject にする指示が足される（ADR 0334 の機構。Issue #1775 の #792）", () => {
    const prompt = buildClaimKeyPrompt(["発話"], undefined, ["user", "姉"]);
    expect(prompt.system).toContain("第三者");
    expect(prompt.system).toContain("'user' ではなく");
  });

  it("空配列の既知 subject 一覧は『渡していない』と同じ", () => {
    const withEmpty = buildClaimKeyPrompt(["発話"], undefined, []);
    const withoutAny = buildClaimKeyPrompt(["発話"]);
    expect(withEmpty).toEqual(withoutAny);
  });

  it("knownPredicates と knownSubjects の両方を渡すと、predicate の文言が先・subject の文言が後ろに来る", () => {
    const prompt = buildClaimKeyPrompt(["発話"], ["favorite_food"], ["user", "姉"]);
    const system = prompt.system as string;
    const predicateIndex = system.indexOf("既知の predicate 候補一覧");
    const subjectIndex = system.indexOf("既知の subject 候補一覧");
    expect(predicateIndex).toBeGreaterThanOrEqual(0);
    expect(subjectIndex).toBeGreaterThan(predicateIndex);
  });
});

function llmReturning(response: unknown): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> =>
      req.schema.parse(response) as T,
  };
}

function throwingLlm(message: string): LLMProvider {
  return {
    complete: async () => {
      throw new Error("not used in this test");
    },
    completeStructured: async () => {
      throw new Error(message);
    },
  };
}

describe("deriveClaimKeys（Issue #371、ADR 0185/0315 決定2 の (ii) separate）", () => {
  it("候補が0件なら、LLM を一度も呼ばずに空配列を返す", async () => {
    let called = false;
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        called = true;
        throw new Error("should not be called");
      },
    };
    const result = await deriveClaimKeys(provider, ctx, []);
    expect(called).toBe(false);
    expect(result).toEqual({ claimKeys: [], failure: null });
  });

  it("成功時は、正規化済みの claimKey を入力と同じ順序で返す", async () => {
    const provider = llmReturning({
      claims: [
        { subject: "User", predicate: "Favorite Food" },
        { subject: "user", predicate: "favorite_color" },
      ],
    });
    const result = await deriveClaimKeys(provider, ctx, ["好きな食べ物はラーメン", "好きな色は青"]);
    expect(result.failure).toBeNull();
    expect(result.claimKeys).toEqual([
      { subject: "user", predicate: "favorite_food" },
      { subject: "user", predicate: "favorite_color" },
    ]);
  });

  it("既知 predicate 一覧を渡す", async () => {
    let capturedSystem: string | undefined;
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        capturedSystem = req.prompt.system;
        return req.schema.parse({ claims: [{ subject: "user", predicate: "favorite_food" }] }) as T;
      },
    };
    await deriveClaimKeys(provider, ctx, ["発話"], ["favorite_food"]);
    expect(capturedSystem).toContain("favorite_food");
  });

  it("既知 subject 一覧を渡す（Issue #372負債6、ADR 0334）", async () => {
    let capturedSystem: string | undefined;
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        capturedSystem = req.prompt.system;
        return req.schema.parse({
          claims: [{ subject: "姉", predicate: "sibling_residence" }],
        }) as T;
      },
    };
    await deriveClaimKeys(provider, ctx, ["姉は福岡で働いています。"], undefined, ["user", "姉"]);
    expect(capturedSystem).toContain("既知の subject 候補一覧");
    expect(capturedSystem).toContain("姉");
  });

  it("LLM 呼び出しが失敗したら、全要素 null・failure 非 null を返す（部分成功にしない）", async () => {
    const provider = throwingLlm("simulated outage");
    const result = await deriveClaimKeys(provider, ctx, ["発話1", "発話2"]);
    expect(result.claimKeys).toEqual([null, null]);
    expect(result.failure).not.toBeNull();
    expect(result.failure?.message).toBe("simulated outage");
  });

  it("返った件数が入力と一致しないとき、対応付けを推測せず全要素 null にする", async () => {
    const provider = llmReturning({
      claims: [{ subject: "user", predicate: "favorite_food" }],
    });
    const result = await deriveClaimKeys(provider, ctx, ["発話1", "発話2", "発話3"]);
    expect(result.claimKeys).toEqual([null, null, null]);
    expect(result.failure).not.toBeNull();
    expect(result.failure?.kind).toBe("claim_key_length_mismatch");
  });

  it("subject/predicate が空白だけ（正規化後に空文字列になる）なら、その要素は null にする（無関係な Memory 同士が空の鍵で衝突するのを防ぐ）", async () => {
    // スキーマの `min(1)` は素通りする（" " は長さ1）が、`normalizeClaimKeyPart` の
    // trim で空文字列に潰れる——このケースを `{ subject: "", predicate: "" }` のまま
    // 返すと、無関係な2件の Memory が同じ「空の鍵」で誤って一致してしまう
    // （`runtime.ts` の `detectClaimKeyContested`）。
    const provider = llmReturning({
      claims: [
        { subject: " ", predicate: "favorite_food" },
        { subject: "user", predicate: "　" }, // 全角スペース
        { subject: "  ", predicate: "  " },
        { subject: "user", predicate: "favorite_food" },
      ],
    });
    const result = await deriveClaimKeys(provider, ctx, ["発話1", "発話2", "発話3", "発話4"]);
    expect(result.claimKeys).toEqual([
      null,
      null,
      null,
      { subject: "user", predicate: "favorite_food" },
    ]);
    expect(result.failure).toBeNull();
  });

  it("空白だけの要素は、半角・全角のスペース以外（タブ・改行・NBSP・混在）でも null にする", async () => {
    const provider = llmReturning({
      claims: [
        { subject: "\t", predicate: "favorite_food" },
        { subject: "user", predicate: "\n" },
        { subject: " ", predicate: "favorite_food" },
        { subject: " \t\n　 ", predicate: "\r\n" },
      ],
    });
    const result = await deriveClaimKeys(provider, ctx, ["発話1", "発話2", "発話3", "発話4"]);
    expect(result.claimKeys).toEqual([null, null, null, null]);
    expect(result.failure).toBeNull();
  });

  it("空白だけではない要素は null にしない（1文字の値・内部に空白を含む値もそのまま鍵になる）", async () => {
    const provider = llmReturning({
      claims: [
        { subject: "姉", predicate: "x" },
        { subject: "my sister", predicate: "favorite food" },
        { subject: " user ", predicate: " favorite_food " },
      ],
    });
    const result = await deriveClaimKeys(provider, ctx, ["発話1", "発話2", "発話3"]);
    expect(result.claimKeys).toEqual([
      { subject: "姉", predicate: "x" },
      { subject: "my_sister", predicate: "favorite_food" },
      { subject: "user", predicate: "favorite_food" },
    ]);
    expect(result.failure).toBeNull();
  });

  it("provider が投げたエラーの kind を duck typing で読む（extraction.ts の describeExtractionFailure と同じ規律）", async () => {
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        const error = new Error("rate limited") as Error & { kind: string };
        error.kind = "rate_limit";
        throw error;
      },
    };
    const result = await deriveClaimKeys(provider, ctx, ["発話"]);
    expect(result.failure?.kind).toBe("rate_limit");
  });
});

describe("ClaimKeyBatchResultSchema", () => {
  it("claims が subject/predicate の組の配列であることを要求する", () => {
    expect(
      ClaimKeyBatchResultSchema.safeParse({ claims: [{ subject: "user", predicate: "x" }] })
        .success,
    ).toBe(true);
    expect(ClaimKeyBatchResultSchema.safeParse({ claims: [{ subject: "user" }] }).success).toBe(
      false,
    );
  });
});

/** `describeClaimKeyFailure`（export しない複製）が `describeExtractionFailure` とずれたら赤くなるよう、同じ入力を投げて `failure` と突き合わせる。 */
describe("deriveClaimKeys の失敗の記述は describeExtractionFailure と同じ（Issue #1264）", () => {
  const withKind = (kind: unknown) => Object.assign(new Error("boom"), { kind });
  const INPUTS: Array<[string, unknown]> = [
    ["kind を持つ Error", withKind("rate_limit")],
    ["kind が空文字の Error", withKind("")],
    ["kind が文字列でない Error", withKind(5)],
    ["kind を持たない Error", new Error("plain")],
    ["文字列", "boom"],
    ["null", null],
    ["undefined", undefined],
    ["kind を持つ Error でないオブジェクト", { kind: "x" }],
    ["数", 42],
  ];

  it.each(INPUTS)("%s", async (_label, thrown) => {
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async () => {
        throw thrown;
      },
    };
    const result = await deriveClaimKeys(provider, ctx, ["発話"]);
    expect(result.failure).toEqual(describeExtractionFailure(thrown));
  });
});
