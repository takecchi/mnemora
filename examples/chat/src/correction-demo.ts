import type {
  CorrectionCandidate,
  Ctx,
  FindCorrectionCandidatesResult,
  MemoryId,
  RecallResult,
  Runtime,
} from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { CorrectionScenario } from "./correction-scenario.js";
import { CORRECTION_SCENARIO } from "./correction-scenario.js";

/**
 * 訂正を含む会話シナリオを `Runtime` に対して実際に走らせるデモ（Issue #303 / Issue #369 (C)）。
 *
 * 北極星「目指す姿」の項目5「間違いを正すと、古いほうが先に出てこなくなる」を、
 * `markContested`（ADR 0134）→`recall`（両方隣接して出る）→`resolveContested`
 * （ADR 0150）→`recall`（敗者はもう出ない）の一巡で実演する。`packages/core`
 * `resolve-contested.test.ts` の「検出から解決までの一巡」と同じ形を、本物の
 * `Runtime`（`examples/chat` の Postgres 配線）に対して行う。
 *
 * **🔴 このデモは今日から `Runtime.findCorrectionCandidates`
 * （[ADR 0232](../../../docs/decisions/0232-correction-candidates-returned-not-chosen.md)）を
 * 本番コードの経路として実際に呼ぶ。** ADR 0232 は「本番コードから呼ぶ経路が無い」ことを
 * 「この ADR が着地させないもの」に明記していた——このファイルがその経路である
 * （[ADR 0235](../../../docs/decisions/0235-correction-demo-explicit-choice.md)）。
 *
 * **🔴🔴 ADR 0232 が測った危険（B群: 訂正してはいけない8件中、棄権率 0/8・深い誤爆 6/8。
 * 閾値は A 群と B 群を分離しない）は、依然としてそのまま存在する。** ⟹ このファイルは
 * **`findCorrectionCandidates` が返した候補を機械的に採らない**——候補は「提示」と
 * 「指名された相手が候補に居るかどうかの照合」にしか使わない。**訂正の相手は
 * 呼び出し側（このデモでは台本 `correction-scenario.ts` に記録済みの判断）が
 * `CorrectionChoice` として明示的に指名する。** `candidates[0]` を無条件に採る実装に
 * なっていないことは、`__tests__/correction-demo.test.ts` の「🔴🔴 採用者の指名が
 * 候補1位ではない」歯が保証する。
 *
 * **矛盾かどうか・どちらが勝つかの判定はこのファイルではなく `correction-scenario.ts` の
 * `contestedPair` が持つ**（ADR 0134 決定2 / ADR 0150 決定1）。**どの候補を訂正の相手として
 * 指名するかは呼び出し側が持つ**（このファイルは `CorrectionChoice` を受け取るだけで、
 * `turns` の並び順や `recordedAt` の大小・candidates の順位からは何も導かない）。
 *
 * **🔴 `markContested`/`resolveContested` には `opts.reason`（`buildCorrectionReason` が
 * 組む）を必ず渡す**——選んだ根拠（`discovery.recallId`・選んだ候補の `recallRank`・
 * 候補の件数・どちらへ倒したか）を `memory_events.meta.note` に残す（Issue #369
 * チェックボックス、[ADR 0238-correction-choice-rationale-in-events](../../../docs/decisions/0238-correction-choice-rationale-in-events.md)）。
 * `meta.note` に載る `recallId` が `RecallResult.explain`（`Runtime.getRecall` 経由）への
 * 橋になる——**記録そのものが、`candidates[0]` を機械的に採る実装への退行を後から
 * 検出できるようにする歯の一種**（同 ADR 参照）。
 *
 * **⚠ 北極星の主測定（`compare`/`retrieval`）には一切関わらない。**`compare.ts`/
 * `compare-json.ts`/`scenario.ts`/`probe-set.ts`/`naive-path.ts` のいずれも import しない
 * （`scope.ts`/`backfill.ts` と同じ規律）。
 *
 * **⚠ `recall()` は `limit: 1` を明示して呼ぶ（PR #320 の CI 失敗の修正、ADR 0162 決定5）。**
 * この会話には `original`/`correction` の2件しか Memory が無いため、既定の limit（10件）
 * では両方が独立に段2（再スコア）の `withinLimit` へ収まってしまい、段3「矛盾の解決と
 * 必須の同伴取得」（`docs/recall.md` §2 段3）の同伴取得（`retrievedVia: 'mandatory_companion'`）
 * が一度も発火しない——両方ともスコアだけで既に出るので、対向を「必ず連れてくる」機構が
 * 要らない状態になる。`limit: 1` にすると、段2で上位1件だけが `withinLimit` に残り、
 * その1件が `contested` なら対向（もう一方）が limit を超えて強制的に連れてこられる
 * （実測: `afterMark.memories.length` は limit=1 でも 2 になる）。これで Issue #197 の
 * 受け入れ条件「段3 が実際に発火することを測る歯が在る」を、`examples/chat` からも
 * 満たす。
 */

/**
 * 訂正の相手として、採用側が明示的に下した判断（Issue #369 (C)、ADR 0232 引き受けた負債1
 * への応答）。
 *
 * ⛔ **候補（`FindCorrectionCandidatesResult.candidates`）から導出したものではない。**
 * `runCorrectionDemo` はこの値を`候補一覧に居るかどうかの照合`にしか使わない——
 * どの候補が「相手」であるかを、この型自身が決める。
 *
 * 台本シナリオでは `scenario.contestedPair.firstExternalId` を渡す。**これは
 * 「機械が選んだ」のではなく「人が前もって選んで台本に書いた」判断である**——
 * `correction-scenario.ts` の `ContestedPairDeclaration` の doc コメントが述べる
 * 「呼び出し側が既に決めていることを前提にする」（ADR 0134 決定2）という前提を、
 * この型でも同じ強さで保つ。実運用では、UI 上で人が候補一覧を見て選んだ結果が
 * ここに入る想定。
 */
export interface CorrectionChoice {
  /** 訂正される相手の `externalId`（`scenario.original.externalId` 等）。 */
  chosenExternalId: string;
}

/**
 * `runCorrectionDemo` の結果に載る「選択の段」の結末。
 *
 * - `"resolved"` — 指名された相手が候補に居て、`markContested` → `resolveContested`
 *   まで実際に進んだ。
 * - `"awaiting_choice"` — `choice` が渡されなかった。**候補は提示したが、
 *   書き込みは1件もしていない。** ⟹ ADR 0232 が測った B群の危険（棄権率 0/8）を
 *   可視化する経路そのもの——mnemora は候補を出す。だが選ぶのは人であり、
 *   人が選ばなければ何も起きない。
 * - `"choice_not_in_candidates"` — `choice` は渡されたが、指名された相手が
 *   `findCorrectionCandidates` の候補一覧に居なかった。**書き込みは1件もしていない。**
 */
export type CorrectionOutcomeKind = "resolved" | "awaiting_choice" | "choice_not_in_candidates";

export interface CorrectionDemoResult {
  scenario: CorrectionScenario;
  originalId: MemoryId;
  correctionId: MemoryId;
  /**
   * 【発見の段】`runtime.findCorrectionCandidates(ctx, { text: scenario.correction.text,
   * excludeMemoryIds: [correctionId] })` の結果そのまま。⛔ **この段は書き込まない・
   * LLM を呼ばない**（`findCorrectionCandidates` 自身の契約、ADR 0232）。
   */
  discovery: FindCorrectionCandidatesResult;
  /** 選択の段の結末。上の {@link CorrectionOutcomeKind} 参照。 */
  outcome: CorrectionOutcomeKind;
  /** 指名された相手の memoryId。`choice` が渡されなかった場合は `null`。 */
  chosenId: MemoryId | null;
  /**
   * 指名された相手が `discovery.candidates` の何位（`recallRank`）だったか。
   * **見つからない・未指名なら `null`。** 北極星の問い3「なぜそれを選んだのかを、
   * 後から説明できるか」——「人が選んだものが recall の何位だったか」をここで
   * 説明できるようにする。
   */
  chosenRecallRank: number | null;
  /** markContested 前の recall。`outcome !== "resolved"` のときは `null`（書き込みに進んでいない）。 */
  beforeMark: RecallResult | null;
  /** markContested の結果。`outcome !== "resolved"` のときは `null`。 */
  markOutcomeKind: string | null;
  /** markContested 後の recall（両方が隣接して出るはず）。`outcome !== "resolved"` のときは `null`。 */
  afterMark: RecallResult | null;
  /** resolveContested の結果。`outcome !== "resolved"` のときは `null`。 */
  resolveOutcomeKind: string | null;
  /** resolveContested 後の recall（敗者はもう出ないはず）。`outcome !== "resolved"` のときは `null`。 */
  afterResolve: RecallResult | null;
}

function findByMemoryId(
  memories: RecallResult["memories"],
  id: MemoryId,
): RecallResult["memories"][number] | undefined {
  return memories.find((m) => m.memoryId === id);
}

/**
 * 【選択の段】が使う、externalId → MemoryId の対応。`observe()` の戻り値からのみ得る
 * ——`correction-scenario.ts` は名前しか持たない。
 */
function buildExternalIdIndex(
  scenario: CorrectionScenario,
  originalId: MemoryId,
  correctionId: MemoryId,
): Record<string, MemoryId> {
  return {
    [scenario.original.externalId]: originalId,
    [scenario.correction.externalId]: correctionId,
  };
}

/**
 * この3回の `recall()` が共通して使うクエリ。**`limit: 1` を明示する**——理由は
 * このファイル冒頭の doc コメント参照（段3の必須同伴取得を実際に発火させるため、
 * ADR 0162 決定5）。同じクエリを使い回すことで、「訂正の前後で答えがどう変わるか」を
 * 同じ条件で比較できる。
 */
function buildRecallQuery(scenario: CorrectionScenario): { text: string; limit: number } {
  return { text: scenario.query, limit: 1 };
}

/**
 * `markContested`/`resolveContested` の `opts.reason` へ渡す文字列を組み立てる
 * （Issue #369 チェックボックス「選んだ根拠（スコア・順位・候補の数・どちらへ倒したか）を
 * `memory_events.meta.note` と `RecallResult.explain` の両方から辿れるようにする」）。
 *
 * **機械で読み返せる `key=value` の並びにしつつ、人にも読める形にする**（形式は自由文字列
 * ——値は decisions ADR 参照)。`recallId` が
 * `RecallResult.explain` 側への橋になる: この文字列から `recallId=...` を取り出し
 * `Runtime.getRecall(ctx, recallId)` に渡せば、その recall の `explain.stages` を
 * 後から引ける（`FindCorrectionCandidatesResult.recallId` の doc コメント / `getRecall`
 * の doc コメント参照）。
 *
 * ⚠ **`score.total` は載せない。** ADR 0232 が実測した通り、スコアの閾値は
 * A群（訂正すべき）と B群（訂正してはいけない）を分離しない——スコアは「なぜこの候補を
 * 選んだか」の理由になっていない。この記録に生スコアを載せると、後から読む側に
 * 「スコアが高かったから選んだ」という誤った説明を与えてしまう。載せるのは、この経路が
 * 実際に守っている契約（候補[0]を機械的に採らない）を後から検証できる最小の情報
 * ——候補の件数・選んだ候補の順位・どちらへ倒したか・recall への橋——だけである。
 */
function buildCorrectionReason(
  discovery: FindCorrectionCandidatesResult,
  chosenRecallRank: number,
  winnerSide: "original" | "correction",
): string {
  return (
    `chosenRecallRank=${chosenRecallRank} / candidates=${discovery.candidates.length} / ` +
    `recallId=${discovery.recallId} / winner=${winnerSide}`
  );
}

/** `outcome !== "resolved"` のときの、書き込み段を持たない結果を組み立てる共通部分。 */
function buildStoppedResult(
  scenario: CorrectionScenario,
  originalId: MemoryId,
  correctionId: MemoryId,
  discovery: FindCorrectionCandidatesResult,
  outcome: "awaiting_choice" | "choice_not_in_candidates",
  chosenId: MemoryId | null,
): CorrectionDemoResult {
  return {
    scenario,
    originalId,
    correctionId,
    discovery,
    outcome,
    chosenId,
    chosenRecallRank: null,
    beforeMark: null,
    markOutcomeKind: null,
    afterMark: null,
    resolveOutcomeKind: null,
    afterResolve: null,
  };
}

/**
 * シナリオを `Runtime` に対して端から端まで走らせる。
 *
 * 1. `original`/`correction` を `observe()` する（別々の Memory になる）。
 * 2. `tick()` を干上がるまで回して埋め込みを済ませる。
 * 3. 【発見の段】`findCorrectionCandidates(ctx, { text: scenario.correction.text,
 *    excludeMemoryIds: [correctionId] })` を呼ぶ。訂正の発話そのものを自己除外する。
 *    ⛔ 書き込まない・LLM を呼ばない（`findCorrectionCandidates` の契約）。
 * 4. 【選択の段】`choice` が無ければ、候補を提示するだけで
 *    `outcome: "awaiting_choice"` を返して止まる（書き込み0件）。`choice` が在れば、
 *    指名された相手が候補一覧に居るかを確かめる——**居なければ書き込まずに
 *    `outcome: "choice_not_in_candidates"` を返して止まる。**居れば、その
 *    `recallRank` を結果に持たせて次へ進む。
 * 5. 訂正前の `recall()`（対向の宣言をまだ `markContested` していない状態。`limit: 1`
 *    なのでこの時点では1件しか返らない）。
 * 6. `markContested(chosenId, correctionId)`（`chosenId` は選択の段で確かめた指名）。
 * 7. 訂正を対にした直後の `recall()`（`limit: 1` でも両方が隣接して出るはず——
 *    mandatory companion retrieval が limit を超えて対向を連れてくる、ADR 0134/0162）。
 * 8. `resolveContested({ kind: 'supersede', winnerId })`（`winnerId` は
 *    `scenario.contestedPair.winnerExternalId` の宣言——ADR 0150 決定1。**選択の段が
 *    決めるのは「誰が相手か」だけであり、「どちらが勝つか」は従来どおり台本の宣言**）。
 * 9. 解決後の `recall()`（負けた側は `superseded` になり、`limit` に関わらずもう出ない）。
 */
export async function runCorrectionDemo(
  runtime: Runtime,
  ctx: Ctx,
  scenario: CorrectionScenario = CORRECTION_SCENARIO,
  choice?: CorrectionChoice,
): Promise<CorrectionDemoResult> {
  const originalObserved = await runtime.observe(ctx, {
    kind: "utterance",
    text: scenario.original.text,
    speaker: "user",
    externalId: scenario.original.externalId,
  });
  const correctionObserved = await runtime.observe(ctx, {
    kind: "utterance",
    text: scenario.correction.text,
    speaker: "user",
    externalId: scenario.correction.externalId,
  });
  await drainEmbedTicks(runtime, ctx);

  const originalId = originalObserved.memoryIds[0];
  const correctionId = correctionObserved.memoryIds[0];
  if (originalId === undefined || correctionId === undefined) {
    throw new Error(
      "runCorrectionDemo: observe() が Memory を作らなかった（抽出設定を確認すること）。",
    );
  }

  // 【発見の段】必ず1回だけ呼ぶ。書き込まない・LLM を呼ばない（findCorrectionCandidates
  // 自身の契約、ADR 0232）。⚠ choice の有無に関わらずここまでは常に進む——「選ばなければ
  // 候補も出さない」ではなく「候補は出すが、選ばなければ何も起きない」ことを見せるため。
  const discovery = await runtime.findCorrectionCandidates(ctx, {
    text: scenario.correction.text,
    excludeMemoryIds: [correctionId],
  });

  const byExternalId = buildExternalIdIndex(scenario, originalId, correctionId);

  // 【選択の段】choice が無ければ、候補を提示するだけで止まる。
  // ⟹ ADR 0232 の B群（棄権率 0/8）が可視化する危険そのもの——候補は必ず返る。
  // 止めるのはこのデモの側であって、mnemora 側の棄権ではない。
  if (choice === undefined) {
    return buildStoppedResult(
      scenario,
      originalId,
      correctionId,
      discovery,
      "awaiting_choice",
      null,
    );
  }

  const chosenId = byExternalId[choice.chosenExternalId];
  if (chosenId === undefined) {
    throw new Error(
      "runCorrectionDemo: choice.chosenExternalId が scenario.original/correction の " +
        "externalId と対応していない（呼び出し側のバグ）。",
    );
  }

  // 🔴 ここが「候補から相手を導出しない」ことの核心: chosenId は choice（呼び出し側の
  // 指名）から得た値であり、discovery.candidates の並びからは一切導いていない。
  // 候補一覧はここで「chosenId が居るかどうかの照合」にしか使わない。
  const chosenCandidate: CorrectionCandidate | undefined = discovery.candidates.find(
    (c) => c.memoryId === chosenId,
  );
  if (chosenCandidate === undefined) {
    // 🔴 居なければ書き込まずに止める。
    return buildStoppedResult(
      scenario,
      originalId,
      correctionId,
      discovery,
      "choice_not_in_candidates",
      chosenId,
    );
  }

  const winnerId = byExternalId[scenario.contestedPair.winnerExternalId];
  if (winnerId === undefined) {
    throw new Error(
      "runCorrectionDemo: scenario.contestedPair.winnerExternalId が scenario.original/" +
        "correction の externalId と対応していない（シナリオの定義バグ）。",
    );
  }

  // 🔴 Issue #369 チェックボックス: 選んだ根拠(recallId・順位・候補の数・どちらへ倒したか)を
  // memory_events.meta.note から辿れるようにする。markContested/resolveContested の
  // 両方に同じ reason を渡す(片方だけにしない)。
  const winnerSide: "original" | "correction" =
    winnerId === correctionId ? "correction" : "original";
  const correctionReason = buildCorrectionReason(discovery, chosenCandidate.recallRank, winnerSide);

  const recallQuery = buildRecallQuery(scenario);
  const beforeMark = await runtime.recall(ctx, recallQuery);

  const markResult = await runtime.markContested(ctx, chosenId, correctionId, {
    reason: correctionReason,
  });

  const afterMark = await runtime.recall(ctx, recallQuery);

  const resolveResult = await runtime.resolveContested(
    ctx,
    chosenId,
    correctionId,
    {
      kind: "supersede",
      winnerId,
    },
    { reason: correctionReason },
  );

  const afterResolve = await runtime.recall(ctx, recallQuery);

  return {
    scenario,
    originalId,
    correctionId,
    discovery,
    outcome: "resolved",
    chosenId,
    chosenRecallRank: chosenCandidate.recallRank,
    beforeMark,
    markOutcomeKind: markResult.outcome.kind,
    afterMark,
    resolveOutcomeKind: resolveResult.outcome.kind,
    afterResolve,
  };
}

export interface CorrectionDemoCheck {
  /** markContested が実際に "contested" を返したか。 */
  markSucceeded: boolean;
  /** resolveContested が実際に "resolved" を返したか。 */
  resolveSucceeded: boolean;
  /** markContested 後の recall で、両方が同時に出たか。 */
  afterMarkBothPresent: boolean;
  /**
   * markContested 後の recall で、`original`/`correction` の**どちらか片方**の
   * retrievedVia が mandatory_companion か。
   *
   * ⚠ **どちらが mandatory_companion になるかはスコアのランキング次第であり、
   * `resolveContested` の勝者（`scenario.contestedPair.winnerExternalId`）とは無関係**
   * （ADR 0162 決定5）——段2（再スコア）で `limit` 内に自然に残ったほうが「アンカー」、
   * 残らなかったほうが「同伴（mandatory_companion）」として強制的に連れてこられる。
   * このスコア順は実行のたびに変わりうる想定はしていない（決定的な provider・固定の
   * テキストなので同じ実行環境では安定するはずだが、**どちらが勝つかを前提にした
   * 検査にしない**——`afterMarkCompanionOfOther` も参照）。
   */
  afterMarkCompanionRetrieval: boolean;
  /**
   * markContested 後の recall で、mandatory_companion 側の companionOf が、
   * もう片方（アンカー側）の memoryId を指しているか。**`original`/`correction` の
   * どちらがアンカーでどちらが同伴かは決め打たない**（上の `afterMarkCompanionRetrieval`
   * の注記参照）——対がちゃんと相互に指し合っているかだけを見る。
   */
  afterMarkCompanionOfOther: boolean;
  /**
   * 北極星 項目5 の核心: resolveContested 後、**古いほう（original）が recall から
   * 消えたか**。
   */
  afterResolveOriginalAbsent: boolean;
  /** resolveContested 後も、新しいほう（correction）は残っているか。 */
  afterResolveCorrectionPresent: boolean;
}

/**
 * `checkCorrectionDemo()` とは別に持つ、`omitted`（`docs/recall.md` §2「無い」の分類）
 * 側からの検査（Issue #374）。
 *
 * `CorrectionDemoCheck.afterResolveOriginalAbsent` は「`recall().memories` に居ない」
 * ことしか見ない——それだけでは、消えた理由が**machine の都合で棚上げされた
 * （superseded）**のか、**そもそも最初から無かった**のかを区別できない。北極星
 * 「目指す姿」項目6「知らないことを、知らないと言える」——「見つからなかった」と
 * 「探していない」を同じ顔で返さない——の適用として、`omitted` 側に実際に
 * `{ kind: "filtered", condition: "superseded" }` が記録されていることまで見て
 * 初めて、この2つが区別できる。
 */
export interface CorrectionOmissionCheck {
  /**
   * resolveContested 後の recall で、負けた側（original）の不在が、
   * `omitted` に `condition: "superseded"` として実際に記録されているか。
   */
  afterResolveOriginalOmittedAsSuperseded: boolean;
}

/**
 * `result.afterResolve.omitted` を見て、`CorrectionOmissionCheck` を組み立てる
 * （印字・歯の両方が使う。`checkCorrectionDemo` と同じ規律）。
 *
 * ⚠ **`count` は「original 1件」を名指ししない**——`aggregateScope` の
 * `filteredSuperseded` はスコープ（このデモが使うテナント）内の superseded 件数を
 * 集約するので、このデモの会話（original/correction の2件だけ）では実質的に
 * 1件を指すが、型としては件数の下限（`count > 0`）だけを見る。
 *
 * ⚠ **`outcome !== "resolved"` の結果に対して呼ぶと例外になる**——書き込みに
 * 進んでいない結果には「消えた」も「残った」も無い（`checkCorrectionDemo` と同じ規律）。
 */
export function checkCorrectionOmission(result: CorrectionDemoResult): CorrectionOmissionCheck {
  if (result.afterResolve === null) {
    throw new Error(
      `checkCorrectionOmission: outcome="${result.outcome}" の結果には適用できない` +
        "（書き込みに進んでいないため afterResolve が無い）。",
    );
  }
  return {
    afterResolveOriginalOmittedAsSuperseded: result.afterResolve.omitted.some(
      (o) => o.kind === "filtered" && o.condition === "superseded" && o.count > 0,
    ),
  };
}

/**
 * `CorrectionDemoResult` から、見せたい性質を機械的に判定する（印字・歯の両方が使う）。
 *
 * ⚠ **`outcome !== "resolved"` の結果に対して呼ぶと例外になる。**選択の段が止まった
 * 結果（`awaiting_choice`/`choice_not_in_candidates`）には `markContested`/
 * `resolveContested` の一巡そのものが無いため、この検査は成立しない——
 * 呼び出し側は先に `result.outcome === "resolved"` を確かめること。
 */
export function checkCorrectionDemo(result: CorrectionDemoResult): CorrectionDemoCheck {
  if (
    result.outcome !== "resolved" ||
    result.afterMark === null ||
    result.afterResolve === null ||
    result.markOutcomeKind === null ||
    result.resolveOutcomeKind === null
  ) {
    throw new Error(
      `checkCorrectionDemo: outcome="${result.outcome}" の結果には適用できない` +
        "（書き込みに進んでいないため markContested/resolveContested の一巡が無い）。",
    );
  }

  const afterMark = result.afterMark;
  const afterResolve = result.afterResolve;

  const afterMarkOriginal = findByMemoryId(afterMark.memories, result.originalId);
  const afterMarkCorrection = findByMemoryId(afterMark.memories, result.correctionId);

  // 🔑 どちらが mandatory_companion になるかを決め打たない（上の doc コメント参照）。
  // 「ちょうど片方が mandatory_companion で、その companionOf がもう片方を指す」ことだけを
  // 見る——ランキングの勝敗にも resolveContested の勝敗にも依存しない検査にする。
  const companion =
    afterMarkOriginal?.retrievedVia === "mandatory_companion"
      ? afterMarkOriginal
      : afterMarkCorrection?.retrievedVia === "mandatory_companion"
        ? afterMarkCorrection
        : undefined;
  const anchor =
    companion === undefined
      ? undefined
      : companion === afterMarkOriginal
        ? afterMarkCorrection
        : afterMarkOriginal;

  return {
    markSucceeded: result.markOutcomeKind === "contested",
    resolveSucceeded: result.resolveOutcomeKind === "resolved",
    afterMarkBothPresent: afterMarkOriginal !== undefined && afterMarkCorrection !== undefined,
    afterMarkCompanionRetrieval: companion !== undefined,
    afterMarkCompanionOfOther:
      companion !== undefined && anchor !== undefined && companion.companionOf === anchor.memoryId,
    afterResolveOriginalAbsent:
      findByMemoryId(afterResolve.memories, result.originalId) === undefined,
    afterResolveCorrectionPresent:
      findByMemoryId(afterResolve.memories, result.correctionId) !== undefined,
  };
}

/** 発見の段の候補一覧を、人に見せる形で印字する。 */
function formatCandidates(discovery: FindCorrectionCandidatesResult): string {
  if (discovery.candidates.length === 0) {
    return "  (候補0件)";
  }
  return discovery.candidates
    .map(
      (c) =>
        `  - #${c.recallRank}位 "${c.digest}" (memoryId=${c.memoryId}, score.total=${c.score.total.toFixed(5)})`,
    )
    .join("\n");
}

function formatMemoryList(memories: RecallResult["memories"]): string {
  if (memories.length === 0) {
    return "  (0件)";
  }
  return memories
    .map(
      (m) =>
        `  - "${m.digest}" (retrievedVia=${m.retrievedVia}${m.companionOf ? `, companionOf=${m.companionOf}` : ""})`,
    )
    .join("\n");
}

/** 画面向けの印字。訂正の前後で `recall()` の答えがどう変わるかを並べて見せる。 */
export function formatCorrectionDemo(result: CorrectionDemoResult): string {
  const lines: string[] = [];

  lines.push(`元の発話: "${result.scenario.original.text}" (memoryId=${result.originalId})`);
  lines.push(`訂正の発話: "${result.scenario.correction.text}" (memoryId=${result.correctionId})`);
  lines.push("");

  lines.push(
    "--- 0. 発見の段: findCorrectionCandidates(text: 訂正の発話, excludeMemoryIds: [訂正自身]) " +
      "⟹ ⛔ 書き込まない・LLM を呼ばない(ADR 0232) ---",
  );
  lines.push(`outcome=${result.discovery.outcome} / 候補${result.discovery.candidates.length}件`);
  lines.push(formatCandidates(result.discovery));
  lines.push(
    `omitted: ${result.discovery.omitted.length === 0 ? "(無し)" : result.discovery.omitted.map((o) => ("condition" in o ? `${o.kind}:${o.condition}` : o.kind)).join(", ")}`,
  );
  lines.push(
    "⟹ 🔴 この候補一覧は棄権しない(ADR 0232 実測: B群8件中0件が棄権)。" +
      "mnemora は候補を出す。だが選ぶのは人であり、人が選ばなければ何も起きない。",
  );
  lines.push("");

  if (result.outcome !== "resolved") {
    lines.push(
      result.outcome === "awaiting_choice"
        ? "--- 選択の段: choice が渡されなかった ⟹ 🔴 書き込み0件で停止 ---"
        : `--- 選択の段: 指名(memoryId=${result.chosenId}) が候補一覧に居なかった ⟹ 🔴 書き込み0件で停止 ---`,
    );
    lines.push(
      "⟹ markContested/resolveContested のどちらも呼ばれていない。" +
        "候補[0]を機械的に採る実装ではないことは、この停止経路そのものが示す。",
    );
    return lines.join("\n");
  }

  lines.push(
    `--- 選択の段: 指名(memoryId=${result.chosenId}) が候補の #${result.chosenRecallRank}位として` +
      "見つかった ⟹ 続行 ---",
  );
  lines.push("");

  lines.push(`問い合わせ: recall({ text: "${result.scenario.query}", limit: 1 })`);
  lines.push("");

  lines.push("--- 1. markContested 前（まだ対向として宣言していない） ---");
  lines.push(`件数: ${result.beforeMark!.memories.length}`);
  lines.push(formatMemoryList(result.beforeMark!.memories));
  lines.push("");

  const check = checkCorrectionDemo(result);
  const omissionCheck = checkCorrectionOmission(result);

  lines.push(`--- 2. markContested(指名, 訂正) ⟹ outcome=${result.markOutcomeKind} ---`);
  lines.push(`件数: ${result.afterMark!.memories.length}`);
  lines.push(formatMemoryList(result.afterMark!.memories));
  lines.push(
    `⟹ 両方出た: ${check.afterMarkBothPresent ? "はい" : "いいえ"} / ` +
      `mandatory_companion として出た: ${check.afterMarkCompanionRetrieval ? "はい" : "いいえ"}`,
  );
  lines.push("");

  lines.push(
    `--- 3. resolveContested(supersede, winner=correction) ⟹ outcome=${result.resolveOutcomeKind} ---`,
  );
  lines.push(`件数: ${result.afterResolve!.memories.length}`);
  lines.push(formatMemoryList(result.afterResolve!.memories));
  lines.push(
    `⟹ 古いほうが消えた: ${check.afterResolveOriginalAbsent ? "はい" : "いいえ"} / ` +
      `新しいほうは残った: ${check.afterResolveCorrectionPresent ? "はい" : "いいえ"}`,
  );
  lines.push(
    `⟹ omitted に "superseded" として記録された(=最初から無かったのではなく消えた): ` +
      `${omissionCheck.afterResolveOriginalOmittedAsSuperseded ? "はい" : "いいえ"}`,
  );
  lines.push("");
  lines.push(
    "⟹ 北極星「間違いを正すと、古いほうが先に出てこなくなる」(項目5)を、" +
      "findCorrectionCandidates(発見) → 指名の照合(選択) → markContested → recall（両方隣接）→ " +
      "resolveContested → recall（敗者は消える）の一巡で実演した。「見つからなかった」と" +
      '「探していない」を同じ顔で返さない(項目6)ことも、omitted の condition="superseded" が' +
      "確かめている。",
  );

  return lines.join("\n");
}
