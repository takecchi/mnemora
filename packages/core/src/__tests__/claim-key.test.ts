import { describe, expect, it } from "vitest";
import type { Ctx } from "../ctx.js";
import {
  buildClaimKeyPrompt,
  ClaimKeyBatchResultSchema,
  deriveClaimKeys,
  normalizeClaimKey,
  normalizeClaimKeyPart,
} from "../claim-key.js";
import type { StructuredRequest } from "../interfaces/llm-provider.js";
import type { LLMProvider } from "../interfaces/llm-provider.js";

const ctx: Ctx = { tenantId: "tenant-1" };

describe("normalizeClaimKeyPart（Issue #371、ADR 0185/0315 決定3）", () => {
  it("NFKC正規化・前後空白除去・小文字化・内部空白の _ への畳み込みを行う", () => {
    expect(normalizeClaimKeyPart("  Favorite Food  ")).toBe("favorite_food");
  });

  it("全角文字を NFKC で半角相当に正規化する", () => {
    // "ＵＳＥＲ"（全角）は NFKC で "USER"（半角）へ正規化され、その後 小文字化される。
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
    // 抽出プロンプトが使う文言（「本人が明示的に述べた事実は provenanceKind」）を
    // 一切含まないことを確かめる——2つのプロンプトが同じ文字列を共有していれば、
    // 将来どちらかを変更したときに意図せずもう片方の llmCassetteKey が動くリスクがある。
    expect(prompt.system).not.toContain("provenanceKind");
  });

  // Issue #372負債6（ADR 0334）: knownSubjects を一切渡さない呼び出しの system は
  // 1バイトも変わっていないことを固定する——既存カセット（`llmCassetteKey` は
  // `PromptSpec` から決まる）が動かないことの直接の証拠。この逐語は
  // `claim-key.ts` の `CLAIM_KEY_PROMPT_SYSTEM` の定義と完全一致させてある。
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

  // Issue #835（ADR 0329 負債1の続き）: knownPredicatesFromStore（4番目・末尾の引数）は
  // 追加のみ——省略時の挙動を固定して、(a)「opt-in でない・knownPredicates だけのとき、
  // プロンプトが従来と完全に同じ」を歯にする。
  describe("knownPredicatesFromStore（Issue #835、ADR 0329 負債1の続き）", () => {
    it("渡さなければ、その文言を含まない——knownPredicates だけの呼び出しは1バイトも変わらない", () => {
      const withoutStore = buildClaimKeyPrompt(["ラーメンが好き"], ["favorite_food"]);
      expect(withoutStore.system).not.toContain("過去の記憶から集めた predicate 候補一覧");
      // (a) 3引数までの呼び出しは、4引数目を新設する前と1バイトも変わらない
      // ——CLAIM_KEY_PROMPT_SYSTEM_LITERAL + buildKnownPredicateInstruction の組み立てのみ。
      expect(withoutStore.system).toBe(
        CLAIM_KEY_PROMPT_SYSTEM_LITERAL +
          " 既知の predicate 候補一覧: favorite_food。この一覧に当てはまる場合は必ずそのまま使い、" +
          "どれにも当てはまらない場合だけ新しい predicate を作ってください。",
      );
    });

    it("opt-in でない（何も渡さない）呼び出しは CLAIM_KEY_PROMPT_SYSTEM と1バイトも違わない", () => {
      const prompt = buildClaimKeyPrompt(["ラーメンが好き"]);
      expect(prompt.system).toBe(CLAIM_KEY_PROMPT_SYSTEM_LITERAL);
    });

    it("空配列は『渡していない』と同じ", () => {
      const withEmpty = buildClaimKeyPrompt(["発話"], undefined, undefined, []);
      const withoutAny = buildClaimKeyPrompt(["発話"]);
      expect(withEmpty).toEqual(withoutAny);
    });

    // (b) store 由来の語彙があるときだけ、新しい文言になることを固定する。
    it("渡すと、既存の『既知の predicate 候補一覧』とは別の見出し・別の（弱めた）文言で足される", () => {
      const prompt = buildClaimKeyPrompt(["発話"], undefined, undefined, ["hobby_interest"]);
      const system = prompt.system as string;
      expect(system).toContain("過去の記憶から集めた predicate 候補一覧: hobby_interest。");
      expect(system).not.toContain("既知の predicate 候補一覧");
      // 「必ずそのまま使い」という強い文言は使わない——弱めた再利用条件になっている。
      expect(system).not.toContain("必ずそのまま使い");
      expect(system).toContain(
        "同じ主題・同じ属性について述べている場合にだけそのまま使ってください",
      );
    });

    it("knownPredicates（利用者指定）と両方渡すと、利用者指定分は旧文言のまま・store分は新しい見出しで別に足される", () => {
      const prompt = buildClaimKeyPrompt(["発話"], ["user_chosen_hint"], undefined, [
        "hobby_interest",
      ]);
      const system = prompt.system as string;
      expect(system).toContain(
        "既知の predicate 候補一覧: user_chosen_hint。この一覧に当てはまる場合は必ずそのまま使い",
      );
      expect(system).toContain("過去の記憶から集めた predicate 候補一覧: hobby_interest。");
    });

    it("knownPredicates・knownPredicatesFromStore・knownSubjects の3つを渡すと、predicate → store分 → subject の順で並ぶ", () => {
      const prompt = buildClaimKeyPrompt(
        ["発話"],
        ["favorite_food"],
        ["user", "姉"],
        ["hobby_interest"],
      );
      const system = prompt.system as string;
      const predicateIndex = system.indexOf("既知の predicate 候補一覧");
      const fromStoreIndex = system.indexOf("過去の記憶から集めた predicate 候補一覧");
      const subjectIndex = system.indexOf("既知の subject 候補一覧");
      expect(predicateIndex).toBeGreaterThanOrEqual(0);
      expect(fromStoreIndex).toBeGreaterThan(predicateIndex);
      expect(subjectIndex).toBeGreaterThan(fromStoreIndex);
    });
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

  it("knownPredicatesFromStore（Issue #835、末尾の引数）を buildClaimKeyPrompt へそのまま転送する", async () => {
    let capturedSystem: string | undefined;
    const provider: LLMProvider = {
      complete: async () => {
        throw new Error("not used");
      },
      completeStructured: async <T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> => {
        capturedSystem = req.prompt.system;
        return req.schema.parse({
          claims: [{ subject: "user", predicate: "hobby_interest" }],
        }) as T;
      },
    };
    await deriveClaimKeys(provider, ctx, ["発話"], undefined, undefined, ["hobby_interest"]);
    expect(capturedSystem).toContain("過去の記憶から集めた predicate 候補一覧: hobby_interest。");
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
