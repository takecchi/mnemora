import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ANSWER_CASE_SET_DEV } from "../answer-case-set.dev.js";
import {
  computeFingerprint,
  defaultCassettePath,
  loadAnswerTrialsMaterial,
  parseMemoryLine,
  parseMnemoraPromptBody,
  stableStringify,
} from "../answer-trials-material.js";

/**
 * `answer-trials-material.ts` の単体試験。**DB 不要・鍵不要**——実カセット
 * （`cassettes/answer.json`）を読むだけの純粋な parser を検査する（Issue #705）。
 */

const ANSWER_SYSTEM_PROMPT_SOURCE_FILE = new URL("../answer-bench.ts", import.meta.url);

describe("ANSWER_SYSTEM_PROMPT の複製が answer-bench.ts の原文とずれていないこと", () => {
  it("answer-bench.ts のソーステキストに、この module が複製した system 文がそのまま現れる", () => {
    // ⚠ `answer-bench.ts` を import しない(DB を import しない規律のため)。
    // ソーステキストを直接読んで文字列一致だけを見る——import しない自己整合性の検査。
    const source = readFileSync(ANSWER_SYSTEM_PROMPT_SOURCE_FILE, "utf8");
    expect(source).toContain(
      "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。",
    );
  });
});

describe("parseMemoryLine", () => {
  it("由来・話者・主題・記録順・出来事時刻(不明)・digest を持つ行を解析する", () => {
    const line = "- [由来:stated] [話者:user] [主題:なし] [記録順:1] [出来事時刻:不明] 紅茶が好き";
    expect(parseMemoryLine(line)).toEqual({
      provenanceKind: "stated",
      speaker: "user",
      subject: "なし",
      recordedOrder: 1,
      occurredAt: "不明",
      digest: "紅茶が好き",
    });
  });

  it("話者タグが無い行（provenanceKind !== stated）を解析する", () => {
    const line = "- [由来:inferred] [主題:なし] 推論された記憶";
    const parsed = parseMemoryLine(line);
    expect(parsed.speaker).toBeUndefined();
    expect(parsed.provenanceKind).toBe("inferred");
    expect(parsed.digest).toBe("推論された記憶");
  });

  it("矛盾候補タグを解析する", () => {
    const line = "- [由来:stated] [話者:user] [主題:なし] [矛盾候補:「相手の digest」] 本文";
    expect(parseMemoryLine(line).contradiction).toBe("「相手の digest」");
  });

  it("出来事時刻に ISO 文字列が入る行を解析する", () => {
    const line =
      "- [由来:stated] [話者:user] [主題:なし] [記録順:2] [出来事時刻:2026-09-01T00:00:00.000Z] 本文";
    expect(parseMemoryLine(line).occurredAt).toBe("2026-09-01T00:00:00.000Z");
  });

  it("digest 自体は自由な文字列でよい(空白を含む)", () => {
    const line = "- [由来:stated] [主題:なし] 複数の 単語を含む digest";
    expect(parseMemoryLine(line).digest).toBe("複数の 単語を含む digest");
  });

  it("先頭が '- ' でない行は例外", () => {
    expect(() => parseMemoryLine("[由来:stated] [主題:なし] 本文")).toThrow();
  });

  it("[由来:...] タグが無い行は例外", () => {
    expect(() => parseMemoryLine("- [主題:なし] 本文")).toThrow();
  });

  it("[主題:...] タグが無い行は例外", () => {
    expect(() => parseMemoryLine("- [由来:stated] 本文")).toThrow();
  });

  it("digest が空の行は例外", () => {
    expect(() => parseMemoryLine("- [由来:stated] [主題:なし] ")).toThrow();
  });

  it("記録順が正の整数でなければ例外", () => {
    expect(() => parseMemoryLine("- [由来:stated] [主題:なし] [記録順:0] 本文")).toThrow();
    expect(() => parseMemoryLine("- [由来:stated] [主題:なし] [記録順:x] 本文")).toThrow();
  });
});

describe("parseMnemoraPromptBody", () => {
  it("記憶が0件の本体(索引行のみ)を解析する", () => {
    const body = "(索引: スコープ内 2 件のうち 0 件を提示)";
    expect(parseMnemoraPromptBody(body)).toEqual({ totalInScope: 2, presented: 0, lines: [] });
  });

  it("記憶が2件ある本体を解析する", () => {
    const body =
      "- [由来:stated] [主題:なし] 本文1\n" +
      "- [由来:stated] [主題:なし] 本文2\n" +
      "(索引: スコープ内 2 件のうち 2 件を提示)";
    const parsed = parseMnemoraPromptBody(body);
    expect(parsed.totalInScope).toBe(2);
    expect(parsed.presented).toBe(2);
    expect(parsed.lines).toHaveLength(2);
    expect(parsed.lines[0]?.digest).toBe("本文1");
    expect(parsed.lines[1]?.digest).toBe("本文2");
  });

  it("最終行が索引行の形でなければ例外", () => {
    expect(() => parseMnemoraPromptBody("ただの文字列")).toThrow();
  });

  it("索引行の提示件数と実際の行数が食い違えば例外", () => {
    const body = "- [由来:stated] [主題:なし] 本文1\n(索引: スコープ内 5 件のうち 2 件を提示)";
    expect(() => parseMnemoraPromptBody(body)).toThrow();
  });
});

describe("stableStringify / computeFingerprint", () => {
  it("キーの並び順に依存しない安定した文字列を作る", () => {
    const a = { z: 1, a: 2, nested: { y: 1, x: 2 } };
    const b = { a: 2, nested: { x: 2, y: 1 }, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("配列の順序は保つ(配列は並び替えない)", () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it("computeFingerprint は入力が変われば変わる", () => {
    const base = {
      caseId: "x",
      question: "q?",
      system: "sys",
      totalInScope: 1,
      presented: 1,
      lines: [{ provenanceKind: "stated", subject: "なし", digest: "d" }],
    };
    const fp1 = computeFingerprint(base);
    const fp2 = computeFingerprint({ ...base, question: "different?" });
    expect(fp1).not.toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("loadAnswerTrialsMaterial(実カセット)", () => {
  const material = loadAnswerTrialsMaterial();

  it("cassettePath が既定のカセットを指す", () => {
    expect(material.cassettePath).toBe(defaultCassettePath());
  });

  it("カセットファイル全体の sha256 を返す(独立に計算した値と一致する)", () => {
    const raw = readFileSync(defaultCassettePath(), "utf8");
    const expected = createHash("sha256").update(raw, "utf8").digest("hex");
    expect(material.cassetteSha256).toBe(expected);
  });

  it("dev 6件すべてが対応づけられる(answer-case-set.dev.ts と同じ順序・同じ caseId)", () => {
    expect(material.cases.map((c) => c.caseId)).toEqual(ANSWER_CASE_SET_DEV.map((c) => c.id));
  });

  it("各ケースの question は answer-case-set.dev.ts と一致する", () => {
    for (const answerCase of ANSWER_CASE_SET_DEV) {
      const m = material.cases.find((c) => c.caseId === answerCase.id);
      expect(m?.question).toBe(answerCase.question);
    }
  });

  it("各ケースの fingerprint は sha256 hex(64桁)である", () => {
    for (const c of material.cases) {
      expect(c.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("unknown-blood-type ケースは記憶0件(索引行のみ)である", () => {
    const m = material.cases.find((c) => c.caseId === "unknown-blood-type");
    expect(m?.lines).toHaveLength(0);
    expect(m?.presented).toBe(0);
    expect(m?.totalInScope).toBeGreaterThan(0);
  });

  it("pref-tea-over-coffee ケースは、カセットに2件のmnemora形式エントリがあっても曖昧にならない", () => {
    // カセットには pref-tea-over-coffee の質問に対して mnemora 形式のエントリが2件ある
    // (正規の1件 + answer-retention-mutation.ts の陽性対照1件)。既知の変異マーカーで
    // 後者を除外できるので、ここは例外にならず1件に定まるはずである。
    const m = material.cases.find((c) => c.caseId === "pref-tea-over-coffee");
    expect(m).toBeDefined();
    expect(m?.rawContent).not.toContain("要約失敗");
    expect(m?.lines.length).toBeGreaterThan(0);
  });

  it("各ケースの system は同一の ANSWER_SYSTEM_PROMPT である", () => {
    const systems = new Set(material.cases.map((c) => c.system));
    expect(systems.size).toBe(1);
  });

  it("digest の中身が実カセットの実測値と一致する(材料を作り直さず、カセットから読んでいることの陽性対照)", () => {
    // ⭐ 変異試験(a)向けの陽性対照。「材料取得で抽出・recall をやり直す実装」（＝カセットを
    // 読まず、別の記憶集合を合成する実装）に置き換わると、この具体的な文字列は再現できない
    // ——digest はカセットに記録された実 API の抽出結果そのものであり、でっちあげでは
    // 一致しない。
    const pref = material.cases.find((c) => c.caseId === "pref-tea-over-coffee");
    expect(pref?.lines.map((l) => l.digest)).toEqual([
      "打ち合わせのとき、飲み物はコーヒーより紅茶のほうが好き",
      "今日はいい天気ですね。",
    ]);

    const schedule = material.cases.find((c) => c.caseId === "schedule-change-meeting-day");
    expect(schedule?.lines.map((l) => l.digest)).toEqual([
      "来週の定例会議は金曜日にある",
      "定例会議が水曜日に移動した。金曜日は都合が悪くなった。",
      "旅行の計画を立てている",
      "最近読んだ本がとても面白かったです。",
    ]);
    // ADR 0295 追記2 が見つけた通り、この訂正後の digest 自体が reject 語「金曜」を
    // 含む——digest-only 描画でもこのケースが割れうる構造がここに現れている。
    expect(schedule?.lines[1]?.digest).toContain("金曜");
    expect(schedule?.lines[1]?.digest).toContain("水曜");
  });
});

describe("loadAnswerTrialsMaterial(異常系。一時ファイルで作った合成カセット)", () => {
  function writeTempCassette(entries: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "answer-trials-material-test-"));
    const path = join(dir, "cassette.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        recordedAt: "2026-01-01T00:00:00.000Z",
        embedding: { space: {}, entries: {} },
        llm: { model: "gpt-4o-mini", entries },
      }),
      "utf8",
    );
    return path;
  }

  const ANSWER_SYSTEM_PROMPT =
    "以下の会話ログだけを根拠に、簡潔に答えてください。根拠が無ければ『分かりません』と答えてください。";

  function mnemoraEntry(question: string, digest = "本文"): unknown {
    return {
      prompt: {
        system: ANSWER_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content:
              `- [由来:stated] [主題:なし] ${digest}\n` +
              "(索引: スコープ内 1 件のうち 1 件を提示)" +
              `\n\n質問: ${question}`,
          },
        ],
      },
      value: { content: "回答" },
    };
  }

  it("対応するエントリが1件も無い dev ケースがあれば例外", () => {
    const path = writeTempCassette({}); // 空 — どの質問にも当たらない
    try {
      expect(() => loadAnswerTrialsMaterial(path)).toThrow(/見つからない/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("同じ質問に複数の mnemora 形式エントリが当たれば例外(既知の変異マーカーを含まない場合)", () => {
    const q = ANSWER_CASE_SET_DEV[0]?.question;
    if (q === undefined) throw new Error("test fixture: ANSWER_CASE_SET_DEV[0] が無い");
    const path = writeTempCassette({
      e1: mnemoraEntry(q, "本文A"),
      e2: mnemoraEntry(q, "本文B"),
    });
    try {
      expect(() => loadAnswerTrialsMaterial(path)).toThrow(/複数/);
    } finally {
      rmSync(path, { recursive: true, force: true });
    }
  });

  it("カセットが読めなければ例外", () => {
    expect(() => loadAnswerTrialsMaterial("/no/such/path/cassette.json")).toThrow();
  });
});
