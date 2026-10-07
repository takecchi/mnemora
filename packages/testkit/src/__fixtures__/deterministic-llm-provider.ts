import type { Ctx, LLMProvider, LLMResponse, PromptSpec, StructuredRequest } from "@mnemora/core";

/**
 * `LLMProvider` の決定的な擬似実装。本物の LLM を模してはいない。同じ入力には常に同じ出力を返す。
 * extraction・consolidation・reflection の3つのスキーマだけを知っており、それ以外のスキーマには例外を投げる。
 */
export class DeterministicLLMProvider implements LLMProvider {
  async complete(_ctx: Ctx, req: PromptSpec): Promise<LLMResponse> {
    const lastMessage = req.messages[req.messages.length - 1];
    return { content: lastMessage?.content ?? "" };
  }

  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const userText = req.prompt.messages.find((m) => m.role === "user")?.content ?? "";
    const digest = userText.length > 40 ? `${userText.slice(0, 40)}…` : userText;

    const extractionCandidate = {
      memories: [
        {
          content: userText,
          digest,
          tags: [],
          provenanceKind: "stated" as const,
        },
      ],
    };
    const extractionParsed = req.schema.safeParse(extractionCandidate);
    if (extractionParsed.success) {
      return extractionParsed.data;
    }

    // extraction の形にマッチしなかった場合だけ、統合の形を試す。
    const consolidationCandidate = { content: userText, digest, tags: [] };
    const consolidationParsed = req.schema.safeParse(consolidationCandidate);
    if (consolidationParsed.success) {
      return consolidationParsed.data;
    }

    // どちらにもマッチしなかった場合だけ、reflection の形を試す。`outcome: 'nothing'` は表現しない。
    const reflectionCandidate = {
      outcome: "reflected" as const,
      content: userText,
      digest,
      tags: [],
    };
    const reflectionParsed = req.schema.safeParse(reflectionCandidate);
    if (reflectionParsed.success) {
      return reflectionParsed.data;
    }

    throw new Error(
      "DeterministicLLMProvider: 未対応のスキーマが渡された（extraction.ts の " +
        "ExtractionResultSchema / runtime.consolidate の統合スキーマ / runtime.reflect の " +
        "反映スキーマ以外の形には対応していない）: " +
        reflectionParsed.error.message,
    );
  }
}
