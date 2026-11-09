import type { Ctx, LLMProvider, StructuredRequest } from "@mnemora/core";
import { createRuntime } from "@mnemora/core";
import {
  PostgresEventStore,
  PostgresLexicalStore,
  PostgresMemoryStore,
  PostgresOutboxStore,
  PostgresTenantSettingsStore,
  PostgresVectorStore,
  closePostgresClient,
  createPostgresClient,
  registerEmbeddingSpace,
  runMigrations,
  sha256Hex,
} from "@mnemora/postgres";
import type { ContestedCase, ContestedTurn } from "./contested-detection-case-set.js";
import { CONTESTED_CASES } from "./contested-detection-case-set.js";
import type { ContestedCaseResult } from "./contested-detection-metrics.js";
import { createProviders } from "./providers.js";

/**
 * いまの発話の oracle の応答を返す LLM。抽出の要求には `memories` を、claim key の要求には `claims` を返す。
 * どちらの要求かは、要求の schema がどちらの形を受け付けるかで決める（runtime の呼び出しの順番に依らない）。
 */
class OracleLLMProvider implements LLMProvider {
  turn: ContestedTurn | null = null;
  /** このケースで claim key の要求に返った鍵（本物の LLM に付けさせたときの記録用）。 */
  derivedKeys: unknown[] = [];

  /**
   * `claimKeyProvider` を渡すと、claim key の要求だけをそちらへ回す（抽出は oracle のまま）。
   * LLM の鍵の付け方の揺れだけを足して測るため（ADR 0703 の追記）。
   */
  constructor(private readonly claimKeyProvider?: LLMProvider) {}

  async complete(): Promise<never> {
    throw new Error("OracleLLMProvider: complete は使わない");
  }

  async completeStructured<T>(_ctx: Ctx, req: StructuredRequest<T>): Promise<T> {
    const turn = this.turn;
    if (turn === null) {
      throw new Error("OracleLLMProvider: 発話を設定する前に呼ばれた");
    }
    const extraction = req.schema.safeParse({
      memories: turn.memories.map((content) => ({ content, provenanceKind: "stated" })),
    });
    if (extraction.success) {
      return extraction.data;
    }
    if (this.claimKeyProvider !== undefined) {
      const derived = await this.claimKeyProvider.completeStructured(_ctx, req);
      this.derivedKeys.push(derived);
      return derived;
    }
    return req.schema.parse({ claims: turn.keys });
  }
}

/** 検出がこの結果で衝突を報告したか（印を付けたか、付けられずに報告だけしたか）。 */
function reportsConflict(kind: string): boolean {
  return kind === "contested" || kind === "contested_group" || kind === "unresolved_conflict";
}

/**
 * ケースごとに新しいテナントで発話を順に `observe()` し（`claimKey: { enabled: true, detectContested: true }`）、
 * どれかの発話で衝突が報告されたかを返す。本物の Postgres を使う。埋め込みは検出に関与しないので `deterministic`。
 */
export async function runContestedDetection(
  databaseUrl: string,
  options: {
    tenantPrefix: string;
    cases?: readonly ContestedCase[];
    /** 渡すと claim key だけを本物の LLM に付けさせる（抽出は oracle のまま）。 */
    claimKeyProvider?: LLMProvider;
  },
): Promise<ContestedCaseResult[]> {
  const client = createPostgresClient(databaseUrl);
  try {
    await runMigrations(client.pool);
    const { embeddingProvider } = createProviders({
      MNEMORA_LLM: "deterministic",
      MNEMORA_EMBEDDING: "deterministic",
    });
    await registerEmbeddingSpace(client.pool, embeddingProvider.space);
    const llm = new OracleLLMProvider(options.claimKeyProvider);
    const runtime = createRuntime({
      memoryStore: new PostgresMemoryStore(client.db),
      outboxStore: new PostgresOutboxStore(client.db),
      vectorStore: new PostgresVectorStore(client.db),
      lexicalStore: new PostgresLexicalStore(client.db),
      eventStore: new PostgresEventStore(client.db),
      tenantSettingsStore: new PostgresTenantSettingsStore(client.db),
      llmProvider: llm,
      embeddingProvider,
      hashContent: sha256Hex,
    });

    const results: ContestedCaseResult[] = [];
    for (const c of options.cases ?? CONTESTED_CASES) {
      const ctx: Ctx = { tenantId: `${options.tenantPrefix}-${c.id}` };
      llm.derivedKeys = [];
      let detected = false;
      for (const [index, turn] of c.turns.entries()) {
        llm.turn = turn;
        const observed = await runtime.observe(ctx, {
          kind: "utterance",
          text: turn.text,
          externalId: `${c.id}-${String(index)}`,
          ...(turn.validFrom !== undefined ? { validFrom: turn.validFrom } : {}),
          ...(turn.validUntil !== undefined ? { validUntil: turn.validUntil } : {}),
          claimKey: { enabled: true, detectContested: true },
        });
        if ((observed.contestedDetection ?? []).some((d) => reportsConflict(d.result.kind))) {
          detected = true;
        }
      }
      results.push({
        id: c.id,
        category: c.category,
        detected,
        ...(options.claimKeyProvider !== undefined ? { derivedKeys: llm.derivedKeys } : {}),
      });
    }
    return results;
  } finally {
    await closePostgresClient(client);
  }
}
