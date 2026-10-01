import type { MemoryId } from "../ids.js";
import type { Memory } from "../memory.js";
import { MemorySchema } from "../memory.js";
import type { Runtime } from "../runtime.js";

/**
 * `Runtime` の `recall()` 以外のメソッド（16本）の戻り値が、TSDoc（8巡目の棚卸し）が
 * 約束している形を守っているかを確かめ、破れていた点を文字列で返す（空なら守っている）。
 * `./runtime-output-contract-harness.ts` の `wrapRuntimeModule` が、これらを
 * `createRuntime` の戻り値に配線する。
 *
 * `recall()` 自身の契約（`RecallResultSchema` を含む）は `checkRecallResultContract`
 * （`./runtime-fakes.ts`）が別に持つ——この一式には持ち込まない。ここに schema が無いのは
 * 手抜きではない: `Runtime` の他の操作の結果型はそもそも zod schema を持たない
 * （`correction-candidates.ts` 末尾のコメント参照）。ここでの検査は、そのぶん TSDoc の
 * 文面から直接書き下した、より狭い約束の集まりである。
 *
 * `reembed`（`RequeueEmbedJobsResult`）は対象外——この型の約束はまだ TSDoc から
 * 洗い出していない（このファイルが持つ16本のどれとも違う理由で除外している。
 * 「約束が無い」のではなく「まだ抽出していない」）。
 *
 * id の突き合わせは、**store から読み直した値どうし・store から読み直した値と呼び出し引数**を
 * 比べるときは大文字小文字を無視する（`normId`）。`@mnemora/postgres` は UUID を小文字で返す一方、
 * テストは大文字の UUID を渡すことがある（`uppercase-uuid` 系の歯が意図的に固定している非対称）
 * ため、素の `===` で比べると postgres 実装だけが誤検知する（`getRecall` の `recallId`、
 * `markContested`/`resolveContested` が返す `Memory.id`、`restoreSuperseded` の
 * `supersedingMemoryId`/`onlyMemoryIds` フィルタなど）。
 *
 * ⛔ **例外が2つある。どちらも「store から読み直した値」ではなく「入力をそのまま運ぶだけの値」
 * なので、完全一致（`===`）で比べる:**
 * - **`checkSameOrderAndLength`**（`forget`/`purge`/`restoreArchived`/`{ memoryIds }` 形の
 *   `consolidate`/`reflect` が共有する）。`outcomes[i].memoryId` は `runtime.ts` が入力の
 *   `ids[i]` をそのまま運ぶ値であり、大文字小文字だけが違う id を「同じ id」として畳まない
 *   （`uppercase-uuid-lookup.postgres.test.ts`「やりすぎの歯」——渡した綴りが店の綴りと
 *   一致しない側は `"not_found"` のまま）。同じ理由で `checkForgetContract` の「同じ id の
 *   2回目」判定も綴りの完全一致で見る。
 * - **`applyCorrection` の候補の突き合わせ**——`apply-correction.ts` の実装・
 *   `Runtime.applyCorrection` の doc コメント（手順2）が `memoryId === correctedId` の
 *   完全一致で候補を探すと約束しているので、ここも実装と同じ完全一致で確かめる
 *   （下の `checkApplyCorrectionContract` 参照）。ADR 0446 で足した例外が1つ: 完全一致が無く、大文字小文字を
 *   無視してちょうど1件に一致する候補が在るときだけ、store が同じ記憶と言えば候補として扱う。
 */

function normId(id: string): string {
  return id.toLowerCase();
}

/** `Memory` を返す欄が、実行時にも `MemorySchema` を満たしているかを確かめる。 */
function memoryOk(memory: Memory, label: string, p: string[]): void {
  const parsed = MemorySchema.safeParse(memory);
  if (!parsed.success) {
    p.push(
      `${label}: MemorySchema: ${parsed.error.issues.map((i) => `${i.path.join(".")}:${i.code}`).join(", ")}`,
    );
  }
}

/** `{ memoryId } | { memoryIds }` の二形（`ForgetTarget`/`RestoreArchivedTarget`/`PurgeTarget`）を正規化する。 */
function targetIds(target: { memoryId: MemoryId } | { memoryIds: MemoryId[] }): MemoryId[] {
  return "memoryIds" in target ? target.memoryIds : [target.memoryId];
}

/**
 * `outcomes` が入力の id 配列と**同じ順序・同じ長さ**であるという約束（`ForgetResult.outcomes`・
 * `PurgeResult.outcomes`・`RestoreArchivedResult.outcomes`・`ConsolidationResult.sources`・
 * `ReflectionResult.basis` の各 doc コメントが共有する規律）を確かめる。
 *
 * ⚠ **ここだけは完全一致（`===`）で比べる。`normId` は使わない。** `outcomes[i].memoryId` は
 * store から読み直した値ではなく、`runtime.ts`（例: `forget` の `outcomes.push({ memoryId: id, ... })`）
 * が入力の `ids[i]` をそのまま運ぶだけの値である——store が id を正規化するかどうかとは無関係に、
 * 呼び出し側が渡した綴りがそのまま返る。大文字小文字だけが違う id を混ぜたときに「同じ id」として
 * 畳まない（`uppercase-uuid-lookup.postgres.test.ts` の「やりすぎの歯」——渡した綴りと違う id は
 * store の綴りと一致しない限り `not_found` のまま）ことを、この完全一致がそのまま裏付ける。
 */
function checkSameOrderAndLength<T extends { memoryId: MemoryId }>(
  outcomes: readonly T[],
  ids: readonly MemoryId[],
  label: string,
  p: string[],
): void {
  if (outcomes.length !== ids.length) {
    p.push(`${label}: outcomes.length=${outcomes.length} 入力=${ids.length}`);
    return;
  }
  outcomes.forEach((o, i) => {
    if (o.memoryId !== ids[i]) p.push(`${label}: outcomes の順序が入力と違う`);
  });
}

/**
 * 「`"failed"` になった要素より前（または `"failed"` が無いとき）に `"not_attempted"` は
 * 出ない・`"failed"` の後は全部 `"not_attempted"`」という約束（`ForgetOutcome`・`PurgeOutcome`・
 * `RestoreArchivedOutcome`・`ConsolidateSourceOutcome` の各 doc コメントが共有する規律）を確かめる。
 */
function checkNotAttemptedOnlyAfterFailed<T extends { kind: string }>(
  outcomes: readonly T[],
  label: string,
  p: string[],
): void {
  const firstFailed = outcomes.findIndex((o) => o.kind === "failed");
  outcomes.forEach((o, i) => {
    if (o.kind === "not_attempted" && (firstFailed === -1 || i < firstFailed)) {
      p.push(`${label}: failed より前（または failed 無し）に not_attempted`);
    }
    if (firstFailed !== -1 && i > firstFailed && o.kind !== "not_attempted") {
      p.push(`${label}: failed の後に ${o.kind}`);
    }
  });
}

// ---------------------------------------------------------------------------
// observe
// ---------------------------------------------------------------------------

type ObserveArgs = Parameters<Runtime["observe"]>;
type ObserveReturn = Awaited<ReturnType<Runtime["observe"]>>;

/**
 * `Runtime.observe` の戻り値の約束（`ObserveResult` の doc コメント）:
 * - `extraction === "llm_failed_whole_observation"` ⟺ `extractionFailure !== null`。
 * - `input.extract === "deferred"` なら `memoryIds` は空（sync 抽出でしか作られない）。
 * - `subjectCandidates`（空でない）を渡したときだけ `rejectedSubjectIds` を持ち、常に配列。
 * - `claimKey.enabled: true` を渡したときだけ `claimKeyFailure` を持つ。
 * - `claimKey.detectContested: true` を渡したときだけ `contestedDetection` を持ち、常に配列。
 * - ただし **`extraction === "skipped"`（冪等な再送。`deferred` は上の3つを渡せない）では、上の3つの欄は渡していても無い**
 *   （ADR 0454。`ObserveResult` の各欄の doc）。再送は抽出も検出も走らせない。
 */
export function checkObserveContract(args: ObserveArgs, result: ObserveReturn): string[] {
  const p: string[] = [];
  const input = args[1];

  if (
    (result.extraction === "llm_failed_whole_observation") !==
    (result.extractionFailure !== null)
  ) {
    p.push(`observe: extraction=${result.extraction} と extractionFailure の有無が食い違う`);
  }

  const extract = "extract" in input ? input.extract : undefined;
  if (extract === "deferred" && result.memoryIds.length > 0) {
    p.push("observe: extract:'deferred' なのに memoryIds が空でない");
  }

  // ADR 0454: 冪等な再送は抽出も検出も走らせないので、渡した欄は付かない。
  if (result.extraction === "skipped") return p;

  const subjectCandidates = "subjectCandidates" in input ? input.subjectCandidates : undefined;
  const passedSubjectCandidates = Array.isArray(subjectCandidates) && subjectCandidates.length > 0;
  if (passedSubjectCandidates !== (result.rejectedSubjectIds !== undefined)) {
    p.push(
      `observe: subjectCandidates を渡した=${passedSubjectCandidates} と rejectedSubjectIds の有無が食い違う`,
    );
  }
  if (passedSubjectCandidates && !Array.isArray(result.rejectedSubjectIds)) {
    p.push("observe: rejectedSubjectIds が配列でない");
  }

  const claimKey = "claimKey" in input ? input.claimKey : undefined;
  const claimKeyEnabled = claimKey?.enabled === true;
  if (claimKeyEnabled !== (result.claimKeyFailure !== undefined)) {
    p.push(`observe: claimKey.enabled=${claimKeyEnabled} と claimKeyFailure の有無が食い違う`);
  }
  const detectContested = claimKey?.detectContested === true;
  if (detectContested !== (result.contestedDetection !== undefined)) {
    p.push(
      `observe: claimKey.detectContested=${detectContested} と contestedDetection の有無が食い違う`,
    );
  }
  if (detectContested && !Array.isArray(result.contestedDetection)) {
    p.push("observe: contestedDetection が配列でない");
  }

  return p;
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

type TickReturn = Awaited<ReturnType<Runtime["tick"]>>;

/**
 * `Runtime.tick` の戻り値の約束（`TickResult` の doc コメント）:
 * - `processed`/`failed` は非負整数。
 * - `unsupported`/`leaseConflicts` は「空配列が既定であり、`undefined` にはならない」。
 * - `unsupported` に入ったジョブは `failed` にも数える ⟹ `unsupported.length <= failed`。
 */
export function checkTickContract(result: TickReturn): string[] {
  const p: string[] = [];
  for (const key of ["processed", "failed"] as const) {
    if (!Number.isInteger(result[key]) || result[key] < 0) p.push(`tick: ${key}=${result[key]}`);
  }
  if (!Array.isArray(result.unsupported)) p.push("tick: unsupported が配列でない");
  if (!Array.isArray(result.leaseConflicts)) p.push("tick: leaseConflicts が配列でない");
  if (Array.isArray(result.unsupported) && result.unsupported.length > result.failed) {
    p.push(`tick: unsupported(${result.unsupported.length}) が failed(${result.failed}) を超える`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// getRecall（スコープ: Runtime レベルの突き合わせだけ。RecallRecord の中身・provenance・
// createRecall・null になる条件は別の担当が扱っているので、ここでは触らない）
// ---------------------------------------------------------------------------

type GetRecallArgs = Parameters<Runtime["getRecall"]>;
type GetRecallReturn = Awaited<ReturnType<Runtime["getRecall"]>>;

/**
 * `Runtime.getRecall` の戻り値の約束（doc コメント）のうち、Runtime レベルで言えることだけ:
 * - 見つかったとき、`recallId` は引数と同じ（大文字小文字は無視——`normId` 冒頭のコメント）。
 * - 見つかったとき、`tenantId` は呼び出しに使った `ctx.tenantId` と同じ
 *   （「別テナントの recall なら `null` を返す」の裏を返す約束）。
 */
export function checkGetRecallContract(args: GetRecallArgs, result: GetRecallReturn): string[] {
  const p: string[] = [];
  const [ctx, recallId] = args;
  if (result !== null) {
    if (normId(result.recallId) !== normId(recallId))
      p.push("getRecall: 別の recallId の記録を返した");
    if (result.tenantId !== ctx.tenantId) p.push("getRecall: 別テナントの記録を返した");
  }
  return p;
}

// ---------------------------------------------------------------------------
// findCorrectionCandidates
// ---------------------------------------------------------------------------

type FindCorrectionCandidatesArgs = Parameters<Runtime["findCorrectionCandidates"]>;
type FindCorrectionCandidatesReturn = Awaited<ReturnType<Runtime["findCorrectionCandidates"]>>;

/**
 * `Runtime.findCorrectionCandidates` の戻り値の約束（`FindCorrectionCandidatesResult`/
 * `CorrectionCandidate` の doc コメント、`correction-candidates.ts`）:
 * - `outcome === "candidates"` ⟺ `candidates.length > 0`。
 * - `candidates.length <= recalledCount - excludedCount`。
 * - `excludeMemoryIds` に挙げた id は `candidates` に残らない。
 * - `limit` を渡したら、それを超えない。
 * - `recallRank` は昇順（`recall()` が返した並びの順位。詰め直さない）。
 */
export function checkFindCorrectionCandidatesContract(
  args: FindCorrectionCandidatesArgs,
  result: FindCorrectionCandidatesReturn,
): string[] {
  const p: string[] = [];
  const input = args[1];

  if ((result.outcome === "candidates") !== result.candidates.length > 0) {
    p.push("findCorrectionCandidates: outcome と candidates の件数が食い違う");
  }
  if (result.candidates.length > result.recalledCount - result.excludedCount) {
    p.push("findCorrectionCandidates: candidates が recalledCount - excludedCount より多い");
  }
  const excluded = new Set((input.excludeMemoryIds ?? []).map(normId));
  if (result.candidates.some((c) => excluded.has(normId(c.memoryId)))) {
    p.push("findCorrectionCandidates: excludeMemoryIds の id が candidates に残る");
  }
  if (typeof input.limit === "number" && result.candidates.length > input.limit) {
    p.push("findCorrectionCandidates: limit を超えた");
  }
  for (let i = 1; i < result.candidates.length; i += 1) {
    if (result.candidates[i - 1]!.recallRank >= result.candidates[i]!.recallRank) {
      p.push("findCorrectionCandidates: recallRank が昇順でない");
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// reextract
// ---------------------------------------------------------------------------

type ReextractArgs = Parameters<Runtime["reextract"]>;
type ReextractReturn = Awaited<ReturnType<Runtime["reextract"]>>;
type ReextractSkipReason = Extract<
  ReextractReturn["skipped"][number],
  { kind: "not_examined" }
>["reason"];

function notExaminedReasons(skipped: ReextractReturn["skipped"]): ReextractSkipReason[] {
  return skipped.flatMap((k) => (k.kind === "not_examined" ? [k.reason] : []));
}

/**
 * `Runtime.reextract` の戻り値の約束（`ReextractResult`・`Runtime.reextract` の doc コメント）:
 * - `extraction === "llm_failed_whole_observation"` ⟺ `extractionFailure !== null`。
 * - LLM がまた失敗、または候補0件のときは `supersededMemoryIds` が空。
 * - `extraction !== "ok"` なら `memoryIds` は空。
 * - `atomicity` は `WriteAtomicity` の3値のどれか。
 * - `observationId` は引数と同じ（大文字小文字は無視）。
 * - LLM 失敗の早期 return は `skipped` に `not_examined(llm_failed_whole_observation)` が1件だけ。
 * - 候補0件の早期 return は `skipped` に `not_examined(no_candidates)` が1件だけ。
 * - 2026-09-28 変更（Issue #1079・#1149、`Runtime.reextract` の doc コメント）: 利用者の意思で
 *   退けた記憶を持つ Observation の早期 return は `extraction: "skipped"`、`skipped` は
 *   `status_not_active` だけ（`not_examined` は入らない）、`atomicity` は `"not_attempted"`。
 */
export function checkReextractContract(args: ReextractArgs, result: ReextractReturn): string[] {
  const p: string[] = [];
  const observationId = args[1];

  if (
    (result.extraction === "llm_failed_whole_observation") !==
    (result.extractionFailure !== null)
  ) {
    p.push("reextract: extraction と extractionFailure の有無が食い違う");
  }
  if (
    result.extraction === "llm_failed_whole_observation" &&
    result.supersededMemoryIds.length > 0
  ) {
    p.push("reextract: LLM 失敗なのに supersededMemoryIds が空でない");
  }
  if (result.memoryIds.length === 0 && result.supersededMemoryIds.length > 0) {
    p.push("reextract: 候補0件なのに supersededMemoryIds が空でない");
  }
  if (result.extraction !== "ok" && result.memoryIds.length > 0) {
    p.push(`reextract: extraction=${result.extraction} なのに memoryIds が空でない`);
  }
  if (!["store_supported", "store_unsupported", "not_attempted"].includes(result.atomicity)) {
    p.push(`reextract: atomicity=${result.atomicity}`);
  }
  if (normId(result.observationId) !== normId(observationId)) {
    p.push("reextract: observationId が引数と違う");
  }

  const notExamined = notExaminedReasons(result.skipped);
  if (result.extraction === "llm_failed_whole_observation") {
    const ok = notExamined.length === 1 && notExamined[0] === "llm_failed_whole_observation";
    if (!ok) {
      p.push(
        "reextract: LLM 失敗の早期 return なのに skipped に not_examined(llm_failed_whole_observation) が無い",
      );
    }
  }
  if (result.extraction === "ok" && result.memoryIds.length === 0) {
    const ok = notExamined.length === 1 && notExamined[0] === "no_candidates";
    if (!ok)
      p.push(
        "reextract: 候補0件の早期 return なのに skipped に not_examined(no_candidates) が無い",
      );
  }
  if (result.extraction === "skipped") {
    if (result.skipped.length === 0 || result.skipped.some((k) => k.kind !== "status_not_active")) {
      p.push("reextract: 退けた記憶の早期 return なのに skipped が status_not_active だけでない");
    }
    if (result.atomicity !== "not_attempted") {
      p.push("reextract: 退けた記憶の早期 return なのに atomicity が not_attempted でない");
    }
  }

  return p;
}

// ---------------------------------------------------------------------------
// sweepArchive
// ---------------------------------------------------------------------------

type SweepArchiveReturn = Awaited<ReturnType<Runtime["sweepArchive"]>>;

/**
 * `Runtime.sweepArchive` の戻り値の約束（`SweepArchiveResult` の doc コメント）:
 * - `supported: false` なら `archived` は空・`reachedLimit` は `false`。
 * - `archived` は `decayFloorAt` 昇順。
 */
export function checkSweepArchiveContract(result: SweepArchiveReturn): string[] {
  const p: string[] = [];
  if (result.supported === false) {
    if (result.archived.length > 0)
      p.push("sweepArchive: supported:false なのに archived が空でない");
    if (result.reachedLimit !== false)
      p.push("sweepArchive: supported:false なのに reachedLimit が false でない");
  }
  for (let i = 1; i < result.archived.length; i += 1) {
    if (
      result.archived[i - 1]!.decayFloorAt.getTime() > result.archived[i]!.decayFloorAt.getTime()
    ) {
      p.push("sweepArchive: archived が decayFloorAt 昇順でない");
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// restoreArchived
// ---------------------------------------------------------------------------

type RestoreArchivedArgs = Parameters<Runtime["restoreArchived"]>;
type RestoreArchivedReturn = Awaited<ReturnType<Runtime["restoreArchived"]>>;

/**
 * `Runtime.restoreArchived` の戻り値の約束（`RestoreArchivedResult`/`RestoreArchivedOutcome` の
 * doc コメント。`ForgetOutcome` と同じ「無い」の分類）:
 * - `outcomes` は入力と同じ順序・同じ長さ。
 * - `"not_attempted"` は `"failed"` より前には出ない・`"failed"` の後は全部それ。
 * - `"restored"` の `previousStatus` は常に `"archived"`。
 * - `"status_not_archived"` の `status` は `"archived"` ではありえない。
 */
export function checkRestoreArchivedContract(
  args: RestoreArchivedArgs,
  result: RestoreArchivedReturn,
): string[] {
  const p: string[] = [];
  checkSameOrderAndLength(result.outcomes, targetIds(args[1]), "restoreArchived", p);
  checkNotAttemptedOnlyAfterFailed(result.outcomes, "restoreArchived", p);
  for (const o of result.outcomes) {
    if (o.kind === "restored" && o.previousStatus !== "archived") {
      p.push("restoreArchived: restored.previousStatus !== 'archived'");
    }
    if (o.kind === "status_not_archived" && String(o.status) === "archived") {
      p.push("restoreArchived: status_not_archived なのに status='archived'");
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// restoreSuperseded
// ---------------------------------------------------------------------------

type RestoreSupersededArgs = Parameters<Runtime["restoreSuperseded"]>;
type RestoreSupersededReturn = Awaited<ReturnType<Runtime["restoreSuperseded"]>>;

/**
 * `Runtime.restoreSuperseded` の戻り値の約束（`RestoreSupersededResult`/`RestoreSupersededOutcome`
 * の doc コメント）:
 * - `supported: false` なら `outcomes` は空。
 * - `supersedingMemoryId` は `target.supersededById` と同じ（大文字小文字は無視）。
 * - `opts.dryRun` の有無で `"restored"`/`"would_restore"` が排他的に出る。
 * - `"failed"` 以外の `previousStatus` は常に `"superseded"`。
 * - `target.onlyMemoryIds` を渡したら、`outcomes` はその外の id を含まない。
 */
export function checkRestoreSupersededContract(
  args: RestoreSupersededArgs,
  result: RestoreSupersededReturn,
): string[] {
  const p: string[] = [];
  const [, target, opts] = args;

  if (result.supported === false && result.outcomes.length > 0) {
    p.push("restoreSuperseded: supported:false なのに outcomes が空でない");
  }
  if (normId(result.supersedingMemoryId) !== normId(target.supersededById)) {
    p.push("restoreSuperseded: supersedingMemoryId が target.supersededById と違う");
  }

  const dryRun = opts?.dryRun === true;
  const only = target.onlyMemoryIds?.map(normId);
  for (const o of result.outcomes) {
    if (dryRun && o.kind === "restored") p.push("restoreSuperseded: dryRun なのに restored");
    if (!dryRun && o.kind === "would_restore")
      p.push("restoreSuperseded: dryRun でないのに would_restore");
    if (o.kind !== "failed" && String(o.previousStatus) !== "superseded") {
      p.push("restoreSuperseded: previousStatus !== 'superseded'");
    }
    if (only !== undefined && !only.includes(normId(o.memoryId))) {
      p.push("restoreSuperseded: onlyMemoryIds フィルタの外の id が outcomes に居る");
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// forget
// ---------------------------------------------------------------------------

type ForgetArgs = Parameters<Runtime["forget"]>;
type ForgetReturn = Awaited<ReturnType<Runtime["forget"]>>;

/**
 * `Runtime.forget` の戻り値の約束（`ForgetResult`/`ForgetOutcome` の doc コメント）:
 * - `outcomes` は入力と同じ順序・同じ長さ。
 * - `"not_attempted"` は `"failed"` より前には出ない・`"failed"` の後は全部それ。
 * - **綴りが完全に同じ** id が2回渡されたとき、1回目が `"forgotten"` なら2回目は
 *   `"already_forgotten"`（または、それより前の要素が失敗していれば `"not_attempted"`）
 *   ——冪等性の裏付け。**綴りだけで判定する（`normId` は使わない）。**大文字小文字だけが
 *   違う2つの id は、`getMany` が店の綴りとしか一致しないため（`checkSameOrderAndLength`
 *   の doc コメント参照）「同じ id」として扱われない——渡した綴りと店の綴りが一致しない
 *   側は今どおり `"not_found"` のまま（`uppercase-uuid-lookup.postgres.test.ts`
 *   「やりすぎの歯」）。
 */
export function checkForgetContract(args: ForgetArgs, result: ForgetReturn): string[] {
  const p: string[] = [];
  checkSameOrderAndLength(result.outcomes, targetIds(args[1]), "forget", p);
  checkNotAttemptedOnlyAfterFailed(result.outcomes, "forget", p);

  const lastKind = new Map<string, string>();
  for (const o of result.outcomes) {
    const key = o.memoryId;
    if (
      lastKind.get(key) === "forgotten" &&
      o.kind !== "already_forgotten" &&
      o.kind !== "not_attempted"
    ) {
      p.push(`forget: 同じ id の2回目が ${o.kind}（1回目で forgotten 済みのはず）`);
    }
    lastKind.set(key, o.kind);
  }
  return p;
}

// ---------------------------------------------------------------------------
// purge
// ---------------------------------------------------------------------------

type PurgeArgs = Parameters<Runtime["purge"]>;
type PurgeReturn = Awaited<ReturnType<Runtime["purge"]>>;

/**
 * `Runtime.purge` の戻り値の約束（`PurgeResult`/`PurgeOutcome` の doc コメント）:
 * - `outcomes` は入力と同じ順序・同じ長さ。
 * - `supported: false` なら全要素が `"not_attempted"`。
 * - `supported: true` のときだけ「`"failed"` の後は `"not_attempted"`」の規律を適用する。
 * - `opts.dryRun` の有無で `"purged"`/`"would_purge"` が排他的に出る。
 * - `"status_not_forgotten"` の `status` は `"forgotten"` ではありえない。
 */
export function checkPurgeContract(args: PurgeArgs, result: PurgeReturn): string[] {
  const p: string[] = [];
  checkSameOrderAndLength(result.outcomes, targetIds(args[1]), "purge", p);
  if (result.supported === false && result.outcomes.some((o) => o.kind !== "not_attempted")) {
    p.push("purge: supported:false なのに not_attempted 以外の outcome がある");
  }
  if (result.supported) checkNotAttemptedOnlyAfterFailed(result.outcomes, "purge", p);

  const dryRun = args[2]?.dryRun === true;
  for (const o of result.outcomes) {
    if (dryRun && o.kind === "purged") p.push("purge: dryRun なのに purged");
    if (!dryRun && o.kind === "would_purge") p.push("purge: dryRun でないのに would_purge");
    if (o.kind === "status_not_forgotten" && String(o.status) === "forgotten") {
      p.push("purge: status_not_forgotten なのに status='forgotten'");
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// markContested
// ---------------------------------------------------------------------------

type MarkContestedArgs = Parameters<Runtime["markContested"]>;
type MarkContestedReturn = Awaited<ReturnType<Runtime["markContested"]>>;

/**
 * `Runtime.markContested` の戻り値の約束（`MarkContestedResult`/`MarkContestedOutcome` の
 * doc コメント）:
 * - `supported: false` ⟺ `outcome.kind === "not_attempted"`。
 * - `outcome.kind === "contested"` のとき: `first`/`second` は `MemorySchema` を満たし、
 *   引数の順（`firstId`/`secondId`）と一致し（大文字小文字は無視）、両側とも
 *   `status: "contested"`、`contestedWithId` は相互に相手を指す。
 */
export function checkMarkContestedContract(
  args: MarkContestedArgs,
  result: MarkContestedReturn,
): string[] {
  const p: string[] = [];
  const [, firstId, secondId] = args;

  if (result.supported === false && result.outcome.kind !== "not_attempted") {
    p.push(`markContested: supported:false なのに outcome=${result.outcome.kind}`);
  }
  if (result.supported === true && result.outcome.kind === "not_attempted") {
    p.push("markContested: supported:true なのに outcome=not_attempted");
  }
  if (result.outcome.kind === "contested") {
    const { first, second } = result.outcome;
    memoryOk(first, "markContested.first", p);
    memoryOk(second, "markContested.second", p);
    if (normId(first.id) !== normId(firstId) || normId(second.id) !== normId(secondId)) {
      p.push("markContested: first/second が引数の順でない");
    }
    if (first.status !== "contested" || second.status !== "contested") {
      p.push("markContested: contested なのに両側の status が contested でない");
    }
    if (first.contestedWithId !== second.id || second.contestedWithId !== first.id) {
      p.push("markContested: contestedWithId が相互でない");
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// resolveContested
// ---------------------------------------------------------------------------

type ResolveContestedArgs = Parameters<Runtime["resolveContested"]>;
type ResolveContestedReturn = Awaited<ReturnType<Runtime["resolveContested"]>>;

/**
 * `Runtime.resolveContested` の戻り値の約束（`ResolveContestedResult`/`ResolveContestedOutcome`
 * の doc コメント）:
 * - `supported: false` ⟺ `outcome.kind === "not_attempted"`。
 * - `outcome.kind === "resolved"` のとき: `first`/`second` は `MemorySchema` を満たし、
 *   引数の順と一致し、`contestedWithId` はどちらも `null`（解決後は対を解く）。
 *   `resolution.kind === "both_active"` なら両側 `active`、`"supersede"` なら
 *   `winnerId` 側だけ `active`・もう一方は `superseded`（`winnerId` の突き合わせも
 *   大文字小文字を無視する——`resolveContested` の doc コメント手順2の追記）。
 */
export function checkResolveContestedContract(
  args: ResolveContestedArgs,
  result: ResolveContestedReturn,
): string[] {
  const p: string[] = [];
  const [, firstId, secondId, resolution] = args;

  if (result.supported === false && result.outcome.kind !== "not_attempted") {
    p.push(`resolveContested: supported:false なのに outcome=${result.outcome.kind}`);
  }
  if (result.supported === true && result.outcome.kind === "not_attempted") {
    p.push("resolveContested: supported:true なのに outcome=not_attempted");
  }
  if (result.outcome.kind === "resolved") {
    const { first, second } = result.outcome;
    memoryOk(first, "resolveContested.first", p);
    memoryOk(second, "resolveContested.second", p);
    if (normId(first.id) !== normId(firstId) || normId(second.id) !== normId(secondId)) {
      p.push("resolveContested: first/second が引数の順でない");
    }
    const winner = resolution.kind === "supersede" ? normId(resolution.winnerId) : null;
    for (const m of [first, second]) {
      if (m.contestedWithId !== null)
        p.push("resolveContested: resolved 後も contestedWithId が残る");
      const want =
        resolution.kind === "both_active" || normId(m.id) === winner ? "active" : "superseded";
      if (m.status !== want) {
        p.push(
          `resolveContested: resolution=${resolution.kind} で status=${m.status}（期待 ${want}）`,
        );
      }
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// resolveOrphanedContested（任意メソッド。`createRuntime` は必ず実装するが、
// `Runtime` interface 上は `?` なので、呼び出し側の型もそれに合わせる）
// ---------------------------------------------------------------------------

type ResolveOrphanedContestedFn = NonNullable<Runtime["resolveOrphanedContested"]>;
type ResolveOrphanedContestedReturn = Awaited<ReturnType<ResolveOrphanedContestedFn>>;

/**
 * `Runtime.resolveOrphanedContested` の戻り値の約束（`ResolveOrphanedContestedResult`/
 * `ResolveOrphanedContestedOutcome` の doc コメント）:
 * - `supported: false` ⟺ `outcome.kind === "not_attempted"`。
 * - `outcome.kind === "resolved"` のとき: `memory` は `MemorySchema` を満たし、
 *   `status: "active"`・`contestedWithId: null`。
 */
export function checkResolveOrphanedContestedContract(
  result: ResolveOrphanedContestedReturn,
): string[] {
  const p: string[] = [];
  if (result.supported === false && result.outcome.kind !== "not_attempted") {
    p.push(`resolveOrphanedContested: supported:false なのに outcome=${result.outcome.kind}`);
  }
  if (result.supported === true && result.outcome.kind === "not_attempted") {
    p.push("resolveOrphanedContested: supported:true なのに outcome=not_attempted");
  }
  if (result.outcome.kind === "resolved") {
    const { memory } = result.outcome;
    memoryOk(memory, "resolveOrphanedContested.memory", p);
    if (memory.status !== "active" || memory.contestedWithId !== null) {
      p.push(
        `resolveOrphanedContested: resolved の memory.status=${memory.status} contestedWithId=${String(memory.contestedWithId)}`,
      );
    }
  }
  return p;
}

// ---------------------------------------------------------------------------
// applyCorrection
// ---------------------------------------------------------------------------

type ApplyCorrectionArgs = Parameters<Runtime["applyCorrection"]>;
type ApplyCorrectionReturn = Awaited<ReturnType<Runtime["applyCorrection"]>>;

/**
 * `Runtime.applyCorrection` の戻り値の約束（`ApplyCorrectionResult` の doc コメント・
 * `Runtime.applyCorrection` の doc コメントの手順1〜5）:
 * - `correctedId` 省略 ⟺ `kind === "awaiting_choice"`。
 * - `correctedId` が `discovery.candidates` に居ない ⟺ `kind === "not_a_candidate"`
 *   （突き合わせは実装と同じ `memoryId === correctedId` の完全一致。ただし大文字小文字だけが違う候補が
 *   ちょうど1件在るときは、store が同じ記憶と言えば候補として扱う——ADR 0446）。
 * - `kind` が `"contested"`/`"resolved"` のとき: `chosenRecallRank` は候補の `recallRank` と
 *   一致し、`correctingId` は入力と一致する（大文字小文字は無視）。
 * - `resolution` を渡さなければ `"contested"` で止まる。渡せば `"resolved"` まで進む。
 */
export function checkApplyCorrectionContract(
  args: ApplyCorrectionArgs,
  result: ApplyCorrectionReturn,
): string[] {
  const p: string[] = [];
  const input = args[1];
  const corrected = input.correctedId;

  if (corrected === undefined) {
    if (result.kind !== "awaiting_choice")
      p.push(`applyCorrection: correctedId 無しで kind=${result.kind}`);
    return p;
  }

  const exact = input.discovery.candidates.find((c) => c.memoryId === corrected);
  // ADR 0446: 完全一致する候補が無くても、大文字小文字を無視して**ちょうど1件**に一致するなら、store が同じ記憶と
  // 言ったときだけ候補として扱う（`resolveContested` の `winnerId` と同じ形）。store の答えはここからは見えないので、
  // その場合は `not_a_candidate` も `contested`/`resolved` も許す（後者のときは、その1件の `recallRank` を運ぶこと）。
  const lowered = corrected.toLowerCase();
  const sameSpelling = input.discovery.candidates.filter(
    (c) => c.memoryId.toLowerCase() === lowered,
  );
  const hit = exact ?? (sameSpelling.length === 1 ? sameSpelling[0] : undefined);
  if (exact === undefined && hit === undefined) {
    if (result.kind !== "not_a_candidate") {
      p.push(`applyCorrection: 候補に居ない correctedId で kind=${result.kind}`);
    }
    return p;
  }
  if (hit === undefined) return p;
  if (exact === undefined && result.kind === "not_a_candidate") return p;
  if (result.kind === "not_a_candidate") p.push("applyCorrection: 候補に居るのに not_a_candidate");
  if (
    (result.kind === "contested" || result.kind === "resolved") &&
    result.chosenRecallRank !== hit.recallRank
  ) {
    p.push("applyCorrection: chosenRecallRank が候補の recallRank と違う");
  }
  if (
    (result.kind === "contested" || result.kind === "resolved") &&
    normId(result.correctingId) !== normId(input.correctingId)
  ) {
    p.push("applyCorrection: correctingId が入力と違う");
  }
  if (result.kind === "contested" && input.resolution !== undefined) {
    p.push("applyCorrection: resolution を渡したのに contested で止まった");
  }
  if (result.kind === "resolved" && input.resolution === undefined) {
    p.push("applyCorrection: resolution 無しで resolved");
  }
  return p;
}

// ---------------------------------------------------------------------------
// consolidate
// ---------------------------------------------------------------------------

type ConsolidateArgs = Parameters<Runtime["consolidate"]>;
type ConsolidateReturn = Awaited<ReturnType<Runtime["consolidate"]>>;

/**
 * `Runtime.consolidate` の戻り値の約束（`ConsolidationResult` の doc コメント）:
 * - `outcome === "nothing_to_consolidate"` ⟺ `nothingReason !== null`。
 * - `outcome === "consolidated"` ⟺ `consolidatedMemoryId !== null`。
 * - `outcome === "llm_failed"` ⟺ `llmFailure !== null`。
 * - `outcome === "not_examined"` なら `sources` は空。
 * - `{ memoryIds }` 形なら `sources` は入力と同じ順序・同じ長さ。
 * - `outcome` が `dry_run`/`not_examined`/`nothing_to_consolidate` なら `llmCalls === 0`。
 * - `opts.dryRun: true` なら `outcome` はその3値のどれか。
 * - `outcome !== "consolidated"` なら `atomicity === "not_attempted"`。
 */
export function checkConsolidateContract(
  args: ConsolidateArgs,
  result: ConsolidateReturn,
): string[] {
  const p: string[] = [];
  const opts = args[1];

  if ((result.outcome === "nothing_to_consolidate") !== (result.nothingReason !== null)) {
    p.push(`consolidate: outcome=${result.outcome} と nothingReason の有無が食い違う`);
  }
  if ((result.outcome === "consolidated") !== (result.consolidatedMemoryId !== null)) {
    p.push(`consolidate: outcome=${result.outcome} と consolidatedMemoryId の有無が食い違う`);
  }
  if ((result.outcome === "llm_failed") !== (result.llmFailure !== null)) {
    p.push(`consolidate: outcome=${result.outcome} と llmFailure の有無が食い違う`);
  }
  if (result.outcome === "not_examined" && result.sources.length > 0) {
    p.push("consolidate: not_examined なのに sources が空でない");
  }
  if ("memoryIds" in opts.target && result.outcome !== "not_examined") {
    checkSameOrderAndLength(result.sources, opts.target.memoryIds, "consolidate", p);
  }
  const zeroCalls =
    result.outcome === "dry_run" ||
    result.outcome === "not_examined" ||
    result.outcome === "nothing_to_consolidate";
  if (zeroCalls && result.llmCalls !== 0) {
    p.push(`consolidate: outcome=${result.outcome} なのに llmCalls=${result.llmCalls}`);
  }
  if (
    opts.dryRun === true &&
    !["dry_run", "not_examined", "nothing_to_consolidate"].includes(result.outcome)
  ) {
    p.push(`consolidate: dryRun なのに outcome=${result.outcome}`);
  }
  if (result.outcome !== "consolidated" && result.atomicity !== "not_attempted") {
    p.push(`consolidate: outcome=${result.outcome} なのに atomicity が not_attempted でない`);
  }
  return p;
}

// ---------------------------------------------------------------------------
// reflect
// ---------------------------------------------------------------------------

type ReflectArgs = Parameters<Runtime["reflect"]>;
type ReflectReturn = Awaited<ReturnType<Runtime["reflect"]>>;

/**
 * `Runtime.reflect` の戻り値の約束（`ReflectionResult` の doc コメント。`consolidate` と
 * 対称だが、`atomicity` を持たない——`reflect` は既存行の `status` を1つも動かさないため）:
 * - `outcome === "nothing_to_reflect"` ⟺ `nothingReason !== null`。
 * - `outcome === "reflected"` ⟺ `reflectedMemoryId !== null`。
 * - `outcome === "llm_failed"` ⟺ `llmFailure !== null`。
 * - `outcome === "not_examined"` なら `basis` は空。
 * - `{ memoryIds }` 形なら `basis` は入力と同じ順序・同じ長さ。
 * - `outcome` が `dry_run`/`not_examined`、または `nothingReason === "no_eligible_basis"`
 *   なら `llmCalls === 0`。
 * - `opts.dryRun: true` なら `outcome` は `dry_run`/`not_examined`/`nothing_to_reflect` のどれか。
 */
export function checkReflectContract(args: ReflectArgs, result: ReflectReturn): string[] {
  const p: string[] = [];
  const opts = args[1];

  if ((result.outcome === "nothing_to_reflect") !== (result.nothingReason !== null)) {
    p.push(`reflect: outcome=${result.outcome} と nothingReason の有無が食い違う`);
  }
  if ((result.outcome === "reflected") !== (result.reflectedMemoryId !== null)) {
    p.push(`reflect: outcome=${result.outcome} と reflectedMemoryId の有無が食い違う`);
  }
  if ((result.outcome === "llm_failed") !== (result.llmFailure !== null)) {
    p.push(`reflect: outcome=${result.outcome} と llmFailure の有無が食い違う`);
  }
  if (result.outcome === "not_examined" && result.basis.length > 0) {
    p.push("reflect: not_examined なのに basis が空でない");
  }
  if ("memoryIds" in opts.target && result.outcome !== "not_examined") {
    checkSameOrderAndLength(result.basis, opts.target.memoryIds, "reflect", p);
  }
  const zeroCalls =
    result.outcome === "dry_run" ||
    result.outcome === "not_examined" ||
    result.nothingReason === "no_eligible_basis";
  if (zeroCalls && result.llmCalls !== 0) {
    p.push(`reflect: outcome=${result.outcome} なのに llmCalls=${result.llmCalls}`);
  }
  if (
    opts.dryRun === true &&
    !["dry_run", "not_examined", "nothing_to_reflect"].includes(result.outcome)
  ) {
    p.push(`reflect: dryRun なのに outcome=${result.outcome}`);
  }
  return p;
}
