import type {
  CorrectionCandidate,
  Ctx,
  FindCorrectionCandidatesResult,
  MemoryId,
  RecallResult,
  Runtime,
} from "@mnemora/core";
import { buildCorrectionReason } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";
import type { CorrectionScenario } from "./correction-scenario.js";
import { CORRECTION_SCENARIO } from "./correction-scenario.js";
import { scoreTotalOrNull } from "./recalled-score.js";

/**
 * 訂正を含む会話シナリオを `Runtime` に対して実際に走らせるデモ。
 * `markContested` → `recall`（両方が隣接して出る）→ `resolveContested` → `recall`（敗者はもう出ない）の一巡を実演する。
 *
 * 「選択」の段（`applyCorrection`/`buildCorrectionReason`）は `packages/core` の公開口で、このファイルは呼ぶだけで実装を二重に持たない。
 *
 * `findCorrectionCandidates` が返した候補を機械的に採らない。ADR 0232 が測った危険（B群で棄権率 0/8・深い誤爆 6/8、
 * 閾値は A 群と B 群を分離しない）が残っているため。候補は提示と、指名された相手が居るかの照合にしか使わない。
 * 訂正の相手は呼び出し側が `CorrectionChoice` として明示的に指名する（台本 `correction-scenario.ts` に記録済みの判断）。
 * `candidates[0]` を採る実装への退行は、`__tests__/correction-demo.test.ts` の「採用者の指名が候補1位ではない」歯が防ぐ。
 *
 * 矛盾かどうか・どちらが勝つかは `correction-scenario.ts` の `contestedPair` が持つ。`turns` の並び順・`recordedAt` の大小・
 * candidates の順位からは何も導かない。
 *
 * `applyCorrection` には `reason` を必ず渡し、選んだ根拠を `memory_events.meta.note` に残す（ADR 0238）。
 * `candidates[0]` を機械的に採る実装への退行を、後から検出できるようにするため。
 *
 * `applyCorrection` は2回呼ぶ（ADR 0242 が許した使い方）。1回目は `resolution` を渡さず対（mandatory companion）を見せ、
 * 2回目に `resolution` を渡して解決まで進める。2回目の内部の `markContested` は対象が既に `contested` なので書き込みは起きない。
 * 両方に同じ `reason` を渡す。
 *
 * 北極星の主測定（`compare`/`retrieval`）には関わらない。`compare.ts`/`compare-json.ts`/`scenario.ts`/`probe-set.ts`/`naive-path.ts` を import しない。
 *
 * `recall()` は `limit: 1` を明示して呼ぶ（ADR 0162 決定5）。会話の Memory が2件だけだと、既定の limit では両方が段2で
 * `withinLimit` に収まり、段3の同伴取得が一度も発火しない。`limit: 1` なら、残った1件が `contested` のとき対向が強制的に連れてこられる。
 */

/**
 * 訂正の相手として、採用側が明示的に下した判断。
 *
 * 候補（`FindCorrectionCandidatesResult.candidates`）から導出したものではない。`runCorrectionDemo` はこの値を
 * 候補一覧に居るかの照合にしか使わない。台本では `scenario.contestedPair.firstExternalId` を渡す。
 * 機械が選んだのではなく、人が前もって選んで台本に書いた判断（ADR 0134 決定2）。
 */
export interface CorrectionChoice {
  chosenExternalId: string;
}

/**
 * `runCorrectionDemo` の結果に載る「選択の段」の結末。
 *
 * - `"resolved"`: 指名された相手が候補に居て、`resolveContested` まで進んだ。
 * - `"awaiting_choice"`: `choice` が渡されなかった。候補は提示したが書き込みは1件もしていない。
 *   mnemora は候補を出すが選ぶのは人で、人が選ばなければ何も起きない。
 * - `"choice_not_in_candidates"`: 指名された相手が候補一覧に居なかった。書き込みは1件もしていない。
 */
export type CorrectionOutcomeKind = "resolved" | "awaiting_choice" | "choice_not_in_candidates";

export interface CorrectionDemoResult {
  scenario: CorrectionScenario;
  originalId: MemoryId;
  correctionId: MemoryId;
  /** 【発見の段】`findCorrectionCandidates` の結果そのまま。この段は書き込まず、LLM を呼ばない（ADR 0232）。 */
  discovery: FindCorrectionCandidatesResult;
  outcome: CorrectionOutcomeKind;
  chosenId: MemoryId | null;
  /** 指名された相手が `discovery.candidates` の何位（`recallRank`）だったか。見つからない・未指名なら `null`。 */
  chosenRecallRank: number | null;
  beforeMark: RecallResult | null;
  markOutcomeKind: string | null;
  afterMark: RecallResult | null;
  resolveOutcomeKind: string | null;
  afterResolve: RecallResult | null;
}

function findByMemoryId(
  memories: RecallResult["memories"],
  id: MemoryId,
): RecallResult["memories"][number] | undefined {
  return memories.find((m) => m.memoryId === id);
}

/** 【選択の段】が使う、externalId → MemoryId の対応。`observe()` の戻り値からのみ得る。シナリオは名前しか持たない。 */
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
 * この3回の `recall()` が共通して使うクエリ。`limit: 1` を明示する理由は冒頭の doc を参照。
 * 同じクエリを使い回して、訂正の前後を同じ条件で比べる。
 */
function buildRecallQuery(scenario: CorrectionScenario): { text: string; limit: number } {
  return { text: scenario.query, limit: 1 };
}

// `winner` の語彙は ADR 0242 が `Runtime` レベルの汎用語彙（`corrected`/`correcting`）へ変えている。
// このシナリオでは訂正する側が常に勝つので `winner=correcting`。

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
 * 【選択の段】`choice` が無ければ候補を提示するだけで止まる（書き込み0件）。指名された相手が候補一覧に居なければ、
 * 書き込まずに `choice_not_in_candidates` で止まる。
 * 選択の段が決めるのは「誰が相手か」だけで、「どちらが勝つか」は台本の宣言（ADR 0150 決定1）。
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
  await drainEmbedTicks(runtime, ctx, {
    expectedProcessed: originalObserved.memoryIds.length + correctionObserved.memoryIds.length,
  });

  const originalId = originalObserved.memoryIds[0];
  const correctionId = correctionObserved.memoryIds[0];
  if (originalId === undefined || correctionId === undefined) {
    throw new Error(
      "runCorrectionDemo: observe() が Memory を作らなかった（抽出設定を確認すること）。",
    );
  }

  // 【発見の段】choice の有無に関わらず、ここまでは常に進む。「選ばなければ候補も出さない」ではなく、
  // 「候補は出すが、選ばなければ何も起きない」ことを見せるため。
  const discovery = await runtime.findCorrectionCandidates(ctx, {
    text: scenario.correction.text,
    excludeMemoryIds: [correctionId],
  });

  const byExternalId = buildExternalIdIndex(scenario, originalId, correctionId);

  // 【選択の段】choice が無ければ止まる。止めるのはこのデモの側であって、mnemora 側の棄権ではない。
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

  // 核心: chosenId は choice（呼び出し側の指名）から得た値で、discovery.candidates の並びからは導かない。
  // 候補一覧は chosenId が居るかの照合にしか使わない。
  const chosenCandidate: CorrectionCandidate | undefined = discovery.candidates.find(
    (c) => c.memoryId === chosenId,
  );
  if (chosenCandidate === undefined) {
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

  // 選んだ根拠を `memory_events.meta.note` から辿れるようにする（ADR 0238）。勝者を先に知っているので、
  // 1回目の `applyCorrection` から同じ reason を組み立てて両方に渡す。
  const resolution = { kind: "supersede" as const, winnerId };
  const correctionReason = buildCorrectionReason({
    discovery,
    chosenRecallRank: chosenCandidate.recallRank,
    correctedId: chosenId,
    correctingId: correctionId,
    resolution,
  });

  const recallQuery = buildRecallQuery(scenario);
  const beforeMark = await runtime.recall(ctx, recallQuery);

  const marked = await runtime.applyCorrection(ctx, {
    discovery,
    correctedId: chosenId,
    correctingId: correctionId,
    reason: correctionReason,
  });
  // chosenId が候補に居ることは上で確かめ済み。`applyCorrection` が "awaiting_choice"/"not_a_candidate" を返すことは無い（到達しないはずの防御）。
  if (marked.kind !== "contested" && marked.kind !== "resolved") {
    throw new Error(
      `runCorrectionDemo: 到達しないはずの applyCorrection outcome (kind=${marked.kind})`,
    );
  }

  const afterMark = await runtime.recall(ctx, recallQuery);

  // 【書き込み: 2回目】`markContested` はもう一度呼ばれるが、対象は既に contested なので書き込みは起きない。
  const resolved = await runtime.applyCorrection(ctx, {
    discovery,
    correctedId: chosenId,
    correctingId: correctionId,
    resolution,
    reason: correctionReason,
  });
  if (resolved.kind !== "resolved") {
    throw new Error(
      `runCorrectionDemo: 到達しないはずの applyCorrection outcome (kind=${resolved.kind})`,
    );
  }

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
    markOutcomeKind: marked.markResult.outcome.kind,
    afterMark,
    resolveOutcomeKind: resolved.resolveResult.outcome.kind,
    afterResolve,
  };
}

export interface CorrectionDemoCheck {
  markSucceeded: boolean;
  resolveSucceeded: boolean;
  afterMarkBothPresent: boolean;
  /**
   * markContested 後の recall で、`original`/`correction` のどちらか片方の retrievedVia が mandatory_companion か。
   *
   * どちらが mandatory_companion になるかはスコアのランキング次第で、`resolveContested` の勝者とは無関係（ADR 0162 決定5）。
   * どちらが勝つかを前提にした検査にしない。
   */
  afterMarkCompanionRetrieval: boolean;
  /**
   * mandatory_companion 側の companionOf が、もう片方（アンカー側）の memoryId を指しているか。
   * どちらがアンカーかは決め打たず、対が相互に指し合っているかだけを見る。
   */
  afterMarkCompanionOfOther: boolean;
  afterResolveOriginalAbsent: boolean;
  afterResolveCorrectionPresent: boolean;
}

/**
 * `omitted` 側からの検査。`afterResolveOriginalAbsent` は「`recall().memories` に居ない」ことしか見ず、
 * 棚上げされた（superseded）のか最初から無かったのかを区別できない。
 * 「見つからなかった」と「探していない」を同じ顔で返さないため、`{ kind: "filtered", condition: "superseded" }` が記録されていることまで見る。
 */
export interface CorrectionOmissionCheck {
  afterResolveOriginalOmittedAsSuperseded: boolean;
}

/**
 * `result.afterResolve.omitted` を見て、`CorrectionOmissionCheck` を組み立てる。
 *
 * `count` は「original 1件」を名指ししない。`aggregateScope` の `filteredSuperseded` はテナント内の superseded 件数の集約なので、
 * 件数の下限（`count > 0`）だけを見る。
 * `outcome !== "resolved"` の結果に対して呼ぶと例外になる。書き込みに進んでいない結果には「消えた」も「残った」も無い。
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
 * `CorrectionDemoResult` から、見せたい性質を機械的に判定する。
 *
 * `outcome !== "resolved"` の結果に対して呼ぶと例外になる。選択の段が止まった結果には一巡そのものが無く、
 * この検査は成立しない。呼び出し側は先に `result.outcome === "resolved"` を確かめること。
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

  // どちらが mandatory_companion になるかを決め打たない。ランキングの勝敗にも `resolveContested` の勝敗にも依存しない検査にする。
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

function formatCandidates(discovery: FindCorrectionCandidatesResult): string {
  if (discovery.candidates.length === 0) {
    return "  (候補0件)";
  }
  return discovery.candidates
    .map((c) => {
      // `findCorrectionCandidates` は association の既定（on）をそのまま使うので、`affinityMeasured: false` の候補が混ざりうる。
      // total が無い候補は「n/a」と表示する。
      const total = scoreTotalOrNull(c.score);
      const totalText = total === null ? "n/a" : total.toFixed(5);
      return `  - #${c.recallRank}位 "${c.digest}" (memoryId=${c.memoryId}, score.total=${totalText})`;
    })
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
