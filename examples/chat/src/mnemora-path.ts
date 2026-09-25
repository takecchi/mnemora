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
import { drainEmbedTicks } from "./embed-drain.js";
import type { Conversation, ConversationTurn } from "./scenario.js";

/**
 * `queryRecall` が既定で渡す `RecallQuery.association`（Issue #291 / ADR 0168）。
 *
 * **値の根拠**: `association-probes` ベンチ（ADR 0158 / 0167 で器の非決定性・
 * probe の公正性を直した後の実測、Issue #291 の 2026-09-16 コメント）が
 * `maxCount=10` で `goldReturned` 0/12 → 12/12（連想でしか届かない gold の
 * 到達が全件揃う）、費用は `memoryChars` +4.32% だったことに基づく。
 * `maxCount=5` では 10/12 止まり（+2.22%）——「聞かれていないことを自分から
 * 思い出す」という目指す姿を、この12件の範囲で完全に満たすのは 10 だけである。
 * 詳細は ADR 0168。
 */
export const DEFAULT_MNEMORA_PATH_ASSOCIATION: RecallAssociationQuery = { maxCount: 10 };

export interface MnemoraPathOptions {
  budget?: RecallBudget;
  /**
   * `RecallQuery.association` に渡す値。**省略時は
   * {@link DEFAULT_MNEMORA_PATH_ASSOCIATION} を渡す**（ADR 0168。「聞かれていないことを、
   * 自分から思い出す」を実際に呼び手側で使う経路にするための既定）。
   * 連想枠そのものを止めたい呼び出し側（比較・検査のため）は `association: null` を
   * 明示すること——`packages/core` 側の既定（省略時 off）とは別に、この関数だけの
   * 既定を on にしている（ADR 0151「決定」の既定 off はそのまま——ここは
   * `examples/chat` という一呼び手が、明示的にオプトインしている形である）。
   */
  association?: RecallAssociationQuery | null;
}

export interface MnemoraPathResult {
  recall: RecallResult;
}

export function externalIdForTurn(index: number): string {
  return `turn-${index}`;
}

/**
 * 冒頭の事実表明（`FACT_STATEMENT`）を取り込んだ Observation の `externalId`。
 *
 * `buildConversation` は事実表明を必ず先頭（index 0）に置く（`scenario.ts`）。
 * **その前提をここで1箇所に閉じ込める**——`compare.ts` が系譜を辿って
 * 「冒頭の事実の出典に到達したか」を判定するのに使う（ADR 0052）。
 */
export function factStatementExternalId(): string {
  return externalIdForTurn(0);
}

/**
 * {@link ingestConversation} の任意オプション（Issue #691 続き、claimKey 評価用の opt-in）。
 *
 * **既定（省略）では、これまでと1バイトも挙動が変わらない**——`claimKey` を省略すると
 * `runtime.observe()` へ `claimKey` キー自体を渡さない（`undefined` を明示的に渡すのでは
 * なく、キーを持たない）ので、`packages/core` 側は「claimKey opt-in を渡さなかった
 * 呼び出し」として扱う（ADR 0320/0324 の既定 off の規約と同じ）。`onObserved` も
 * 省略すれば呼ばれない。
 */
export interface IngestConversationOptions {
  /** 渡すと `runtime.observe()` の各呼び出しへそのまま転送する（ADR 0320/0324）。 */
  claimKey?: ClaimKeyOptions;
  /**
   * 診断用のフック。各ターンを observe() した直後、そのターンと `ObserveResult`
   * （`claimKeyFailure`/`contestedDetection` を含む）を受け取る。**`answer-bench.ts` の
   * 呼び出し経路を変えない**——`runAnswerCase`/`runAnswerBench` 経由で渡さなければ、
   * このフックは一度も呼ばれない。
   */
  onObserved?: (turn: ConversationTurn, result: ObserveResult) => void;
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
  opts: IngestConversationOptions = {},
): Promise<void> {
  // Issue #719: `observed.memoryIds`(冪等な再送では空配列——`ObserveResult` の
  // docstring)を積算し、`drainEmbedTicks` に渡す——`compare`/`retrieval` が使う
  // 主測定の取り込み段であるため、「available_at との ms 競合で claim 0件のまま」
  // 黙って抜けないことをここでも検査させる。
  let expectedEmbedJobs = 0;
  for (const turn of conversation.userUtterances) {
    const observed = await runtime.observe(ctx, {
      kind: "utterance",
      text: turn.text,
      speaker: turn.role,
      externalId: externalIdForTurn(turn.index),
      // ⭐ `opts.claimKey` を省略した呼び出しでは、このキー自体を渡さない
      // （`claimKey: undefined` を明示するのとは違う——`IngestConversationOptions`
      // docstring参照）。既存の呼び出し側の挙動を1バイトも変えないための規律。
      ...(opts.claimKey !== undefined ? { claimKey: opts.claimKey } : {}),
    });
    expectedEmbedJobs += observed.memoryIds.length;
    opts.onObserved?.(turn, observed);
  }
  await drainEmbedTicks(runtime, ctx, { expectedProcessed: expectedEmbedJobs });
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
 *
 * **既定で `association`（連想枠、ADR 0151・Issue #291・ADR 0168）を渡す**——
 * `opts.association` を省略すると {@link DEFAULT_MNEMORA_PATH_ASSOCIATION} が使われる。
 * 明示的に `association: null` を渡した呼び出しだけが、連想枠を持たない
 * `packages/core` の既定（off）のまま呼ぶ。
 */
export async function queryRecall(
  runtime: Runtime,
  ctx: Ctx,
  conversation: Conversation,
  opts: MnemoraPathOptions = {},
): Promise<RecallResult> {
  const association =
    opts.association === null ? undefined : (opts.association ?? DEFAULT_MNEMORA_PATH_ASSOCIATION);
  return runtime.recall(ctx, {
    text: conversation.query,
    ...(opts.budget !== undefined ? { budget: opts.budget } : {}),
    ...(association !== undefined ? { association } : {}),
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

// ---------------------------------------------------------------------------
// buildMnemoraPrompt の各欄の描画（Issue #691）
//
// ケース定義・決めたことの詳細は
// `__tests__/provenance-prompt-cases.ts` の冒頭コメントを参照。要点だけ:
// - null（頼んだが無かった）と「その kind は欄を持ちようが無い」を別の表現にする。
// - 欠落値を推測で埋めない（"user" 等を書かない）。
// - 矛盾関係は recall.memories 全体を見て、companionOf の向き先・向かれ元の
//   両方に対称な印を出す。中身は相手の memoryId ではなく相手の digest 本文。
// - contestedWith（Issue #691 続き、ADR 0335）も同じ矛盾候補欄に合流する——
//   同伴取得（companionOf）を経由せず、両方とも ann/lexical で自然に候補に
//   入った contested な対にも印が出るようにする。
// ---------------------------------------------------------------------------

/**
 * 話者欄。`provenanceKind === "stated"` のときだけ出す
 * （`RecalledMemory.speaker` の docstring・ADR 0289: 他の kind は「話者という概念が
 * 無い」のであって「話者が分からない」のではない——同じ「不明」表示で潰さない）。
 * `stated` で値が無ければ、値で埋めずに「不明」と明示する。
 */
function speakerSegment(m: RecalledMemory): string | undefined {
  if (m.provenanceKind !== "stated") {
    return undefined;
  }
  const speaker = m.speaker;
  return typeof speaker === "string" && speaker.length > 0 ? `[話者:${speaker}]` : "[話者:不明]";
}

/**
 * 主題欄。`subjectId` はどの `provenanceKind` でも持ちうる欄なので、kind に関わらず
 * 常に出す。値が無ければ（例: 統合で subject をまたいだ）「なし」と明示する
 * ——他の主題を代表値として埋めない。
 */
function subjectSegment(m: RecalledMemory): string {
  const subjectId = m.subjectId;
  return typeof subjectId === "string" && subjectId.length > 0
    ? `[主題:${subjectId}]`
    : "[主題:なし]";
}

/**
 * `m` と矛盾関係にある相手の `memoryId` の集合。`RecalledMemory` 単体では非対称
 * （`companionOf` を持つのは同伴取得された側だけ、`docs/recall.md` §8）なので、
 * `all` 全体を見て逆向き（`m` が誰かの `companionOf` に指されている側）も拾う。
 *
 * `contestedWith`（Issue #691 続き、[ADR 0335](../../../docs/decisions/0335-recalled-memory-contested-with.md)）も
 * 同じ理由で両向きを見る——`companionOf` は「同伴取得（段3）でだけ付く」ため、
 * 矛盾する2件が `"ann"`/`"lexical"` で自然に両方とも候補に入った場合には
 * 印を出す手段が無かった。`contestedWith` は取得経路を問わず、相手が同じ
 * recall 結果に含まれるときだけ付くので、`companionOf` と違い**双方が自分自身の
 * 欄として持ちうる**（一方向にしか設定されていないこともある——`core` 側は
 * 相互参照を要求しない、`RecalledMemory.contestedWith` の doc 参照）。
 * `Set` で重複を除くため、同伴取得の既存の出力（`companionOf` 側の印）とは
 * 重複しても表示は1つにまとまる。
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

/**
 * 矛盾候補欄。相手が見つかれば相手の digest 本文を埋め込む（回答モデルは memoryId の
 * 対応表を持たないため、id だけでは対立が読めない）。相手が `all` の中に見つからない
 * （想定外の入力）場合は、本文を捏造せず `memoryId` と「本文未取得」を出す。
 * 矛盾関係が無ければ欄そのものを出さない。
 */
function contradictionSegment(
  m: RecalledMemory,
  all: readonly RecalledMemory[],
): string | undefined {
  const counterpartIds = contradictionCounterpartIds(m, all);
  if (counterpartIds.length === 0) {
    return undefined;
  }
  const byId = new Map(all.map((x) => [x.memoryId, x] as const));
  const parts = counterpartIds.map((id) => {
    const counterpart = byId.get(id);
    return counterpart !== undefined ? `「${counterpart.digest}」` : `memoryId=${id}（本文未取得）`;
  });
  return `[矛盾候補:${parts.join("／")}]`;
}

/**
 * `recall.memories` を `recordedAt` の昇順で並べ替えた順位（1始まり）を返す
 * （Issue #691 の子、Issue #702、ADR 0298）。
 *
 * 🔴 **生の ISO 8601 ではなく、この順位を描画に使う。** 実 API（gpt-4o-mini）での
 * dev 対照で、生のタイムスタンプを行末に付けると `schedule-change-meeting-day`
 * （「金曜→水曜」の訂正が後続するケース）の正答率が 5/5 → 1/5 に落ちることを実測した
 * ——ISO 文字列どうしの日時比較より、小さい整数の大小関係のほうがモデルに
 * 読み取らせやすいと考えられる（数値・他の描画候補との比較は ADR 0295 の追記、
 * PR #698 本文を参照）。
 *
 * `recordedAt` が `undefined`（そもそも欄を渡さなかった呼び出し側）の要素は
 * 順位付けの対象から外す。同じ `recordedAt`（同一ミリ秒）の要素は、`all` に現れた
 * 元の順序で安定的にタイブレークする——`Array.prototype.sort` が安定ソートである
 * ことに依拠する（ECMA-262 の要件、Node.js の V8 実装も安定）。
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

/**
 * 記録順欄。`recordedOrderById` が順位を持たない（`recordedAt` が `undefined`）
 * 要素には欄を出さない。
 */
function recordedOrderSegment(
  m: RecalledMemory,
  order: ReadonlyMap<string, number>,
): string | undefined {
  const rank = order.get(m.memoryId);
  return rank !== undefined ? `[記録順:${rank}]` : undefined;
}

/**
 * 行の並び順を「記録順」に揃える凡例（ADR 0309、Issue #691 の続き）。
 *
 * `sortMemoriesForDisplay` で行そのものを並べ替えたときにだけ、この1行を本文の
 * 先頭へ足す——**`order-legend` という描画名で `examples/chat/src/answer-trials-render.ts`
 * が測った候補と、一字一句同じ文字列**（同じ器で測った数値の裏付けを保つため、
 * 2箇所に手で複製しない。あちらはこの定数を import する）。
 */
export const ORDER_LEGEND_LINE =
  "(記録順: 数が大きいほど後に記録された。行は記録の古い順に並べてある)";

/**
 * `recall.memories` を表示用に並べ替える（ADR 0309 が採用した `order-legend` 描画）。
 *
 * **`recordedAt` を持つ行（`order` に順位がある行）だけを昇順に並べ替える。**
 * `recordedAt` が無い行（`order` に順位が無い行）は、並べ替えの対象にせず、
 * 元の（`recall()` が返した、スコアによる）配列順のまま**末尾に**残す——
 * 「無い」ものを先頭に回したり、他の値で埋めたりしない（欠落値を推測しない、
 * Issue #691 完了条件1・ADR 0298 決定7と同じ規律）。
 *
 * ⚠ **`recall.memories` の元の並び（スコア降順、`docs/recall.md` §2）は、この並べ替えで
 * 失われる。** `recordedOrderById`/`recordedOrderSegment` が付ける `[記録順:N]` タグは
 * 元のスコア順を保ったまま添えるだけの注記だったが、この関数は行そのものの表示順序を
 * 記録順へ差し替える——呼び出し側がスコア順を知りたい場合、この関数の出力からは
 * 復元できない（`RecallResult.memories` 自体は変更していないので、`recall.memories`
 * を直接見ればスコア順は残っている）。
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

/**
 * 出来事時刻欄（Issue #691 の子、Issue #702、ADR 0298）。`occurredAt` は3値ある:
 * `undefined`（頼んでいない・欄を出さない）／`null`（頼んだが無かった・
 * `recordedAt` の値で埋めずに「不明」と明示する——`speaker` の `null` と同じ規律）／
 * `Date`（値がある・ISO 8601 で出す）。
 */
function occurredAtSegment(m: RecalledMemory): string | undefined {
  if (m.occurredAt === undefined) {
    return undefined;
  }
  return m.occurredAt === null ? "[出来事時刻:不明]" : `[出来事時刻:${m.occurredAt.toISOString()}]`;
}

/**
 * 1件の `RecalledMemory` を1行に描画する。
 * 欄の順序: 由来 → 話者 → 主題 → 矛盾候補 → 記録順 → 出来事時刻 → digest。
 */
function renderRecalledMemoryLine(
  m: RecalledMemory,
  all: readonly RecalledMemory[],
  order: ReadonlyMap<string, number>,
): string {
  const segments = [
    `[由来:${m.provenanceKind}]`,
    speakerSegment(m),
    subjectSegment(m),
    contradictionSegment(m, all),
    recordedOrderSegment(m, order),
    occurredAtSegment(m),
  ].filter((s): s is string => s !== undefined);
  return `- ${segments.join(" ")} ${m.digest}`;
}

/**
 * mnemora path が実際にプロンプトへ積む文字列を、`recall()` の返り値だけから組み立てる。
 * `usage.chars` が数えているのと同じ材料（各 memory の digest + index band の JSON）を
 * 呼び出し側の視点で再現する——「mnemora はプロンプトを組み立てない」ことを実演する関数。
 *
 * **2026-09（Issue #691）**: digest だけでなく、由来（`provenanceKind`）・話者
 * （`speaker`）・主題（`subjectId`）・矛盾関係（`companionOf`/`retrievedVia`）も
 * 1行ずつ埋め込む。**`usage.chars` はこの追加分を数えていない**——`usage.chars` は
 * `recall()` 自身の返り値の量であり、この関数が実際に文字列へ足す装飾（`[由来:...]`
 * 等のタグ）は呼び出し側だけが知っている増分である。`compare` の `mnemoraChars`
 * （`recall.usage.chars` をそのまま使う）とこの関数の出力文字数は、本 PR 以降
 * さらに乖離する——詳細と実測は `docs/recall.md` §6・`examples/chat/README.md`
 * 「`answer`」節・本変更の PR 本文を参照。
 *
 * **2026-09（ADR 0309、`order-legend` 描画）**: 行の並びを `recordedAt` の昇順
 * （`sortMemoriesForDisplay`）へ差し替え、少なくとも1行が `[記録順:N]` を持つとき
 * （＝ `order.size > 0`）だけ、本文の先頭に {@link ORDER_LEGEND_LINE} を1行足す。
 * 記録順が1つも無い（`recordedAt` を誰も渡していない）呼び出しでは、並べ替えも
 * 凡例も出さない——「並べてある」という文言を、並べ替えていないのに出さないため
 * （n=15 の実測でこの描画（`schedule-change-meeting-day` 13/15）が、由来等の
 * タグを保ったまま記録順だけ生ISOから並べ替え+凡例に変えた3候補中で最も高かった
 * ことが根拠。ADR 0309 を参照。他候補・数値はそちらに集約し、ここには複製しない）。
 *
 * ⚠ **`recall.memories` の元のスコア順は、この並べ替えで失われる**
 * （`sortMemoriesForDisplay` の doc を参照）。この関数の**出力文字列**からは
 * 元のスコア順を復元できない——スコア順が要る呼び出し側は `recall.memories` を
 * 直接見ること。
 */
export function buildMnemoraPrompt(recall: RecallResult): string {
  const order = recordedOrderById(recall.memories);
  const displayOrder = sortMemoriesForDisplay(recall.memories, order);
  const digestLines = displayOrder
    .map((m) => renderRecalledMemoryLine(m, recall.memories, order))
    .join("\n");
  const indexLine = `(索引: スコープ内 ${recall.index.totalInScope} 件のうち ${recall.memories.length} 件を提示)`;
  const legendLine = order.size > 0 ? ORDER_LEGEND_LINE : "";
  return [legendLine, digestLines, indexLine].filter((s) => s.length > 0).join("\n");
}

/**
 * `reportMemoryUsage` の戻り値。
 *
 * `reported: false` は「呼ばなかった」ことをそのまま返す——`observe()` を呼んで
 * 失敗したのではなく、載せる記憶が0件だったので**そもそも呼んでいない**
 * （`ObserveMemoryUsageInputSchema.usedMemoryIds` は `min(1)` であり、空配列を
 * 渡すと zod に弾かれる。呼び出し側はこの分岐を自分で持つ必要がある）。
 */
export type MemoryUsageReport =
  | { reported: true; recallId: RecallResult["recallId"]; usedMemoryIds: string[] }
  | { reported: false };

/**
 * `recall` が実際にプロンプトへ載せた Memory（＝ `buildMnemoraPrompt` が積んでいるのと
 * 同じ集合、`recall.memories`）を、使用報告として `observe({ kind: 'memory_usage' })` で
 * mnemora へ伝え返す（Issue #301、ADR 0009）。
 *
 * **これを呼ばないと `reinforce` が発火しない**（`runtime.observe` の
 * `handleMemoryUsage` → `recordUsage` → `insertedMemoryIds` ごとに `reinforce`。
 * `packages/core/src/runtime.ts`）——使われた記憶と使われなかった記憶が同じ速さで
 * 遠ざかっていた、というのが Issue #301 の欠落そのものである。
 *
 * **明示的な opt-in 関数である。**`tick()` や Scheduler には一切乗せていない
 * ——呼ばない呼び出し側でも `observe`/`recall` はそれまでどおり成立する
 * （ADR 0114 決定3・0115 決定7 と同じ規律。北極星の問い2「これを無効にしたとき、
 * Memory Framework として成立するか」に当てた結果は該当 ADR に書く）。
 *
 * **報告は、呼び出し側が `recall` の測定・表示を終えたあとに呼ぶことを想定している**
 * ——この関数自身は `recall` を撃たない（引数で受け取るだけ）ので、呼んでも
 * その `recall` の測定値（`usage`/`omitted`/`index` 等）は一切変わらない。
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
