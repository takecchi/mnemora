import type {
  ClaimKeyOptions,
  Ctx,
  ObserveResult,
  RecallAssociationQuery,
  RecallBudget,
  RecalledMemory,
  RecallResult,
  Runtime,
} from "@mnemora/core";
import { drainEmbedTicks, type DrainResult } from "./embed-drain.js";
import type { Conversation, ConversationTurn } from "./scenario.js";

/** `queryRecall` が既定で渡す連想枠。`maxCount=10` は、連想でしか届かない gold が12件すべて届く値（5 では 10/12 止まり、ADR 0168）。 */
export const DEFAULT_MNEMORA_PATH_ASSOCIATION: RecallAssociationQuery = { maxCount: 10 };

export interface MnemoraPathOptions {
  budget?: RecallBudget;
  /**
   * `RecallQuery.association` に渡す値。省略時は {@link DEFAULT_MNEMORA_PATH_ASSOCIATION}。連想枠を止めたい呼び出し側は
   * `association: null` を明示すること（`null` は `packages/core` へそのまま転送する）。この既定は
   * `packages/core` 側の既定が変わっても変えない（`examples/chat` が明示的にオプトインしている形のため）。
   */
  association?: RecallAssociationQuery | null;
}

export interface MnemoraPathResult {
  recall: RecallResult;
}

export function externalIdForTurn(index: number): string {
  return `turn-${index}`;
}

/** `buildConversation` は事実表明を必ず先頭（index 0）に置く。その前提をここ1箇所に閉じ込める。 */
export function factStatementExternalId(): string {
  return externalIdForTurn(0);
}

/** {@link ingestConversation} の任意オプション。省略時の挙動は変えない。 */
export interface IngestConversationOptions {
  claimKey?: ClaimKeyOptions;
  /** 診断用のフック。`answer-bench.ts` の呼び出し経路を変えないため、渡さなければ一度も呼ばれない。 */
  onObserved?: (turn: ConversationTurn, result: ObserveResult) => void;
}

/**
 * 会話全体を observe() し、tick() で embed を処理する。`externalId` に turn の連番を使うので、誤って二度 ingest しても
 * Observation は重複しない。
 *
 * `tick()` を1回だけ呼ばないのは、既定 `limit` を超えた分の記憶が `pending` のまま embed されず、`recall()` の ANN 候補にすら
 * ならないため（ADR 0019 §5）。`drainEmbedTicks` で `processed === 0` になるまで回し切り、ingest 終了時点で全件 embed 済みを保証する。
 */
export async function ingestConversation(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
  opts: IngestConversationOptions = {},
): Promise<DrainResult> {
  // `observed.memoryIds`（冪等な再送では空配列）を積算して `drainEmbedTicks` に渡す（claim 0件のまま黙って抜けさせない）。
  let expectedEmbedJobs = 0;
  for (const turn of conversation.userUtterances) {
    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: turn.text,
      speaker: turn.role,
      externalId: externalIdForTurn(turn.index),
      // `opts.claimKey` を省略した呼び出しでは、キー自体を渡さない（`claimKey: undefined` を明示するのとは違う）。
      ...(opts.claimKey !== undefined ? { claimKey: opts.claimKey } : {}),
    });
    expectedEmbedJobs += observed.memoryIds.length;
    opts.onObserved?.(turn, observed);
  }
  return drainEmbedTicks(runtime, ctx, { expectedProcessed: expectedEmbedJobs });
}

/**
 * 経路B（mnemora）の想起段。`opts.association` を省略すると {@link DEFAULT_MNEMORA_PATH_ASSOCIATION} を使う。
 *
 * `opts.association: null` は `packages/core` へそのまま転送する。キーを省略して転送すると、core の既定が on のとき
 * `null` の呼び出しが黙って連想 on になる（ADR 0337）。
 */
export async function queryRecall(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
  opts: MnemoraPathOptions = {},
): Promise<RecallResult> {
  const association =
    opts.association === null ? null : (opts.association ?? DEFAULT_MNEMORA_PATH_ASSOCIATION);
  return runtime.recall(ctx, {
    text: conversation.query,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    association,
  });
}

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

// 欠落値を推測で埋めない（"user" 等を書かない）。null（頼んだが無かった）と「その kind は欄を持ちようが無い」は別の表現にする。
// 既定の経路（companionOf 経由・記録順を渡さない呼び出し）は1バイトも変えない。

/**
 * 話者欄。`provenanceKind === "stated"` のときだけ出す。他の kind は「話者という概念が無い」のであって「分からない」のではないので、
 * 同じ「不明」で潰さない。`stated` で値が無ければ、値で埋めずに「不明」と明示する。
 */
function speakerSegment(m: RecalledMemory): string | undefined {
  if (m.provenanceKind !== "stated") {
    return undefined;
  }
  const speaker = m.speaker;
  return typeof speaker === "string" && speaker.length > 0 ? `[話者:${speaker}]` : "[話者:不明]";
}

/** 主題欄。kind に関わらず常に出す。値が無ければ「なし」と明示し、他の主題を代表値として埋めない。 */
function subjectSegment(m: RecalledMemory): string {
  const subjectId = m.subjectId;
  return typeof subjectId === "string" && subjectId.length > 0
    ? `[主題:${subjectId}]`
    : "[主題:なし]";
}

/**
 * `m` と矛盾関係にある相手の `memoryId` の集合。`RecalledMemory` 単体では非対称（`companionOf` を持つのは同伴取得された側だけ）なので、
 * `all` 全体を見て逆向きも拾う。`contestedWith` も両向きを見る（core は相互参照を要求しないので、片方向にしか無いこともある）。
 */
function contradictionCounterpartIds(m: RecalledMemory, all: readonly RecalledMemory[]): string[] {
  const ids = new Set<string>();
  if (m.retrievedVia === "mandatory_companion" && m.companionOf !== undefined) {
    ids.add(m.companionOf);
  }
  if (m.contestedWith !== undefined) {
    ids.add(m.contestedWith);
  }
  for (const other of all) {
    if (other.companionOf === m.memoryId) {
      ids.add(other.memoryId);
    }
    if (other.contestedWith === m.memoryId) {
      ids.add(other.memoryId);
    }
  }
  return [...ids];
}

function isContestedCounterpart(
  m: RecalledMemory,
  id: string,
  all: readonly RecalledMemory[],
): boolean {
  if (m.contestedWith === id) {
    return true;
  }
  const counterpart = all.find((x) => x.memoryId === id);
  return counterpart !== undefined && counterpart.contestedWith === m.memoryId;
}

interface ContradictionSegmentResult {
  segment: string | undefined;
  /**
   * 非対称文面を1件以上出したら `true`。描画の途中の分岐そのもの（構造）で判定し、出来上がった文字列を部分文字列で
   * 走査し直さない（`digest` の本文に同じ文字列が含まれていても影響しない）。
   */
  hasAsymmetricWording: boolean;
}

/**
 * 矛盾候補欄。既定（`companionOf` だけが由来、または記録順が片方でも分からない）は、相手の digest 本文を埋め込むだけの
 * 対称な文面（回答モデルは memoryId の対応表を持たないため）。`contestedWith` 由来で両側の記録順が分かるときだけ非対称にする
 * （対称な印だと、実 API が本物の訂正でも「分かりません」に倒れることがあった）。
 * 相手が `all` に見つからなければ、本文を捏造せず `memoryId` と「本文未取得」を出す。
 */
function contradictionSegment(
  m: RecalledMemory,
  all: readonly RecalledMemory[],
  order: ReadonlyMap<string, number>,
): ContradictionSegmentResult {
  const counterpartIds = contradictionCounterpartIds(m, all);
  if (counterpartIds.length === 0) {
    return { segment: undefined, hasAsymmetricWording: false };
  }
  const byId = new Map(all.map((x) => [x.memoryId, x] as const));
  const myOrder = order.get(m.memoryId);
  let hasAsymmetricWording = false;
  const parts = counterpartIds.map((id) => {
    const counterpart = byId.get(id);
    if (counterpart === undefined) {
      return `memoryId=${id}（本文未取得）`;
    }
    if (isContestedCounterpart(m, id, all)) {
      const counterpartOrder = order.get(id);
      if (myOrder !== undefined && counterpartOrder !== undefined && myOrder !== counterpartOrder) {
        hasAsymmetricWording = true;
        return myOrder > counterpartOrder
          ? `記録順${counterpartOrder}の「${counterpart.digest}」より後の記録（訂正の可能性）`
          : `記録順${counterpartOrder}の「${counterpart.digest}」が後に記録された（訂正された可能性）`;
      }
    }
    return `「${counterpart.digest}」`;
  });
  return { segment: `[矛盾候補:${parts.join("／")}]`, hasAsymmetricWording };
}

/** 根拠欄。`basisLost` のときだけ出す。根拠が残っている `inferred` の行は1バイトも変えない（再生カセットのハッシュ鍵を動かさない）。 */
function basisSegment(m: RecalledMemory): string | undefined {
  return m.basisLost === true ? "[根拠:失われた]" : undefined;
}

/**
 * `recall.memories` を `recordedAt` の昇順に並べた順位（1始まり）を返す。
 *
 * 生の ISO 8601 ではなく、この順位を描画に使う。生のタイムスタンプを付けると、実 API で訂正が後続するケースの正答率が
 * 5/5 → 1/5 に落ちた（ADR 0295 追記）。同一ミリ秒は `all` の元の順で安定的にタイブレークする（`sort` が安定ソートであることに依拠）。
 */
function recordedOrderById(all: readonly RecalledMemory[]): ReadonlyMap<string, number> {
  const withRecordedAt = all.filter(
    (m): m is RecalledMemory & { recordedAt: Date } => m.recordedAt !== undefined,
  );
  const sorted = [...withRecordedAt].sort(
    (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime(),
  );
  const order = new Map<string, number>();
  sorted.forEach((m, index) => order.set(m.memoryId, index + 1));
  return order;
}

function recordedOrderSegment(
  m: RecalledMemory,
  order: ReadonlyMap<string, number>,
): string | undefined {
  const rank = order.get(m.memoryId);
  return rank !== undefined ? `[記録順:${rank}]` : undefined;
}

/**
 * 行の並び順を「記録順」に揃える凡例。`order-legend` 描画で `answer-trials-render.ts` が測った候補と一字一句同じ文字列で、
 * 同じ器で測った数値の裏付けを保つため2箇所に複製しない（あちらはこの定数を import する）。
 */
export const ORDER_LEGEND_LINE =
  "(記録順: 数が大きいほど後に記録された。行は記録の古い順に並べてある)";

/**
 * `recall.memories` を表示用に並べ替える。`recordedAt` を持つ行だけを昇順に並べ、無い行は並べ替えの対象にせず
 * 元の順のまま末尾に残す（欠落値を推測しない）。元のスコア順はこの出力から復元できないので、必要なら `recall.memories` を直接見ること。
 */
function sortMemoriesForDisplay(
  all: readonly RecalledMemory[],
  order: ReadonlyMap<string, number>,
): RecalledMemory[] {
  const withOrder = all.filter((m) => order.has(m.memoryId));
  const withoutOrder = all.filter((m) => !order.has(m.memoryId));
  const sortedWithOrder = [...withOrder].sort(
    (a, b) => (order.get(a.memoryId) ?? 0) - (order.get(b.memoryId) ?? 0),
  );
  return [...sortedWithOrder, ...withoutOrder];
}

/** 出来事時刻欄。`occurredAt` は3値: `undefined`（欄を出さない）／`null`（頼んだが無かった。`recordedAt` で埋めずに「不明」と明示）／`Date`。 */
function occurredAtSegment(m: RecalledMemory): string | undefined {
  if (m.occurredAt === undefined) {
    return undefined;
  }
  return m.occurredAt === null ? "[出来事時刻:不明]" : `[出来事時刻:${m.occurredAt.toISOString()}]`;
}

interface RecalledMemoryLineResult {
  line: string;
  hasAsymmetricWording: boolean;
}

function renderRecalledMemoryLine(
  m: RecalledMemory,
  all: readonly RecalledMemory[],
  order: ReadonlyMap<string, number>,
): RecalledMemoryLineResult {
  const contradiction = contradictionSegment(m, all, order);
  const segments = [
    `[由来:${m.provenanceKind}]`,
    speakerSegment(m),
    subjectSegment(m),
    contradiction.segment,
    basisSegment(m),
    recordedOrderSegment(m, order),
    occurredAtSegment(m),
  ].filter((s): s is string => s !== undefined);
  return {
    line: `- ${segments.join(" ")} ${m.digest}`,
    hasAsymmetricWording: contradiction.hasAsymmetricWording,
  };
}

/**
 * `hasContestedCorrectionWording` は構造の結果で、`body` を後から部分文字列で走査して調べ直すものではない
 * （`digest` の本文に同じ文字列が含まれていても `true` にならない）。
 */
export interface MnemoraPromptDetail {
  body: string;
  hasContestedCorrectionWording: boolean;
}

/**
 * mnemora path が実際にプロンプトへ積む文字列を、`recall()` の返り値だけから組み立てる。
 *
 * 積むのは `recall.memories` の各行と `(索引: …)` の1行だけで、目次帯の中身は積まない（目次帯をプロンプトへ描画する案は
 * 別の方針として残っている）。`usage.chars` は目次帯の JSON を含み、行に足す装飾タグは数えないので、この関数の出力文字数とは乖離する。
 * 記録順が1つも無いときは並べ替えも凡例も出さない（並べていないのに「並べてある」と書かないため）。
 * 元のスコア順はこの出力から復元できないので、必要なら `recall.memories` を直接見ること。
 * `buildMnemoraPrompt` の公開シグネチャと出力は変えない（あちらは `body` を返すだけのラッパー）。
 */
export function buildMnemoraPromptDetail(recall: RecallResult): MnemoraPromptDetail {
  const order = recordedOrderById(recall.memories);
  const displayOrder = sortMemoriesForDisplay(recall.memories, order);
  const rendered = displayOrder.map((m) => renderRecalledMemoryLine(m, recall.memories, order));
  const digestLines = rendered.map((r) => r.line).join("\n");
  const hasContestedCorrectionWording = rendered.some((r) => r.hasAsymmetricWording);
  const indexLine = `(索引: スコープ内 ${recall.index.totalInScope} 件のうち ${recall.memories.length} 件を提示)`;
  const legendLine = order.size > 0 ? ORDER_LEGEND_LINE : "";
  const body = [legendLine, digestLines, indexLine].filter((s) => s.length > 0).join("\n");
  return { body, hasContestedCorrectionWording };
}

/** `buildMnemoraPromptDetail(recall).body` と同じ後方互換のラッパー。`hasContestedCorrectionWording` も要る呼び出し側は Detail を直接呼ぶこと。 */
export function buildMnemoraPrompt(recall: RecallResult): string {
  return buildMnemoraPromptDetail(recall).body;
}

/** `reported: false` は「呼ばなかった」。載せる記憶が0件のときは `observe()` を呼ばない（`usedMemoryIds` は `min(1)` で、空配列は zod に弾かれる）。 */
export type MemoryUsageReport =
  | { reported: true; recallId: RecallResult["recallId"]; usedMemoryIds: string[] }
  | { reported: false };

/**
 * `recall` がプロンプトに載せた Memory を、使用報告として `observe({ kind: 'memory_usage' })` で mnemora へ返す。
 * 呼ばないと `reinforce` が発火しない。明示的な opt-in で、`tick()` や Scheduler には乗せない（呼ばなくても observe/recall は成立する）。
 * この関数は `recall` を撃たないので、呼んでもその測定値は変わらない。
 */
export async function reportMemoryUsage(
  runtime: Runtime,
  ctx: Ctx,
  recall: RecallResult,
): Promise<MemoryUsageReport> {
  const usedMemoryIds = recall.memories.map((m) => m.memoryId);
  if (usedMemoryIds.length === 0) {
    return { reported: false };
  }
  await runtime.observe(ctx, {
    kind: "memory_usage",
    recallId: recall.recallId,
    usedMemoryIds,
  });
  return { reported: true, recallId: recall.recallId, usedMemoryIds };
}
