import type { Clock } from "./interfaces/clock.js";
import type { Ctx } from "./ctx.js";
import type { EmbeddingProvider } from "./interfaces/embedding-provider.js";
import type { MemoryStore } from "./interfaces/memory-store.js";
import type { TokenCounter } from "./interfaces/token-counter.js";
import type { VectorStore, VectorHit } from "./interfaces/vector-store.js";
import type { MemoryId } from "./ids.js";
import { NOT_INDEXED_REASONS } from "./recall.js";
import type { Memory } from "./memory.js";
import {
  DEFAULT_OVER_FETCH_FACTOR,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_SCORE_THRESHOLD,
  RecallQuerySchema,
} from "./recall.js";
import type {
  IndexBand,
  Omission,
  RecallBudget,
  RecallQuery,
  RecallResult,
  RecallScope,
  RecalledMemory,
  ScoreBreakdown,
  StageTrace,
} from "./recall.js";
import { defaultScoringStrategy } from "./strategies/scoring.js";

/**
 * `recall()` の実装（roadmap.md 段階4「想起」・段階5「説明」）。
 *
 * docs/recall.md §2 の7段パイプラインをそのまま実装する。**各段は「なぜ落としたか」を
 * Omission の形にして次の段へ渡し、パイプラインの最後に集計し直さない**（同§2 の契約）。
 * この関数の中の各ステップが、その契約を守る単位である——`omitted` に何かを push したら、
 * それ以降の段はその判断を覆さない。
 *
 * Phase 1 の候補生成（段1）は **ANN 経由の1チャンネルのみ**を実装する（本 PR の決定。
 * PR 本文参照）。docs/recall.md §2 が触れる「タグ一致・直近取得」の並行チャンネルは
 * roadmap.md 段階4の完了条件（「二段検索（段1: 索引が効く形のフィルタ + ANN、
 * 段2: over-fetch した候補への再スコア）」）には明記されておらず、Phase 1 の範囲外とする。
 * タグはスコアリング（段2の加点要素、`defaultScoringStrategy`）としてのみ参加する。
 */

export interface RecallRuntimeDeps {
  memoryStore: MemoryStore;
  vectorStore: VectorStore;
  embeddingProvider: EmbeddingProvider;
  clock: Clock;
  tokenCounter: TokenCounter;
}

type ScoredCandidate = {
  memory: Memory;
  retrievedVia: "ann" | "mandatory_companion";
  companionOf?: MemoryId;
  score: ScoreBreakdown;
};

/** budget truncation の単位。同伴ペアは分割しない（docs/recall.md §8）ため、1つ以上の候補をまとめて持つ。 */
type Unit = {
  members: ScoredCandidate[];
  /** 並び替え・切り詰めの基準スコア。ペアの場合は主(スコアで選ばれた側)のスコアを使う。 */
  rankScore: number;
};

function unitChars(unit: Unit): number {
  return unit.members.reduce((sum, m) => sum + m.memory.digest.length, 0);
}

function unitTokens(unit: Unit, tokenCounter: TokenCounter): number {
  return unit.members.reduce((sum, m) => sum + tokenCounter.count(m.memory.digest).tokens, 0);
}

/** budget が指定されたトークン予算の中で最も厳しい(小さい)ものを1本にまとめる。 */
function effectiveTokenBudget(budget: RecallBudget | undefined): number | undefined {
  if (!budget) return undefined;
  const candidates = [budget.maxMemoryTokens, budget.promptBudgetTokens].filter(
    (v): v is number => v !== undefined,
  );
  if (candidates.length === 0) return undefined;
  return Math.min(...candidates);
}

export async function runRecall(
  ctx: Ctx,
  query: RecallQuery,
  deps: RecallRuntimeDeps,
): Promise<RecallResult> {
  const validatedQuery = RecallQuerySchema.parse(query);
  const now = deps.clock.now();
  const stages: StageTrace[] = [];
  const omitted: Omission[] = [];

  // -------------------------------------------------------------------
  // 段0: スコープ確定（docs/recall.md §2 段0、マネージャー決定の「スコープの外延」）
  // -------------------------------------------------------------------
  const scope: RecallScope = {
    subjectId: ctx.subjectId,
    occurredAfter: validatedQuery.occurredAfter,
    occurredBefore: validatedQuery.occurredBefore,
  };
  stages.push({
    stage: "scope",
    executed: true,
    detail: {
      subjectId: scope.subjectId ?? null,
      occurredAfter: scope.occurredAfter?.toISOString() ?? null,
      occurredBefore: scope.occurredBefore?.toISOString() ?? null,
    },
  });

  // -------------------------------------------------------------------
  // 段1: 候補生成（索引が効く。docs/recall.md §2 段1・§3）
  // -------------------------------------------------------------------
  const limit = validatedQuery.limit ?? DEFAULT_RECALL_LIMIT;
  const overFetchFactor = validatedQuery.overFetchFactor ?? DEFAULT_OVER_FETCH_FACTOR;
  const kPrime = Math.max(1, Math.round(limit * overFetchFactor));

  const embeddableText = validatedQuery.text?.trim();
  let queryVector = validatedQuery.vector;
  let candidateGenerationExecuted = false;
  let annHits: VectorHit[] = [];

  if (queryVector === undefined) {
    if (embeddableText) {
      try {
        const [vector] = await deps.embeddingProvider.embed(ctx, [embeddableText]);
        queryVector = vector;
      } catch {
        omitted.push({
          kind: "stage_skipped",
          stage: "candidate_generation",
          reason: "embedding_provider_unavailable",
        });
      }
    } else {
      omitted.push({
        kind: "stage_skipped",
        stage: "candidate_generation",
        reason: "empty_query_content",
      });
    }
  }

  if (queryVector !== undefined) {
    annHits = await deps.vectorStore.search(ctx, deps.embeddingProvider.space, queryVector, {
      limit: kPrime,
      filter: {
        tenantId: ctx.tenantId,
        status: ["active", "contested"],
        subjectId: scope.subjectId,
      },
      // ADR 0011: decayFloorAtAfter は Phase 1 では読み取りフィルタに使わない。
      // subjectId は等値一致なので段1に降ろす（マネージャー決定）。period は連続値の範囲比較
      // であり partial index の離散値向き制約（docs/recall.md 133行目）に関わる設計判断が
      // 要るため、今回は含めない——Phase 1 の scope に残したまま後段フィルタのみで扱う。
    });
    candidateGenerationExecuted = true;
  }

  stages.push({
    stage: "candidate_generation",
    executed: candidateGenerationExecuted,
    detail: { channel: "ann", kPrime, hits: annHits.length },
  });

  // over-fetch の打ち切り（docs/recall.md §3「正直に書くべき限界」）: LIMIT に達したなら
  // その先に何件あるかは原理的に数えられない。
  if (candidateGenerationExecuted && annHits.length >= kPrime && kPrime > 0) {
    omitted.push({ kind: "ann_truncated", countKind: "unknown" });
  }

  // 候補の実体を取得し、スコープ外（subject/period）・除外 provenance を落とす。
  // ここで落ちたものは「filtered」としては報告しない——subject は呼び出し側の境界
  // （tenant と同格。recall.ts の RecallScope doc 参照）、period はスコープを定義する
  // フィルタであり、その件数は段5の集約から報告する（ここで個別に数え直さない。
  // ADR 0011 と同じ理由——複数の経路から同じ意味の件数を出すと食い違いうる）。
  const candidateIds = annHits.map((h) => h.memoryId);
  const fetchedMemories =
    candidateIds.length > 0 ? await deps.memoryStore.getMany(ctx, candidateIds) : [];
  const memoriesById = new Map(fetchedMemories.map((m) => [m.id, m]));
  const distanceById = new Map(annHits.map((h) => [h.memoryId, h.distance]));

  const excludeKinds = new Set(validatedQuery.excludeProvenanceKinds ?? []);
  const filteredCandidates: { memory: Memory; distance: number }[] = [];
  for (const hit of annHits) {
    const memory = memoriesById.get(hit.memoryId);
    if (!memory) continue; // getMany は存在しない/クロステナントの id を静かに落とす契約。
    // subjectId は段1の filter にも渡している（上）が、ここでも改めて見る。二重に見えるが
    // 意図的——`VectorStore` は「絞ってもよいが絞らなくてもよい」派生索引であり
    // （interfaces/vector-store.ts の doc）、正しさの責任は常にこの後段にある。
    // `InMemoryVectorStore`（testkit）は filter を無視するプレースホルダなので、
    // ここを削ると core の契約そのものが壊れる。段1の絞りは正しさのためではなく、
    // over-fetch の窓（k'）を無駄にしないための最適化に過ぎない。
    if (scope.subjectId !== undefined && memory.subjectId !== scope.subjectId) continue;
    const effectiveTime = memory.occurredAt ?? memory.recordedAt;
    if (scope.occurredAfter && effectiveTime < scope.occurredAfter) continue;
    if (scope.occurredBefore && effectiveTime > scope.occurredBefore) continue;
    if (excludeKinds.has(memory.provenance.kind)) continue;
    filteredCandidates.push({ memory, distance: distanceById.get(hit.memoryId) ?? hit.distance });
  }

  // -------------------------------------------------------------------
  // 段2: 再スコア（索引不要。docs/recall.md §2 段2・§7）
  // -------------------------------------------------------------------
  const queryTags = validatedQuery.tags ?? [];
  const scored: ScoredCandidate[] = filteredCandidates.map(({ memory, distance }) => {
    const similarity = 1 - distance;
    const score = defaultScoringStrategy({
      now,
      similarity,
      tags: memory.tags,
      queryTags,
      occurredAt: memory.occurredAt,
      recordedAt: memory.recordedAt,
      lastReinforcedAt: memory.lastReinforcedAt,
      strength: memory.strength,
      halfLifeHours: memory.halfLifeHours,
    });
    return { memory, retrievedVia: "ann" as const, score };
  });
  scored.sort((a, b) => b.score.total - a.score.total);

  const scoreThreshold = validatedQuery.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD;
  const passed = scored.filter((c) => c.score.total >= scoreThreshold);
  const belowThreshold = scored.filter((c) => c.score.total < scoreThreshold);

  if (belowThreshold.length > 0) {
    omitted.push({
      kind: "below_threshold",
      count: belowThreshold.length,
      countKind: "exact",
      nearMisses: belowThreshold
        .slice(0, 5)
        .map((c) => ({ memoryId: c.memory.id, score: c.score.total })),
    });
  }

  const withinLimit = passed.slice(0, limit);
  const overLimit = passed.slice(limit);
  if (overLimit.length > 0) {
    omitted.push({ kind: "over_limit", count: overLimit.length, countKind: "exact" });
  }

  stages.push({
    stage: "rescore",
    executed: filteredCandidates.length > 0,
    detail: {
      scored: scored.length,
      passedThreshold: passed.length,
      withinLimit: withinLimit.length,
    },
  });

  // -------------------------------------------------------------------
  // 段3: 矛盾の解決と必須の同伴取得（docs/recall.md §2 段3・§8）
  // -------------------------------------------------------------------
  const presentIds = new Set(withinLimit.map((c) => c.memory.id));
  const contestedNeedingCompanion = withinLimit.filter(
    (c) =>
      c.memory.status === "contested" &&
      c.memory.contestedWithId &&
      !presentIds.has(c.memory.contestedWithId),
  );
  const companionIds = [
    ...new Set(
      contestedNeedingCompanion
        .map((c) => c.memory.contestedWithId)
        .filter((id): id is MemoryId => id !== null && id !== undefined),
    ),
  ];

  const companions: ScoredCandidate[] =
    companionIds.length > 0
      ? (await deps.memoryStore.getMany(ctx, companionIds)).map((companionMemory) => {
          const owner = contestedNeedingCompanion.find(
            (c) => c.memory.contestedWithId === companionMemory.id,
          );
          const score = defaultScoringStrategy({
            now,
            tags: companionMemory.tags,
            queryTags,
            occurredAt: companionMemory.occurredAt,
            recordedAt: companionMemory.recordedAt,
            lastReinforcedAt: companionMemory.lastReinforcedAt,
            strength: companionMemory.strength,
            halfLifeHours: companionMemory.halfLifeHours,
          });
          return {
            memory: companionMemory,
            retrievedVia: "mandatory_companion" as const,
            companionOf: owner?.memory.id,
            score,
          };
        })
      : [];

  stages.push({
    stage: "contradiction_resolution",
    executed: true,
    detail: { companionsAdded: companions.length },
  });

  // -------------------------------------------------------------------
  // 隣接性の不変条件（docs/memory-model.md §5 機構3）: 対向関係にある Memory は
  // 提示順で必ず隣接させる。ここで「単位（Unit）」を組み、budget 切り詰め（段4）は
  // 単位ごとに行う——ペアを分割しない（docs/recall.md §8）。
  // -------------------------------------------------------------------
  const allCandidates = [...withinLimit, ...companions];
  const byId = new Map(allCandidates.map((c) => [c.memory.id, c]));
  const consumed = new Set<MemoryId>();
  const units: Unit[] = [];
  for (const candidate of withinLimit) {
    if (consumed.has(candidate.memory.id)) continue;
    consumed.add(candidate.memory.id);
    const companionId = candidate.memory.contestedWithId;
    const companion = companionId && !consumed.has(companionId) ? byId.get(companionId) : undefined;
    if (companion && companion.retrievedVia === "mandatory_companion") {
      consumed.add(companion.memory.id);
      units.push({ members: [candidate, companion], rankScore: candidate.score.total });
    } else if (companion) {
      // 両側とも独立に withinLimit に含まれていたケース。まだ処理していなければペアにする。
      consumed.add(companion.memory.id);
      units.push({
        members: [candidate, companion],
        rankScore: Math.max(candidate.score.total, companion.score.total),
      });
    } else {
      units.push({ members: [candidate], rankScore: candidate.score.total });
    }
  }
  units.sort((a, b) => b.rankScore - a.rankScore);

  // -------------------------------------------------------------------
  // 段4: 予算による切り詰め（docs/recall.md §2 段4・§8）
  // -------------------------------------------------------------------
  const budget = validatedQuery.budget;
  let keptUnits = units;
  if (budget) {
    const maxMemoryChars = budget.maxMemoryChars;
    const maxTokens = effectiveTokenBudget(budget);
    const fits = (candidateUnits: Unit[]): boolean => {
      if (maxMemoryChars !== undefined) {
        const chars = candidateUnits.reduce((sum, u) => sum + unitChars(u), 0);
        if (chars > maxMemoryChars) return false;
      }
      if (maxTokens !== undefined) {
        const tokens = candidateUnits.reduce((sum, u) => sum + unitTokens(u, deps.tokenCounter), 0);
        if (tokens > maxTokens) return false;
      }
      return true;
    };
    let cut = units.length;
    while (cut > 0 && !fits(units.slice(0, cut))) {
      cut -= 1;
    }
    keptUnits = units.slice(0, cut);
    const droppedUnits = units.slice(cut);
    const droppedCount = droppedUnits.reduce((sum, u) => sum + u.members.length, 0);
    if (droppedCount > 0) {
      omitted.push({ kind: "budget_dropped", count: droppedCount, countKind: "exact" });
    }
  }

  stages.push({
    stage: "budget_truncation",
    executed: true,
    detail: { budgetApplied: budget !== undefined, unitsKept: keptUnits.length },
  });

  const finalMemories: RecalledMemory[] = keptUnits.flatMap((unit) =>
    unit.members.map((member) => {
      const recalled: RecalledMemory = {
        memoryId: member.memory.id,
        digest: member.memory.digest,
        retrievedVia: member.retrievedVia,
        score: member.score,
      };
      if (member.companionOf !== undefined) {
        recalled.companionOf = member.companionOf;
      }
      return recalled;
    }),
  );

  // -------------------------------------------------------------------
  // 段5: 目次帯の構築（索引: 集約クエリ。docs/recall.md §2 段5・§5）
  // -------------------------------------------------------------------
  const aggregate = await deps.memoryStore.aggregateScope(ctx, scope);
  const indexBand: IndexBand = {
    groups: aggregate.groups,
    totalInScope: aggregate.totalInScope,
    countKind: aggregate.countKind,
    // digestBand は Phase 2。Phase 1 では常に undefined（docs/recall.md §5）。
  };
  stages.push({
    stage: "index_band",
    executed: true,
    detail: { totalInScope: aggregate.totalInScope },
  });

  if (aggregate.filteredArchived.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "archived",
      count: aggregate.filteredArchived.count,
      countKind: aggregate.filteredArchived.countKind,
    });
  }
  // superseded と forgotten を別々に push する（ADR 0027）。前者は機構の都合
  // （より良い抽出に置き換えられた。置き換え先を持つ）、後者は製品の振る舞い
  // （利用者が意図して忘れさせた。置き換え先を持たない）——束ねると次の一手が
  // 判定できなくなる。
  if (aggregate.filteredSuperseded.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "superseded",
      count: aggregate.filteredSuperseded.count,
      countKind: aggregate.filteredSuperseded.countKind,
    });
  }
  if (aggregate.filteredForgotten.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "forgotten",
      count: aggregate.filteredForgotten.count,
      countKind: aggregate.filteredForgotten.countKind,
    });
  }
  if (aggregate.filteredPeriod.count > 0) {
    omitted.push({
      kind: "filtered",
      condition: "period",
      count: aggregate.filteredPeriod.count,
      countKind: aggregate.filteredPeriod.countKind,
    });
  }
  // 理由ごとに1件ずつ返す（`filtered` の `condition` と同じ形）。
  // 一時的な遅延（pending）と恒久的な失敗（failed）と意図した除外（skipped）を
  // 1つに潰さない——ADR 0008 の判定基準（次の一手が変わるか）による。
  for (const reason of NOT_INDEXED_REASONS) {
    const entry = aggregate.notIndexed[reason];
    if (entry.count > 0) {
      omitted.push({
        kind: "not_indexed",
        reason,
        count: entry.count,
        countKind: entry.countKind,
      });
    }
  }

  // -------------------------------------------------------------------
  // ann_unreached（ADR 0025 の実測、ADR 0026 の決定）: 「近似索引がこの scope に
  // 届かなかった」ことが `omitted` に一度も出ない、という ADR 0008 の破れを埋める。
  //
  // **⚠ ここは段5（`aggregate`）に依存する。** `eligible`（= scope 内で埋め込みがあり
  // ANN の候補になり得た件数）は段1の情報だけでは出せない——`aggregate.totalInScope` と
  // `aggregate.notIndexed` が要る。この関数には早期 return が無く、段5は常にここに
  // 到達する前に実行されている（`aggregate` は必ず存在する。§報告のとおり確認済み）。
  // **もし将来、段5をスキップする経路が実装されたら、この判定はそこでは行えない
  // ——「取りこぼしたかもしれない」と断言する根拠（eligible）が無いため、鳴らさないこと。**
  const notIndexedTotal =
    aggregate.notIndexed.pending.count +
    aggregate.notIndexed.failed.count +
    aggregate.notIndexed.skipped.count;
  const eligible = aggregate.totalInScope - notIndexedTotal;
  if (
    candidateGenerationExecuted &&
    kPrime > 0 &&
    // k' に達していない。達していれば ann_truncated の領域であり、これと同時には立てない
    // ——「打ち切り」（もっと在るはずだが LIMIT で切った）と「届かなかった」（scope の他所へ
    // ANN が行ってしまった）は別の出来事だから、同じ札に相乗りさせない（ADR 0026）。
    annHits.length < kPrime &&
    // scope 内にまだ見られていない候補が残っている。
    // ⚠ この条件を落とすと、小さい subject で候補が ANN に全部返った場合
    // （例: 候補3件・kPrime 40・hits 3。3 < 40 だが 3 == eligible）にも常に鳴るようになる
    // ——「鳴ってはいけない側」を守っているのはこの条件である。
    annHits.length < eligible
  ) {
    omitted.push({ kind: "ann_unreached", countKind: "unknown" });
  }

  // -------------------------------------------------------------------
  // usage（docs/recall.md §6）: 計測と強制を混同しない——強制は段4で既に行った。
  // ここでは実際に返した量を測るだけ。
  // -------------------------------------------------------------------
  const digestChars = finalMemories.reduce((sum, m) => sum + m.digest.length, 0);
  const indexBandText = JSON.stringify(indexBand);
  const indexChars = indexBandText.length;
  const totalChars = digestChars + indexChars;
  const memoryTokens = deps.tokenCounter.count(finalMemories.map((m) => m.digest).join("\n"));
  const tokenCount = deps.tokenCounter.count(
    finalMemories.map((m) => m.digest).join("\n") + indexBandText,
  );

  // share の分子は **memories tier だけ**である（目次帯を含めない）。
  //
  // 目次帯は budget の対象外なので（RecallBudget の doc 参照）、分子に含めると
  // 「予算の何割を使ったか」という問いに対して、予算が縛っていない量まで数えることになり、
  // 100% を超える——実際に 248% という「割合として成立しない値」が出ていた。
  // 段4の切り詰めが memories tier を予算内に収めることを保証しているので、
  // 分子を memories tier に限れば share は 1 を超えない。
  //
  // 「この応答は全体でいくらかかったか」は別の問いであり、`chars` と `indexChars` が答える。
  const tokenBudget = effectiveTokenBudget(budget);
  const usageShareDenominator = tokenBudget ?? budget?.maxMemoryChars;
  const usageShareNumerator = tokenBudget !== undefined ? memoryTokens.tokens : digestChars;
  const usage = {
    chars: totalChars,
    estimatedTokens: tokenCount.tokens,
    counter: tokenCount.counter,
    byTier: { full: 0, digest: digestChars, index: indexChars },
    indexChars,
    ...(usageShareDenominator !== undefined
      ? { share: usageShareNumerator / usageShareDenominator }
      : {}),
  };

  // -------------------------------------------------------------------
  // 段6: 記録（docs/recall.md §2 段6、ADR 0008）。必須の段。
  //
  // `stages` に 'record' 自身のトレースを、実際に書き込む**前**に積む——「記録した」ことを
  // 記録するには、記録が起きたという前提を先に確定する必要がある（この呼び出しが
  // 例外を投げれば `recall()` 自体が例外で終わるため、`explain.stages` が「記録した」と
  // 嘘をついたまま呼び出し側に届くことはない）。
  // -------------------------------------------------------------------
  stages.push({ stage: "record", executed: true });
  const recallId = await deps.memoryStore.createRecall(ctx, {
    tenantId: ctx.tenantId,
    subjectId: ctx.subjectId ?? null,
    query: validatedQuery,
    budget: budget ?? null,
    omitted,
    usage,
    indexBand,
    explain: { stages },
    returnedMemoryIds: finalMemories.map((m) => m.memoryId),
  });

  return {
    recallId,
    memories: finalMemories,
    omitted,
    index: indexBand,
    usage,
    explain: { stages },
  };
}
