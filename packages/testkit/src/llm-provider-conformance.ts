import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { Ctx, LLMProvider, PromptSpec } from "@mnemora/core";

/**
 * `createFailing` が返す、下層（SDK client 相当）の呼び出しが必ず失敗する provider の一式。
 *
 * `callCount()` を分けて持つのは、「リトライを内蔵しない」という契約
 * （`packages/core/src/interfaces/llm-provider.ts` の doc コメント）が
 * **呼び出し回数についての主張**だからである。例外が同一性のまま伝播したことと、
 * 下層がちょうど1回しか呼ばれなかったことは別の観測であり、どちらか片方だけでは
 * 「リトライを内蔵しない」を測ったことにならない。
 */
export interface LLMProviderFailureHarness {
  /** 下層（SDK client 相当）の呼び出しが必ず失敗する provider。 */
  readonly provider: LLMProvider;
  /** 下層が呼ばれた回数。呼ぶたびに増える必要がある（リトライを内蔵していないことを測るため）。 */
  callCount(): number;
}

export interface LLMProviderConformanceOptions<T> {
  /** 見出しに出す名前（どの実装を測っているかがログで分かる）。 */
  name: string;
  /**
   * **毎回新しいインスタンスを作る**関数。
   *
   * ⛔ 同じインスタンスを使い回さないこと——`packages/testkit/src/embedding-provider-conformance.ts`
   * の `createProvider` と同じ理由である。都度まっさらなインスタンスで検査しないと、
   * ある `it()` が前の `it()` の副作用を踏んでいないかをこの suite では区別できなくなる。
   */
  createProvider: () => LLMProvider | Promise<LLMProvider>;
  /**
   * 🔴 **同じ入力に同じ `content` を返すか。省略できない（必ず宣言すること）。**
   *
   * ⚠ これは `LLMProvider` interface の契約ではない——`packages/core/src/interfaces/llm-provider.ts`
   * は決定性について何も約束していない。**`deterministic: true` を呼び出し側が宣言したときだけ
   * 当たる性質**であり、`describeEmbeddingProviderConformance` の同名オプションとは
   * 「契約かどうか」の位置づけが違う（あちらは埋め込みの順序検査の前提。こちらは任意の
   * 追加の性質）。`false` のとき、決定性に依存する歯は消えるのではなく **`it.skip` として
   * 名前だけ残る**——「測っていない」ことをテスト名で名乗る（ADR 0095 決定2・決定3 と同じ形）。
   */
  deterministic: boolean;
  /**
   * suite が投げるプロンプト。
   *
   * ⛔ suite 側で文字列を決め打ちしない——`RecordedLLMProvider`（ADR 0051）は記録に無い入力を
   * 渡されると例外を投げるため、何を投げてよいかはカセットを持っている側（呼び出し側）にしか
   * 決められない（`describeEmbeddingProviderConformance` の `texts` と同じ理由）。
   */
  prompt: PromptSpec;
  /**
   * `completeStructured` に渡す prompt と schema。`prompt` を分けて持つ理由は上と同じ。
   *
   * ⚠ **`schema` は `.shape` を持つ `z.object(...)` を前提にしている。**歯2
   * （余計な欄が漏れていないことの検査）が「schema が宣言した欄の集合」を得るために
   * `schema.shape` を読む。`z.object(...)` 以外（`z.union(...)` 等）を渡した場合、
   * 歯2はその場で分かりやすい例外を投げて止まる——黙って何も検査しない形にはしていない。
   */
  structured: { prompt: PromptSpec; schema: z.ZodType<T> };
  /**
   * 🔴 省略できない。**作れないなら `null` を明示すること。**
   *
   * `null` のとき、失敗系の歯（5〜8）は消えずに `it.skip` として名前だけ残る
   * ——「測っていない」ことをテスト名で名乗る（ADR 0095 決定2・決定3 と同じ形）。
   * `RecordedLLMProvider` のように client を注入する口を持たない実装は、これを
   * `null` にする（`packages/testkit/src/__tests__/llm-provider-conformance.test.ts` が実例）。
   */
  createFailing:
    ((error: unknown) => LLMProviderFailureHarness | Promise<LLMProviderFailureHarness>) | null;
  /** 省略時は `{ tenantId: "llm-provider-conformance" }`。 */
  ctx?: Ctx;
  /**
   * 各 `it` のタイムアウト（ミリ秒）。**省略時は vitest の既定（5秒）。**
   * 理由は `describeEmbeddingProviderConformance` の同名オプションと同じ
   * ——本物の実装（ネットワーク往復）に当てることを想定している。
   */
  timeout?: number;
}

const defaultCtx: Ctx = { tenantId: "llm-provider-conformance" };

/** `structured.schema` が宣言した欄の名前の集合を取り出す。
 * `options.structured` の doc コメントの通り、`z.object(...)` の `.shape` を前提にする。 */
function declaredFieldNames(schema: z.ZodType<unknown>): Set<string> {
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape || typeof shape !== "object") {
    throw new Error(
      "describeLLMProviderConformance: structured.schema は .shape を持つ z.object(...) を" +
        "前提にしている（余計な欄が漏れていないかを検査するには、宣言された欄の集合が要る）。" +
        "z.object(...) 以外のスキーマを渡していないか確認すること。",
    );
  }
  return new Set(Object.keys(shape));
}

/**
 * `LLMProvider` の適合テスト（Issue #389、ADR 0266）。
 *
 * `packages/core/src/interfaces/llm-provider.ts` の doc コメントが「契約:」として
 * **逐語で書いている条項だけ**を検査する。新しい契約は発明しない:
 *
 * > - `completeStructured` はベンダー固有の Structured Output 機構へ翻訳する義務を negate
 * >   できない。core・呼び出し側に OpenAI/Anthropic SDK の型を漏らしてはならない。
 * > - タイムアウト・レート制限・失敗時は例外を投げる。`LLMProvider` 自体はリトライを
 * >   内蔵しない（責務の混在を避ける）。
 *
 * ⛔ **射程外**（ADR 0198 が意図的に外へ出した論点であり、この suite でも踏み込まない）:
 * - `refusal` / `truncated` / `no_content` を `packages/core` の型へ格上げするかどうか
 * - `complete()` が空応答に `?? ""` で空文字を返すことの是非
 *
 * ⛔ **測っていないこと**（呼び出し側の `describeLLMProviderConformance(...)` 呼び出しに
 * 依存する。ここでは一般に言えることだけを書く）:
 * - HTTP・認証・レート制限そのもの・実 API 自身の振る舞い。それらは注入した偽 client の
 *   形を超えて測る手段をこの suite は持たない。
 * - `LLMProvider` を new する側（`packages/openai` / `packages/anthropic`）が SDK の
 *   `client` 引数を省略したときの**既定のリトライ**（ADR 0198 の負債 (a) と同じ）。
 *   `createFailing` は注入した偽 client を使うため、この suite が測るのは
 *   「wrapper 自身がリトライを足していないか」であって「SDK 既定のリトライを含めた
 *   production の経路が1回しか叩かないか」ではない。
 */
export function describeLLMProviderConformance<T>(options: LLMProviderConformanceOptions<T>): void {
  const {
    name,
    createProvider,
    deterministic,
    prompt,
    structured,
    createFailing,
    ctx = defaultCtx,
    timeout,
  } = options;

  describe(`LLMProvider conformance (${name})`, () => {
    // ------------------------------------------------------------------
    // 条項1: core は SDK の型を漏らさない / provider 非依存の最小限の型のみ。
    // ------------------------------------------------------------------

    it(
      'complete が返すオブジェクトの Object.keys() はちょうど ["content"]（ベンダー固有の欄が漏れていない）',
      async () => {
        const provider = await createProvider();

        const response = await provider.complete(ctx, prompt);

        expect(Object.keys(response)).toEqual(["content"]);
        expect(typeof response.content).toBe("string");
      },
      timeout,
    );

    it(
      "completeStructured が返すオブジェクトの欄は、structured.schema が宣言した欄の集合に収まっている（余計な欄が漏れていない）",
      async () => {
        const provider = await createProvider();
        const allowed = declaredFieldNames(structured.schema);

        const result = await provider.completeStructured(ctx, {
          prompt: structured.prompt,
          schema: structured.schema,
        });

        for (const key of Object.keys(result as Record<string, unknown>)) {
          expect(allowed.has(key)).toBe(true);
        }
      },
      timeout,
    );

    // ------------------------------------------------------------------
    // 決定性（⚠ interface の契約ではない。`deterministic: true` を宣言したときだけ当たる）。
    // ------------------------------------------------------------------

    const maybeDeterministicIt = deterministic ? it : it.skip;

    maybeDeterministicIt(
      deterministic
        ? "complete: 同じ入力を2回呼ぶと、同じ content が返る"
        : "（測っていない: deterministic が false）complete: 同じ入力を2回呼ぶと、同じ content が返る",
      async () => {
        const provider = await createProvider();

        const first = await provider.complete(ctx, prompt);
        const second = await provider.complete(ctx, prompt);

        expect(second.content).toEqual(first.content);
      },
      timeout,
    );

    maybeDeterministicIt(
      deterministic
        ? "completeStructured: 同じ入力を2回呼ぶと、同じ値が返る"
        : "（測っていない: deterministic が false）completeStructured: 同じ入力を2回呼ぶと、同じ値が返る",
      async () => {
        const provider = await createProvider();
        const req = { prompt: structured.prompt, schema: structured.schema };

        const first = await provider.completeStructured(ctx, req);
        const second = await provider.completeStructured(ctx, req);

        expect(second).toEqual(first);
      },
      timeout,
    );

    // ------------------------------------------------------------------
    // 条項3（失敗時は例外を投げる）と条項4（リトライを内蔵しない）。
    // ------------------------------------------------------------------

    const maybeFailingIt = createFailing !== null ? it : it.skip;

    maybeFailingIt(
      createFailing !== null
        ? "complete: 下層の失敗を同一の例外オブジェクトのまま伝播する"
        : "（測っていない: createFailing が null）complete: 下層の失敗を同一の例外オブジェクトのまま伝播する",
      async () => {
        const sentinel = new Error(
          "llm-provider-conformance: injected failure (complete/propagate)",
        );
        // createFailing !== null はこの it が実行される条件そのものである
        // （maybeFailingIt の分岐）。ここへ来た時点で null ではない。
        const harness = await createFailing!(sentinel);

        // 🔴 同一性で見る（`toBe`）。`toThrow(/…/)` はメッセージ一致でしか見ないため、
        // wrapper が別の Error へ包み直してもメッセージさえ揃えば通ってしまう。
        await expect(harness.provider.complete(ctx, prompt)).rejects.toBe(sentinel);
      },
      timeout,
    );

    maybeFailingIt(
      createFailing !== null
        ? "complete: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）"
        : "（測っていない: createFailing が null）complete: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）",
      async () => {
        const sentinel = new Error("llm-provider-conformance: injected failure (complete/retry)");
        const harness = await createFailing!(sentinel);

        await expect(harness.provider.complete(ctx, prompt)).rejects.toBe(sentinel);

        expect(harness.callCount()).toBe(1);
      },
      timeout,
    );

    maybeFailingIt(
      createFailing !== null
        ? "completeStructured: 下層の失敗を同一の例外オブジェクトのまま伝播する"
        : "（測っていない: createFailing が null）completeStructured: 下層の失敗を同一の例外オブジェクトのまま伝播する",
      async () => {
        const sentinel = new Error(
          "llm-provider-conformance: injected failure (completeStructured/propagate)",
        );
        const harness = await createFailing!(sentinel);
        const req = { prompt: structured.prompt, schema: structured.schema };

        await expect(harness.provider.completeStructured(ctx, req)).rejects.toBe(sentinel);
      },
      timeout,
    );

    maybeFailingIt(
      createFailing !== null
        ? "completeStructured: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）"
        : "（測っていない: createFailing が null）completeStructured: 下層はちょうど1回しか呼ばれない（リトライを内蔵しない）",
      async () => {
        const sentinel = new Error(
          "llm-provider-conformance: injected failure (completeStructured/retry)",
        );
        const harness = await createFailing!(sentinel);
        const req = { prompt: structured.prompt, schema: structured.schema };

        await expect(harness.provider.completeStructured(ctx, req)).rejects.toBe(sentinel);

        expect(harness.callCount()).toBe(1);
      },
      timeout,
    );
  });
}
