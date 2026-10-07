import OpenAI from "openai";
// 型だけの import（`providers.ts` が本モジュールを値として import しているので、`import type` で循環を避ける）。
import type { ProviderMode } from "./providers.js";

/**
 * `OpenAILLMProvider`/`OpenAIEmbeddingProvider` は `response.usage` を捨てて返すので、計測は provider の外からではなく `client` 自体を横取りして行う。
 * 偽の `client` オブジェクトは組み立てず、本物の `OpenAI` インスタンスの `chat.completions.create`/`embeddings.create` を差し替える（SDK のクラスは `protected _client` を持つ `APIResource` を継承していて、オブジェクトリテラルでは型を満たせない）。
 */

/** 公開価格の書き写しで、動的に取得した値ではない。値上げ・値下げ・新モデルでも自動更新されない（実際の請求額は OpenAI のダッシュボードで確認する）。 */
const PRICING_USD_PER_MILLION_TOKENS: Readonly<
  Record<string, { readonly input: number; readonly output?: number }>
> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "text-embedding-3-small": { input: 0.02 },
};

export interface OpenAIUsageTotals {
  chatCalls: number;
  chatPromptTokens: number;
  chatCompletionTokens: number;
  embeddingCalls: number;
  embeddingPromptTokens: number;
}

export interface OpenAIUsageCost {
  llmInputUsd: number;
  llmOutputUsd: number;
  embeddingUsd: number;
  totalUsd: number;
}

export interface UsageMeterOptions {
  apiKey?: string;
  llmModel: string;
  embeddingModel: string;
}

export interface UsageMeter {
  client: OpenAI;
  totals(): OpenAIUsageTotals;
  cost(): OpenAIUsageCost;
  formatReport(): string;
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

/** `create` を集計付きの実装へ差し替える。単一の実装関数はオーバーロードの型へ代入できないので、代入の最後に一度だけ宣言側の型へ `as` で戻す（実際に呼ぶのは非 streaming・非 base64 だけ）。 */
export function createUsageMeter(options: UsageMeterOptions): UsageMeter {
  const client = new OpenAI({ apiKey: options.apiKey });

  const totals: OpenAIUsageTotals = {
    chatCalls: 0,
    chatPromptTokens: 0,
    chatCompletionTokens: 0,
    embeddingCalls: 0,
    embeddingPromptTokens: 0,
  };

  type ChatCreate = OpenAI["chat"]["completions"]["create"];
  const originalChatCreate = client.chat.completions.create.bind(client.chat.completions);
  const meteredChatCreate = ((
    body: Parameters<ChatCreate>[0],
    requestOptions?: Parameters<ChatCreate>[1],
  ) => {
    const result = originalChatCreate(body, requestOptions);
    result
      .then((response) => {
        if (!isAsyncIterable(response)) {
          totals.chatCalls += 1;
          totals.chatPromptTokens += response.usage?.prompt_tokens ?? 0;
          totals.chatCompletionTokens += response.usage?.completion_tokens ?? 0;
        }
      })
      .catch(() => {
        // 集計の失敗で本来の呼び出しを壊さない。
      });
    return result;
  }) as ChatCreate;
  client.chat.completions.create = meteredChatCreate;

  type EmbeddingsCreate = OpenAI["embeddings"]["create"];
  const originalEmbeddingsCreate = client.embeddings.create.bind(client.embeddings);
  const meteredEmbeddingsCreate = ((
    body: Parameters<EmbeddingsCreate>[0],
    requestOptions?: Parameters<EmbeddingsCreate>[1],
  ) => {
    const result = originalEmbeddingsCreate(body, requestOptions);
    result
      .then((response) => {
        totals.embeddingCalls += 1;
        totals.embeddingPromptTokens += response.usage?.prompt_tokens ?? 0;
      })
      .catch(() => {
        // 集計の失敗で本来の呼び出しを壊さないため、ここでは握りつぶす。
      });
    return result;
  }) as EmbeddingsCreate;
  client.embeddings.create = meteredEmbeddingsCreate;

  function cost(): OpenAIUsageCost {
    const llmPricing = PRICING_USD_PER_MILLION_TOKENS[options.llmModel];
    const embeddingPricing = PRICING_USD_PER_MILLION_TOKENS[options.embeddingModel];
    if (!llmPricing || llmPricing.output === undefined) {
      throw new Error(
        `usage-meter: 価格表に "${options.llmModel}" の input/output 単価が無い。` +
          "PRICING_USD_PER_MILLION_TOKENS に追加すること。",
      );
    }
    if (!embeddingPricing) {
      throw new Error(
        `usage-meter: 価格表に "${options.embeddingModel}" の単価が無い。` +
          "PRICING_USD_PER_MILLION_TOKENS に追加すること。",
      );
    }
    const llmInputUsd = (totals.chatPromptTokens / 1_000_000) * llmPricing.input;
    const llmOutputUsd = (totals.chatCompletionTokens / 1_000_000) * llmPricing.output;
    const embeddingUsd = (totals.embeddingPromptTokens / 1_000_000) * embeddingPricing.input;
    return {
      llmInputUsd,
      llmOutputUsd,
      embeddingUsd,
      totalUsd: llmInputUsd + llmOutputUsd + embeddingUsd,
    };
  }

  function formatReport(): string {
    const t = totals;
    const c = cost();
    const usd = (n: number) => `$${n.toFixed(6)}`;
    return [
      "--- OpenAI API 実測（usage-meter） ---",
      "（成功して応答が返った呼び出しだけを数える。失敗した呼び出し——SDK の再送を含む——は数えない。ADR 0445）",
      `chat.completions.create: 呼び出し ${t.chatCalls} 回 / ` +
        `prompt_tokens=${t.chatPromptTokens} / completion_tokens=${t.chatCompletionTokens}`,
      `embeddings.create      : 呼び出し ${t.embeddingCalls} 回 / prompt_tokens=${t.embeddingPromptTokens}`,
      "費用（2026-09 時点の公開価格表による概算。OpenAI の請求 API から取得した実額ではない）:",
      `  LLM input  : ${usd(c.llmInputUsd)}`,
      `  LLM output : ${usd(c.llmOutputUsd)}`,
      `  Embedding  : ${usd(c.embeddingUsd)}`,
      `  合計       : ${usd(c.totalUsd)}`,
    ].join("\n");
  }

  return {
    client,
    totals: () => ({ ...totals }),
    cost,
    formatReport,
  };
}

/**
 * API を叩かなかった run の注記。0 を黙って出さない（「呼び出し0回・費用$0」だけでは、本物を叩いて0回だったのか叩いていないのか区別できない）。
 * モードは省略可能にしない（呼び出し側に真実を言わせる。決め打ちの文言は `recorded`/`local` が入って嘘になった）。
 */
export function formatNoApiCallsNotice(modes: {
  llmMode: ProviderMode;
  embeddingMode: ProviderMode;
}): string {
  const label = (mode: ProviderMode): string => {
    switch (mode) {
      case "recorded":
        return "記録の再生";
      case "deterministic":
        return "擬似 stub";
      case "local":
        return "ローカル推論（@mnemora/local-embedding、外部サービスに繋がない）";
      case "openai":
        return "本物の OpenAI";
      default: {
        const exhaustive: never = mode;
        throw new Error(`formatNoApiCallsNotice: 未知の ProviderMode: ${String(exhaustive)}`);
      }
    }
  };
  const usesRecorded = modes.llmMode === "recorded" || modes.embeddingMode === "recorded";
  return (
    "--- OpenAI API 実測（usage-meter） ---\n" +
    `この run では OpenAI の API を一切叩いていない（LLM=${label(modes.llmMode)} / ` +
    `埋め込み=${label(modes.embeddingMode)}）。` +
    "呼び出し回数・トークン・費用は計測対象が存在しない（0 ではなく、計測していない）。" +
    (usesRecorded
      ? "\n⚠ 「記録の再生」が返す値は本物の API 応答に由来するが、" +
        "**この run 自体は API を叩いていない**——費用と、値の出所は別の話である。"
      : "")
  );
}
