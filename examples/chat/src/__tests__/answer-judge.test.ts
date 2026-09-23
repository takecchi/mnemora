import { describe, expect, it } from "vitest";
import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";
import type { AnswerCase, AnswerVerdict } from "../answer-case.js";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import { ANSWER_CASE_SET_EVAL } from "../answer-case-set.eval.js";
import type { AnswerJudgeInput, AnswerJudgeOutcome } from "../answer-judge.js";
import {
  buildAnswerJudgePromptSpec,
  judgeAnswer,
  parseAnswerJudgeResponse,
  reconcileVerdicts,
} from "../answer-judge.js";

/**
 * `answer-judge.ts` の単体試験。**DB 不要・鍵不要**——`parseAnswerJudgeResponse`/
 * `buildAnswerJudgePromptSpec`/`reconcileVerdicts` はすべて純関数である。
 */

describe("parseAnswerJudgeResponse: 壊れた応答は必ず indeterminate（設計上の必須事項2）", () => {
  it.each<[string, string]>([
    ["", "空文字"],
    ["   \n\t  ", "空白のみ"],
    ['{"判定": "PASS", "理由": "JSONのつもり"}', "JSON"],
    ["###???!!!===", "記号列"],
    ["水曜日です。", "採点対象の回答らしき素の文字列（判定行が無い）"],
    ["判定: MAYBE\n理由: よくわからない", "判定の値が想定外（MAYBE）"],
    ["判定: 合格\n理由: 日本語の値", "判定の値が想定外（日本語）"],
    ["理由: 根拠が無い\n判定なし", "判定行そのものが無い"],
  ])("%s（%s）は indeterminate になる", (raw) => {
    expect(parseAnswerJudgeResponse(raw).outcome).toBe("indeterminate");
  });

  it("deterministic stub がプロンプト全文をエコーした場合も indeterminate になる", () => {
    // buildAnswerJudgePromptSpec が組んだ user 文には「判定:」行が無い
    // （それは ANSWER_JUDGE_SYSTEM_PROMPT の側にしか無い——DeterministicLLMProvider.complete()
    // は最後のメッセージ（system ではなく user）だけをそのまま返す）。
    const input: AnswerJudgeInput = {
      question: "わたしの好きな数字は何ですか?",
      expectedKind: "must-abstain",
      rationale: "会話のどのターンにも言及が無い。",
      groundTurnTexts: [],
      answer: "分かりません。",
    };
    const spec = buildAnswerJudgePromptSpec(input);
    const echoed = spec.messages[spec.messages.length - 1]?.content ?? "";
    expect(parseAnswerJudgeResponse(echoed).outcome).toBe("indeterminate");
  });
});

describe("parseAnswerJudgeResponse: 正常な応答のパース", () => {
  it.each<[string, AnswerJudgeOutcome]>([
    ["判定: PASS\n理由: 根拠と一致している", "pass"],
    ["判定: FAIL\n理由: 誤った値を断定している", "fail"],
    ["判定: INDETERMINATE\n理由: 根拠だけからは判定できない", "indeterminate"],
    ["判定：PASS\n理由：全角コロン", "pass"],
    ["判定: pass\n理由: 小文字", "pass"],
    ["判定: Fail\n理由: 大文字小文字混在", "fail"],
    ["  判定:   INDETERMINATE  \n理由: 先頭・値の前後に空白", "indeterminate"],
  ])("%s → outcome=%s", (raw, expected) => {
    expect(parseAnswerJudgeResponse(raw).outcome).toBe(expected);
  });

  it("理由が取れたときは reason に入り、取れなければ空文字になる", () => {
    expect(parseAnswerJudgeResponse("判定: PASS\n理由: テスト理由").reason).toBe("テスト理由");
    expect(parseAnswerJudgeResponse("判定: PASS").reason).toBe("");
  });

  it("raw は先頭 500 字を保持し、超えた分は省略記号を付ける", () => {
    const longRaw = `判定: PASS\n${"あ".repeat(600)}`;
    const parsed = parseAnswerJudgeResponse(longRaw);
    expect(parsed.raw.length).toBeLessThan(longRaw.length);
    expect(parsed.raw.endsWith("…")).toBe(true);
  });

  it("500字以下の raw はそのまま保持し、省略記号を付けない", () => {
    const shortRaw = "判定: PASS\n理由: 短い";
    expect(parseAnswerJudgeResponse(shortRaw).raw).toBe(shortRaw);
  });
});

describe("reconcileVerdicts: 全組み合わせ", () => {
  const values: readonly AnswerVerdict[] = ["pass", "fail", "indeterminate"];

  for (const primary of values) {
    for (const secondary of values as readonly AnswerJudgeOutcome[]) {
      const expected = primary === secondary ? primary : "indeterminate";
      it(`primary=${primary} / secondary=${secondary} → ${expected}`, () => {
        expect(reconcileVerdicts(primary, secondary)).toBe(expected);
      });
    }
  }
});

describe("buildAnswerJudgePromptSpec: expected.accept/reject を渡さない（設計上の必須事項3）", () => {
  /**
   * `AnswerJudgeInput` は構造上 `accept`/`reject` を持てない（`answer-judge.ts` の型定義）
   * ——ここでは、それに加えて**実際に組み立てたプロンプト文字列**にも、実ケースの
   * `accept`/`reject` の文字列が現れないことを機械で固定する。
   *
   * ⚠ **`unknown` 類だけを対象にする。** `grounds.rationale` はそもそも judge に渡してよい
   * 入力であり（`AnswerJudgeInput.rationale`）、closed-value 系のケースでは rationale が
   * 正解の値そのものを引用して説明する（例: "25日に延ばして…"）——これは正しい設計であって
   * 漏洩ではない。`unknown` 類は「根拠となるターンが構造的に存在しない」ことが根拠なので、
   * rationale が reject の値（例: 血液型・具体的な数字）に触れる理由が無く、この不変条件を
   * 偽陽性なしに検査できる。
   */
  function groundTurnTextsOf(answerCase: AnswerCase): string[] {
    return answerCase.grounds.turnIndex.map((i) => answerCase.conversation[i]!.text);
  }

  const unknownCases = [...ANSWER_CASE_SET_DEV, ...ANSWER_CASE_SET_EVAL].filter(
    (c) => c.category === "unknown",
  );

  it("unknown 類のケースが dev/eval の両方に最低1件ずつある（この試験の前提）", () => {
    expect(ANSWER_CASE_SET_DEV.some((c) => c.category === "unknown")).toBe(true);
    expect(ANSWER_CASE_SET_EVAL.some((c) => c.category === "unknown")).toBe(true);
  });

  /**
   * ⚠ **`spec.system` は検査対象に含めない。** `ANSWER_JUDGE_SYSTEM_PROMPT` は
   * `AnswerJudgeInput` から1バイトも組み立てられない固定文字列であり
   * （`buildAnswerJudgePromptSpec` は `system` に定数をそのまま渡すだけ）、
   * ケースの `accept`/`reject` が漏れる経路になり得ない。それどころか、この固定文字列は
   * 「理由: <30字程度の短い説明>」という指示文を含み、たまたま数字の `"3"` を含む
   * ——`reject: ["7","3","8"]` の `"3"` と偶然一致し、`system` まで検査対象にすると
   * **偽陽性**になる（実測済み）。検査すべきは「入力（`AnswerJudgeInput`）から実際に
   * 組み立てられた部分」である `messages` だけ。
   */
  function userContentOf(spec: ReturnType<typeof buildAnswerJudgePromptSpec>): string {
    return spec.messages.map((m) => m.content).join("\n");
  }

  it.each(unknownCases.map((c) => [c.id, c] as const))(
    "%s: 入力から組み立てた user 文に accept/reject の文字列が1つも現れない",
    (_id, answerCase) => {
      const input: AnswerJudgeInput = {
        question: answerCase.question,
        expectedKind: answerCase.expected.kind,
        rationale: answerCase.grounds.rationale,
        groundTurnTexts: groundTurnTextsOf(answerCase),
        answer: "これはテスト用のプレースホルダ回答であり、採点結果には使わない。",
      };
      const userText = userContentOf(buildAnswerJudgePromptSpec(input));
      for (const accept of answerCase.expected.accept) {
        expect(userText).not.toContain(accept);
      }
      for (const reject of answerCase.expected.reject) {
        expect(userText).not.toContain(reject);
      }
    },
  );

  it("⭐ unknown-favorite-number: reject=['7','3','8'] が user 文に含まれない（明示ケース）", () => {
    const answerCase = ANSWER_CASE_SET_EVAL.find((c) => c.id === "unknown-favorite-number");
    expect(answerCase).toBeDefined();
    expect(answerCase!.expected.reject).toEqual(["7", "3", "8"]);

    // ⚠ `answer` には accept/reject のどちらとも重ならない中立な文言を使う——
    // 採点対象の `answer` は正しい must-abstain 回答なら「分かりません」等、`accept` の
    // 値そのものになり得る。それは正常な回答であって漏洩ではないため、ここでの検査
    // （プロンプトの組み立てが accept/reject の一覧を埋め込んでいないか）とは別の話になる。
    const input: AnswerJudgeInput = {
      question: answerCase!.question,
      expectedKind: answerCase!.expected.kind,
      rationale: answerCase!.grounds.rationale,
      groundTurnTexts: groundTurnTextsOf(answerCase!),
      answer: "これはテスト用のプレースホルダ回答であり、採点結果には使わない。",
    };
    const userText = userContentOf(buildAnswerJudgePromptSpec(input));
    for (const reject of answerCase!.expected.reject) {
      expect(userText).not.toContain(reject);
    }
    for (const accept of answerCase!.expected.accept) {
      expect(userText).not.toContain(accept);
    }
  });
});

describe("buildAnswerJudgePromptSpec: naive/mnemora で同一の書式（設計上の必須事項6）", () => {
  it("answer 以外が同じ input なら、system も user の書式も完全に同一になる", () => {
    const base: Omit<AnswerJudgeInput, "answer"> = {
      question: "テスト質問",
      expectedKind: "closed-value",
      rationale: "テスト根拠",
      groundTurnTexts: ["ターン0の発言"],
    };
    const naiveSpec = buildAnswerJudgePromptSpec({ ...base, answer: "naive の回答" });
    const mnemoraSpec = buildAnswerJudgePromptSpec({ ...base, answer: "mnemora の回答" });

    expect(naiveSpec.system).toBe(mnemoraSpec.system);
    // 採点対象の回答の行だけが違い、それ以外の行は完全一致する。
    const naiveUser = naiveSpec.messages[0]?.content ?? "";
    const mnemoraUser = mnemoraSpec.messages[0]?.content ?? "";
    expect(naiveUser.replace("naive の回答", "")).toBe(mnemoraUser.replace("mnemora の回答", ""));
  });

  it("groundTurnTexts が空配列なら「根拠となる発言なし」と明示する", () => {
    const spec = buildAnswerJudgePromptSpec({
      question: "わたしの好きな数字は何ですか?",
      expectedKind: "must-abstain",
      rationale: "会話のどのターンにも言及が無い。",
      groundTurnTexts: [],
      answer: "分かりません。",
    });
    expect(spec.messages[0]?.content).toContain("(根拠となる発言なし)");
  });
});

describe("judgeAnswer: 3段を結んだ結合体が「赤」を通る（Issue #558）", () => {
  /**
   * `judgeAnswer` は `buildAnswerJudgePromptSpec` → `llmProvider.complete()` →
   * `parseAnswerJudgeResponse` の3段を結ぶだけの関数である。**その結合体を通して
   * `fail` が出る経路は、この repo のどの試験でも踏まれていなかった**（Issue #558）——
   * 唯一 `judgeAnswer` を通していた `answer-bench.postgres.test.ts` は `env: {}` で
   * `deterministic` を強制しており、judge は必ず `indeterminate` に落ちる設計である。
   *
   * 🔴 **これは Issue #498 の残り（実 API の陽性対照）ではない。**#498 で鍵が要るのは
   * 「`digest` から答えの語を落としたとき、**実 LLM が生成した回答**を層3が赤と判定する」
   * 経路であって、ここで見ているパーサの結線ではない。⛔ この歯が緑であることを、
   * #498 完了条件4「回答評価」側の充足として数えないこと。
   *
   * **鍵不要・DB 不要**——フェイクの `LLMProvider` を渡すだけで、外部呼び出しは無い。
   */
  const ctx: Ctx = { tenantId: "answer-judge-red-path-test" };

  const input: AnswerJudgeInput = {
    question: "次の歯医者の予約はいつですか?",
    expectedKind: "closed-value",
    rationale: "会話で25日に延ばしたと言っている。",
    groundTurnTexts: ["歯医者、25日に延ばしたよ"],
    answer: "18日です。",
  };

  /**
   * 最小のフェイク `LLMProvider`。`complete()` が返す本文だけを差し替え、渡された
   * `PromptSpec` を記録する。
   *
   * ⛔ **`completeStructured` は投げる。**`judgeAnswer` は `complete()` だけを使う
   * （`answer-judge.ts` の設計上の必須事項1）——この `throw` 自体が、その必須事項を
   * 機械で縛る歯である。`judgeAnswer` が structured へ移れば、この試験は例外で落ちる。
   */
  function fakeLLM(content: string): LLMProvider & { seen: PromptSpec[] } {
    const provider = {
      seen: [] as PromptSpec[],
      async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
        provider.seen.push(req);
        return { content };
      },
      async completeStructured<T>(_ctx: Ctx, _req: StructuredRequest<T>): Promise<T> {
        throw new Error(
          "judgeAnswer は completeStructured を使わない（answer-judge.ts 設計上の必須事項1）",
        );
      },
    };
    return provider;
  }

  it("⭐ provider が FAIL を返せば outcome=fail（結合体が赤を通る）", async () => {
    const judgement = await judgeAnswer(
      fakeLLM("判定: FAIL\n理由: 誤った値を断定している"),
      ctx,
      input,
    );
    expect(judgement.outcome).toBe("fail");
    expect(judgement.reason).toBe("誤った値を断定している");
  });

  it("同じ input でも provider が PASS を返せば outcome=pass（上の赤が空虚でないこと）", async () => {
    // ⚠ この1本が無いと、`judgeAnswer` が provider を無視して `fail` を返す実装でも
    // 上の歯は通ってしまう——**応答が結果を決めている**ことをここで固定する。
    const judgement = await judgeAnswer(
      fakeLLM("判定: PASS\n理由: 根拠と一致している"),
      ctx,
      input,
    );
    expect(judgement.outcome).toBe("pass");
  });

  it("provider へ渡るのは buildAnswerJudgePromptSpec(input) そのもの（3段の結線）", async () => {
    const provider = fakeLLM("判定: FAIL\n理由: 誤った値を断定している");
    await judgeAnswer(provider, ctx, input);
    // 1ケース1回だけ呼ぶ（設計上の必須事項5: 呼び出し回数を数える側の前提）。
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]).toEqual(buildAnswerJudgePromptSpec(input));
  });
});
