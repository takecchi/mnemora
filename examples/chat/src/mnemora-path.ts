import type { Ctx, RecallBudget, RecallResult, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { Conversation } from "./scenario.js";

export interface MnemoraPathOptions {
  budget?: RecallBudget;
}

export interface MnemoraPathResult {
  recall: RecallResult;
}

/**
 * 会話全体を observe() し、tick() で embed を処理する（経路Bの取り込み段）。
 *
 * `externalId` に turn の連番を使う——同じ `conversation` に対してこの関数を
 * 2度呼んでも（例: recall() を budget 有り/無しで2通り試したい呼び出し側が、
 * 誤ってもう一度 ingest してしまっても）Observation が重複して作られない
 * （roadmap.md 段階3の冪等性がそのまま効く）。**呼び出し側は ingest と query を
 * 混ぜて何度も呼ばない**のが前提だが、それでも壊れないようにしてある。
 *
 * **なぜ `tick()` を1回だけ呼ばないのか（docs/decisions/0019-real-openai-measurement-cost.md
 * §5、docs/decisions/0021-drain-embed-ticks-in-ingest.md）**: `tick()` の既定 `limit` は
 * 50（`DEFAULT_TICK_LIMIT`、`packages/core/src/runtime.ts`）。embed ジョブは
 * `claimBatch` が `ORDER BY available_at ASC` で先着順に claim するため、
 * この関数がかつて `tick()` を1回しか呼んでいなかった頃は、**会話が長くなって
 * observe() された発話が50件を超えると、51件目以降の記憶が埋め込まれないまま
 * `pending` に残り、`recall()` の ANN 候補にすらならない**という欠陥があった
 * （`recall()` はこれを `omitted` に `not_indexed(reason: "pending")` として
 * 正直に出していたが、`examples/chat` 側はそれを読まずに「スコープ内 N 件のうち
 * 10件を返した」という表を書いていた——ADR 0019 §5 が実測して記録した）。
 * ここでは `drainEmbedTicks`（`./embed-drain.js`）で `processed === 0` になるまで
 * `tick()` を回し切ることで、**取り込んだ量に関わらず、ingest が終わった時点で
 * 全件が embed 済みであること**を保証する。
 */
export async function ingestConversation(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
): Promise<void> {
  for (const turn of conversation.userUtterances) {
    await runtime.observe(ctx, {
      kind: "utterance",
      text: turn.text,
      speaker: turn.role,
      externalId: `turn-${turn.index}`,
    });
  }
  await drainEmbedTicks(runtime, ctx);
}

/**
 * 経路B（mnemora）の想起段。ingest 済みの `ctx` に対して、終盤の質問を recall() する。
 *
 * **呼び出し側が実際にプロンプトへ積むのは `recall().memories`（の digest）と
 * `index` だけであり、`usage` はその量をそのまま計測している**（docs/recall.md §6）。
 * mnemora 自身はプロンプトを組み立てない（同§6「正直に書くべき限界」）——ここでは
 * その組み立てをサンプルアプリ側（呼び出し側の役）が代行して見せている。
 *
 * `opts.budget` を渡すと、段4（予算による切り詰め）が実際に候補を落とす
 * （docs/recall.md §2 段4）。渡さなければ切り詰めは起こらない。
 */
export async function queryRecall(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
  opts: MnemoraPathOptions = {},
): Promise<RecallResult> {
  return runtime.recall(ctx, {
    text: conversation.query,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
  });
}

/** `ingestConversation` + `queryRecall` を1回で行う便宜関数（`compare.ts` が使う）。 */
export async function runMnemoraPath(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
  opts: MnemoraPathOptions = {},
): Promise<MnemoraPathResult> {
  await ingestConversation(runtime, ctx, conversation);
  const recall = await queryRecall(runtime, ctx, conversation, opts);
  return { recall };
}

/**
 * mnemora path が実際にプロンプトへ積む文字列を、`recall()` の返り値だけから組み立てる。
 * `usage.chars` が数えているのと同じ材料（各 memory の digest + index band の JSON）を
 * 呼び出し側の視点で再現する——「mnemora はプロンプトを組み立てない」ことを実演する関数。
 */
export function buildMnemoraPrompt(recall: RecallResult): string {
  const digestLines = recall.memories.map((m) => `- ${m.digest}`).join("\n");
  const indexLine = `(索引: スコープ内 ${recall.index.totalInScope} 件のうち ${recall.memories.length} 件を提示)`;
  return [digestLines, indexLine].filter((s) => s.length > 0).join("\n");
}
