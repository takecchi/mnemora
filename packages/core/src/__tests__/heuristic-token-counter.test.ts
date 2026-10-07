import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { heuristicTokenCounter } from "../heuristic-token-counter.js";

/** `resolveJsonModule` はこのパッケージの契約（core は実行時に zod だけに依存する。dependency-boundary.test.ts）を曖昧にしたくないので使わず、`readFileSync` + `JSON.parse` で読む。 */
const referencePath = new URL("./fixtures/token-count-reference.json", import.meta.url);

type ReferenceSample = {
  id: string;
  class: string;
  source: string;
  text: string;
  o200k_base: number;
  cl100k_base: number;
};

type ReferenceFixture = {
  samples: ReferenceSample[];
};

const reference: ReferenceFixture = JSON.parse(readFileSync(referencePath, "utf8"));

function samplesOfClass(className: string): ReferenceSample[] {
  return reference.samples.filter((s) => s.class === className);
}

/** クラス全体の 合計推定/合計実測(o200k_base) 比。件数の重みを揃えるため、比ではなく合計で測る。 */
function classRatio(className: string): number {
  const samples = samplesOfClass(className);
  const estimatedSum = samples.reduce(
    (sum, s) => sum + heuristicTokenCounter.count(s.text).tokens,
    0,
  );
  const actualSum = samples.reduce((sum, s) => sum + s.o200k_base, 0);
  return estimatedSum / actualSum;
}

describe("heuristicTokenCounter", () => {
  it("常に counter: 'heuristic' を返す", () => {
    expect(heuristicTokenCounter.count("hello").counter).toBe("heuristic");
  });

  it("空文字は 0 トークン", () => {
    expect(heuristicTokenCounter.count("").tokens).toBe(0);
  });

  it("非CJK かつ BMP 内の文字だけのテキストは従来どおり ceil(文字数/4) と一致する（互換性）", () => {
    // 非CJKの係数は現行式と数値として同一なので、CJK もサロゲートペア（非BMP）も無ければ常に一致する。非BMP を含むと従来（UTF-16 コード単位で2と数える）とは一致しない（意図して変えた側）。
    expect(heuristicTokenCounter.count("abcdefgh").tokens).toBe(2);
    expect(heuristicTokenCounter.count("abcde").tokens).toBe(2);

    const enSamples = samplesOfClass("en");
    expect(enSamples.length).toBeGreaterThan(0);
    for (const sample of enSamples) {
      expect(heuristicTokenCounter.count(sample.text).tokens).toBe(
        Math.ceil(sample.text.length / 4),
      );
    }
  });

  it("同じ文字数なら日本語のほうが英語より重い", () => {
    // 3.6という係数比そのものより緩い帯にして、丸めの影響を吸収する。
    const ja = "あ".repeat(20);
    const en = "a".repeat(20);
    const jaTokens = heuristicTokenCounter.count(ja).tokens;
    const enTokens = heuristicTokenCounter.count(en).tokens;
    expect(jaTokens).toBeGreaterThanOrEqual(enTokens * 3);
  });

  it("コードポイントで数える（UTF-16 のコード単位ではない）", () => {
    // "𠮟" x4 は UTF-16 では8コード単位。実装が text.length で数えると「非CJK8文字」と誤認し ceil(8*5/20) = 2 になる。コードポイントで数えれば ceil(4*18/20) = 4。
    const text = "𠮟".repeat(4);
    expect(heuristicTokenCounter.count(text).tokens).toBe(4);
  });

  it("対照コーパス全体で、推定は実測(o200k_base)の 0.95〜1.10 に収まる", () => {
    // 予算（RecallBudget.maxMemoryTokens）は多数の digest の合計に効くので、1件ごとの相対誤差より合計としてどれだけ合っているかが本命。1件ずつ大きくぶれても打ち消し合えば合計は合う。
    const estimatedSum = reference.samples.reduce(
      (sum, s) => sum + heuristicTokenCounter.count(s.text).tokens,
      0,
    );
    const actualSum = reference.samples.reduce((sum, s) => sum + s.o200k_base, 0);
    const overallRatio = estimatedSum / actualSum;
    expect(overallRatio).toBeGreaterThanOrEqual(0.95);
    expect(overallRatio).toBeLessThanOrEqual(1.1);
  });

  it("日本語・中国語・韓国語の合計を過小評価しない", () => {
    // `zh` の余裕は下限 1.00 に対して 1.7% しか無く、コーパスの中身が少し変われば反転しうる。帯（1.00〜1.35）から外れたら、帯ではなく係数を疑うこと。
    for (const cls of ["ja", "zh", "ko"]) {
      const ratio = classRatio(cls);
      expect(ratio).toBeGreaterThanOrEqual(1.0);
      expect(ratio).toBeLessThanOrEqual(1.35);
    }
  });

  it("日本語は1件も過小評価しない", () => {
    const jaSamples = samplesOfClass("ja");
    expect(jaSamples.length).toBeGreaterThan(0);
    for (const sample of jaSamples) {
      expect(heuristicTokenCounter.count(sample.text).tokens).toBeGreaterThanOrEqual(
        sample.o200k_base,
      );
    }
  });

  it("⚠ 直っていない範囲: CJK 以外の非ラテン文字は依然として過小評価する（タイ語）", () => {
    // この歯は欠陥を固定するのではなく、JSDoc の「タイ語は依然として過小評価する」という断り書きが実態と一致していることを測る。
    // タイ語の推定が直って赤くなったら、実装のバグではなく JSDoc の断り書きを書き直す合図。
    const ratio = classRatio("th");
    expect(ratio).toBeLessThan(1.0);
  });

  it("#108 が報告した穴の記録: 旧式は日本語を2.5倍以上過小評価していた", () => {
    // この歯は heuristicTokenCounter を一切参照しないので、実装を壊しても赤くならない。「直す前は何が起きていたか」を数値で固定するためだけに残す。
    const legacyCount = (text: string): number => Math.ceil(text.length / 4);
    const jaSamples = samplesOfClass("ja");
    const estimatedSum = jaSamples.reduce((sum, s) => sum + legacyCount(s.text), 0);
    const actualSum = jaSamples.reduce((sum, s) => sum + s.o200k_base, 0);
    const ratio = estimatedSum / actualSum;
    expect(ratio).toBeLessThan(0.4);
  });
});

describe("heuristicTokenCounter の境界（ADR 0483、今の振る舞い）", () => {
  const tokens = (text: string) => heuristicTokenCounter.count(text).tokens;

  it("孤立サロゲートは1コードポイントの非CJKとして数える（例外にしない）", () => {
    expect(tokens("\ud800")).toBe(1);
    expect(tokens("\udc00")).toBe(1);
    expect(tokens("a\ud800b")).toBe(1);
  });

  it("結合文字・ZWJ は1コードポイントずつ数える（見た目の1文字ではない）", () => {
    expect(tokens("é")).toBe(1);
    expect(tokens("\u{1F468}‍\u{1F469}‍\u{1F467}")).toBe(2);
  });

  it("CJK は 0.9、範囲の端: U+4E00 は CJK、U+D7FF までのハングルも CJK、U+D800 以降は非CJK", () => {
    expect(tokens("一")).toBe(1);
    expect(tokens("一".repeat(10))).toBe(9);
    expect(tokens("퟿".repeat(10))).toBe(9);
    expect(tokens("a".repeat(10))).toBe(3);
  });

  it("サロゲートペアの漢字（SIP）は1コードポイントの CJK として数える（コード単位ではない）", () => {
    expect(tokens("\u{20000}".repeat(10))).toBe(9);
  });

  it("ごく長い文字列も整数で数える（整数比なので丸め差が出ない）", () => {
    expect(tokens("a".repeat(1_000_000))).toBe(250_000);
    expect(Number.isInteger(tokens("あ".repeat(1_000_001)))).toBe(true);
  });
});
