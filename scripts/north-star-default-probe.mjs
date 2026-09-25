#!/usr/bin/env node
/**
 * 北極星「目指す姿」7項目の既定差分を、ワークスペース内から組んだ `Runtime` に対して
 * 観測し、Job Summary 向けの一覧を印字する（Issue #387 / ADR 0216 決定7「段1」）。
 *
 * ## これは何をする道具か
 *
 * `@mnemora/core` と `@mnemora/testkit`（`./fixtures` 入口を含む）の**公開入口だけ**を
 * import し、in-memory ストア + `DeterministicLLMProvider`/`DeterministicEmbeddingProvider` +
 * 注入した `Clock` + `node:crypto` の `hashContent` で `Runtime` を組む（ADR 0216 測定4）。
 * DB・API キー・ネットワークは一切使わない。
 *
 * - 甲（既定で起きること。項目1・2・5・6）: 「何も渡さない呼び出し」と「明示的に渡した
 *   呼び出し」の**差**を観測する（ADR 0216 決定2）。
 * - 乙（使う側が渡せることが充足。項目7）: budget 未指定で `budgetApplied:false` か、
 *   指定すると実際に落ちるかだけを見る。**既定の向きは当てない**（ADR 0216 決定3）。
 * - 丙（採用者が外の情報を渡すことを前提にする。項目3・4）: **実行しない。**「配線か・
 *   データか・判定か」は意味の判定であり機械で測れない（ADR 0216 決定4）。
 *
 * ## これは何をしない道具か
 *
 * - ⛔ **判定しない。** 7項目の充足判定は `docs/roadmap.md` が正であり続ける
 *   （ADR 0216 決定8）。「差が出た/出なかった/観測に失敗した」という事実だけを書く。
 * - ⛔ **門ではない。常に exit 0。** 個々の観測を try/catch で包み、失敗は
 *   「印字に失敗した: <理由>」として一覧に出す。トップレベルの import 失敗も
 *   動的 import + 最上位の try/catch で握る。
 * - ⛔ **段1はワークスペース解決であり、出荷物（tarball）ではない。**`pnpm pack` で
 *   作った tarball を `/tmp` へ install して測る段2（ADR 0216 決定7・決定5）は、
 *   このスクリプトの範囲外。
 * - ⛔ **`packages/postgres` を1バイトも測らない**（ADR 0216 決定6）。
 *
 * ## 決定性のための細工（ADOPTER-SUPPLIED の対象外）
 *
 * 項目2・5・7 の一部は `VectorStore.upsert` で直接ベクトルを上書きし、
 * `DeterministicEmbeddingProvider` 自身のハッシュ挙動（文字コード和、意味を持たない）
 * には依存しない形でシナリオを組み立てている。これは probe が決定的な再現性を作るための
 * 試験用の配線であり、ADR 0216 決定4-2 の ADOPTER-SUPPLIED（採用者が実際に供給する
 * もの）の集計対象ではない——該当箇所にその旨をコメントで明記してある。
 *
 * 組み立ては `./north-star-default-probe-lib.mjs` の純関数（登録簿・正典との突き合わせ・
 * ADOPTER-SUPPLIED 集計・Markdown 組み立て）に委ねる（`association-summary.mjs` と
 * 同じ分担）。
 *
 * 使い方: `node scripts/north-star-default-probe.mjs`（標準出力へ Markdown を吐く）。
 * CI では `>> "$GITHUB_STEP_SUMMARY"` で Job Summary に流し込む。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NORTH_STAR_ITEM_REGISTRY,
  buildFatalFallbackMarkdown,
  buildRegistryReport,
  buildSummaryMarkdown,
  countAdopterSuppliedMarks,
  extractGoalStatements,
} from "./north-star-default-probe-lib.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(SCRIPT_PATH), "..");
const NORTH_STAR_PATH = join(REPO_ROOT, "docs", "north-star.md");

/** `packages/core/src/__tests__/runtime.test.ts` と同じ、操作上のリース長（測定対象の数ではない）。 */
const TEST_LEASE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function hashContent(content) {
  return createHash("sha256").update(content).digest("hex");
}

/** `@mnemora/testkit/fixtures` の5種のインメモリ・ストアを新しく組み立てる。 */
function buildStores(mods) {
  const memoryStore = new mods.InMemoryMemoryStore();
  const outboxStore = new mods.InMemoryOutboxStore(memoryStore.outboxJobs);
  const eventStore = new mods.InMemoryEventStore(memoryStore);
  const vectorStore = new mods.InMemoryVectorStore(memoryStore);
  const tenantSettingsStore = new mods.InMemoryTenantSettingsStore();
  return { memoryStore, outboxStore, eventStore, vectorStore, tenantSettingsStore };
}

/**
 * 項目ごとに独立した `Runtime` を組む。**ストアも Clock も項目間で共有しない**——時計を
 * 進める項目（項目1）が、他の項目の忘却ゲートへ影響しないようにするため。
 *
 * ⚠ **Clock は「上書きするまでは実時間を素通しする」形にする**（固定の過去/未来日付を
 * 最初から使わない）。理由: `@mnemora/testkit/fixtures` の `InMemoryMemoryStore`（outbox
 * ジョブの `availableAt`）は `Clock` を経由せず `new Date()`（実時間）で書く
 * （`in-memory-memory-store.ts`）。ここで `Clock` を実時間からかけ離れた固定値に
 * 差し替えてしまうと、`tick()` の `claimBatch` が `job.availableAt <= now` を判定する際に
 * 「作った直後のジョブなのに、注入した Clock 上ではまだ来ていない（または既に過ぎた）」
 * というズレが起き、embed ジョブが一向に処理されない——実際に手元でこれを踏んだ
 * （`FIXED_START` を2026-01-01固定にしていたときは `tick()` が常に `processed:0` だった）。
 * 「上書きするまでは実時間」にすることで、ジョブ生成・claim の両方が同じ時間軸に乗る。
 */
function buildIsolatedRuntime(mods, tenantId) {
  const stores = buildStores(mods);
  let override = null;
  const clock = { now: () => override ?? new Date() };
  const embeddingProvider = new mods.DeterministicEmbeddingProvider();
  const runtime = mods.createRuntime({
    ...stores,
    llmProvider: new mods.DeterministicLLMProvider(),
    embeddingProvider,
    clock,
    hashContent,
  });
  const ctx = { tenantId };
  return {
    runtime,
    ctx,
    stores,
    embeddingProvider,
    setNow: (date) => {
      override = date;
    },
  };
}

/**
 * 項目1（甲）「言ったことを、次の日も覚えている」。
 * observe() 直後の recall() と、Memory 自身の `decayFloorAt` を1日過ぎた時点まで
 * Clock を進めた後の recall() を比べる（ADR 0216 決定2）。
 */
async function runItem1(mods) {
  // ADOPTER-SUPPLIED(item1): 配線 — hashContent と in-memory ストアの構築だけを供給する。
  const { runtime, ctx, stores, setNow } = buildIsolatedRuntime(mods, "north-star-probe-item1");
  const text = "北極星段1 probe（item1）: 出張の予定を伝えた";
  const observeResult = await runtime.observe(ctx, { kind: "utterance", text });
  const memoryId = observeResult.memoryIds[0];
  if (!memoryId) {
    return {
      fact:
        "observe() が Memory を1件も作らなかった（DeterministicLLMProvider の抽出結果が" +
        "空だった）ため、以降を観測できなかった。",
    };
  }
  await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

  const before = await runtime.recall(ctx, { text });
  const returnedBefore = before.memories.some((m) => m.memoryId === memoryId);

  const memory = await stores.memoryStore.get(ctx, memoryId);
  const decayFloorAt = memory?.decayFloorAt;
  if (!decayFloorAt) {
    return {
      fact:
        `observe() 直後の recall() は${returnedBefore ? "返った" : "返らなかった"}。` +
        "ただし Memory.decayFloorAt が読めなかったため、時間経過後の観測はできなかった。",
    };
  }

  // Memory 自身が書き込み時に計算した忘却の床（`strategies/decay.ts` の
  // `defaultDecayStrategy.floorAt`。既定 halfLifeHours=720 と DEFAULT_DECAY_THRESHOLD=0.05
  // から導かれる）を、この Memory の実測値そのものから読んで1日過ぎた時点まで、注入した
  // Clock を進める——式を再計算せず、Memory が既に計算し終えた値をそのまま使う。
  // 実時間は待たない（ADR 0216 測定4）。
  setNow(new Date(decayFloorAt.getTime() + ONE_DAY_MS));

  const after = await runtime.recall(ctx, { text });
  const returnedAfter = after.memories.some((m) => m.memoryId === memoryId);

  const verdict =
    returnedBefore && !returnedAfter
      ? "差が出た（既定で沈むことを観測できた）"
      : returnedBefore === returnedAfter
        ? "差が出なかった"
        : "差は出たが、想定と逆方向だった（observe直後には返らず、時間経過後に返った）";

  return {
    fact:
      `observe() 直後の recall({ text }) は${returnedBefore ? "返った" : "返らなかった"}。` +
      "同じ Memory の decayFloorAt を1日過ぎた時点まで Clock を進めて同じ recall() を" +
      `呼ぶと${returnedAfter ? "返った" : "返らなかった"}。⟹ ${verdict}。`,
  };
}

/**
 * 項目2（甲）「聞かれていないことを、自分から思い出す」。
 * `recall({ vector, limit:1 })` と、`association: { maxCount: 10 }` を渡した recall の差
 * （ADR 0216 決定2）。
 */
async function runItem2(mods) {
  // ADOPTER-SUPPLIED(item2): 配線 — hashContent と in-memory ストアの構築だけを供給する。
  const { runtime, ctx, stores, embeddingProvider } = buildIsolatedRuntime(
    mods,
    "north-star-probe-item2",
  );
  const anchorObserve = await runtime.observe(ctx, {
    kind: "utterance",
    text: "北極星段1 probe（item2）: アンカー記憶",
  });
  const neighborObserve = await runtime.observe(ctx, {
    kind: "utterance",
    text: "北極星段1 probe（item2）: 連想候補記憶",
  });
  const anchorId = anchorObserve.memoryIds[0];
  const neighborId = neighborObserve.memoryIds[0];
  if (!anchorId || !neighborId) {
    return { fact: "observe() が2件の Memory を作れなかったため、この項目は観測できなかった。" };
  }
  await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

  // 決定性のための試験用配線（ADOPTER-SUPPLIED の対象ではない——採用者が本来供給する
  // ものではなく、probe が再現可能にするための細工）。`DeterministicEmbeddingProvider`
  // 自身のハッシュ挙動（文字コード和）には依存させず、2件のベクトルを直接上書きして
  // コサイン類似度を 0.9（連想枠の既定 minSimilarity=0.5 より確実に高い）に固定する。
  const space = embeddingProvider.space;
  const anchorVector = new Array(space.dimensions).fill(0);
  anchorVector[0] = 1;
  const neighborVector = new Array(space.dimensions).fill(0);
  neighborVector[0] = 0.9;
  neighborVector[1] = Math.sqrt(1 - 0.9 * 0.9);
  await stores.vectorStore.upsert(ctx, space, anchorId, anchorVector);
  await stores.vectorStore.upsert(ctx, space, neighborId, neighborVector);

  const withoutAssociation = await runtime.recall(ctx, { vector: anchorVector, limit: 1 });
  const withAssociation = await runtime.recall(ctx, {
    vector: anchorVector,
    limit: 1,
    // ADOPTER-SUPPLIED(item2): データ — maxCount は採用者が決める量。mnemora の既定は
    // association 省略＝連想を一切走らせない（ADR 0216 候補6の表・項目2「設定」）。
    association: { maxCount: 10 },
  });

  const idsWithout = new Set(withoutAssociation.memories.map((m) => m.memoryId));
  const idsWith = new Set(withAssociation.memories.map((m) => m.memoryId));
  const neighborOnlyViaAssociation = !idsWithout.has(neighborId) && idsWith.has(neighborId);
  const neighborInAssociation = withAssociation.memories.find((m) => m.memoryId === neighborId);

  const verdict = neighborOnlyViaAssociation
    ? "差が出た（連想枠だけが拾った）"
    : idsWithout.size === idsWith.size
      ? "差が出なかった"
      : "差は出たが、近傍記憶は既定側でも既に返っていた";

  return {
    fact:
      `既定の recall({ vector, limit:1 }) は${idsWithout.size}件返し、近傍記憶（アンカーと` +
      `コサイン類似度0.9に固定した Memory）は${idsWithout.has(neighborId) ? "含まれた" : "含まれなかった"}。` +
      `同じクエリに association:{ maxCount:10 } を足すと${idsWith.size}件返し、近傍記憶は` +
      `${idsWith.has(neighborId) ? "含まれた" : "含まれなかった"}` +
      `（含まれた場合の retrievedVia: ${neighborInAssociation?.retrievedVia ?? "該当なし"}）。` +
      `⟹ ${verdict}。`,
  };
}

/**
 * 項目5（甲）「間違いを正すと、古いほうが先に出てこなくなる」。
 * observe(A) → observe(A′、矛盾する内容) → **既定経路**（markContested / resolveContested /
 * applyCorrection は一切呼ばない）の recall() で A が返るか（ADR 0216 決定2）。
 */
async function runItem5(mods) {
  // ADOPTER-SUPPLIED(item5): 配線 — hashContent と in-memory ストアの構築だけを供給する。
  // markContested/resolveContested/applyCorrection は一切呼ばない——既定経路だけを見る。
  const { runtime, ctx, stores, embeddingProvider } = buildIsolatedRuntime(
    mods,
    "north-star-probe-item5",
  );
  const original = await runtime.observe(ctx, {
    kind: "utterance",
    text: "北極星段1 probe（item5）: 田中さんの誕生日は3月です",
  });
  const originalId = original.memoryIds[0];
  if (!originalId) {
    return { fact: "1件目の observe() が Memory を作らなかったため、この項目は観測できなかった。" };
  }
  await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

  // 決定性のための試験用配線（ADOPTER-SUPPLIED の対象ではない）: 「Aが消えたか」の判定を
  // 埋め込み表現の巧拙から切り離すため、Memory のベクトルを固定のクエリベクトルへ強制的に
  // 揃える。
  const space = embeddingProvider.space;
  const queryVector = new Array(space.dimensions).fill(0);
  queryVector[0] = 1;
  await stores.vectorStore.upsert(ctx, space, originalId, queryVector);

  const before = await runtime.recall(ctx, { vector: queryVector, limit: 10 });
  const originalReturnedBefore = before.memories.some((m) => m.memoryId === originalId);

  const correction = await runtime.observe(ctx, {
    kind: "utterance",
    text: "北極星段1 probe（item5）: 田中さんの誕生日は5月です",
  });
  const correctionId = correction.memoryIds[0];
  if (correctionId) {
    await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });
    await stores.vectorStore.upsert(ctx, space, correctionId, queryVector);
  }

  const after = await runtime.recall(ctx, { vector: queryVector, limit: 10 });
  const originalReturnedAfter = after.memories.some((m) => m.memoryId === originalId);

  const verdict =
    originalReturnedBefore === originalReturnedAfter
      ? "差が出なかった（古い方は既定経路では退場しない）"
      : "差が出た（古い方が既定経路でも退場した）";

  return {
    fact:
      `矛盾する内容の2件目を observe() する前、古い方（A）を含む recall() は` +
      `${originalReturnedBefore ? "返った" : "返らなかった"}。2件目を observe() した後（` +
      "markContested/resolveContested/applyCorrection は一切呼んでいない既定経路のまま）、" +
      `同じクエリで A は${originalReturnedAfter ? "返った" : "返らなかった"}。⟹ ${verdict}。` +
      "注: 明示操作 applyCorrection（ADR 0242、docs/roadmap.md §7.15）を使う経路は、この" +
      "段では測っていない。",
  };
}

/**
 * 項目6（甲）「知らないことを、知らないと言える」。
 * `result.omitted` が空でないか。`Omission.kind`（11種の union）の型網羅は実行時には
 * 測れないため、この段では測らない（ADR 0216 決定2、決定4-2と同じ「載せない」明記の規律）。
 */
async function runItem6(mods) {
  // ADOPTER-SUPPLIED(item6): 配線 — 何も渡さない（recall(ctx, {}) を呼ぶだけ）。
  const { runtime, ctx } = buildIsolatedRuntime(mods, "north-star-probe-item6");
  const result = await runtime.recall(ctx, {});
  const nonEmpty = result.omitted.length > 0;
  const kinds = [...new Set(result.omitted.map((o) => o.kind))];
  return {
    fact:
      "text も vector も渡さない recall(ctx, {}) の result.omitted は" +
      `${nonEmpty ? `空でなかった（このprobeで実際に現れた種別: ${kinds.join(", ")}）` : "空だった"}。` +
      "⛔ `Omission.kind` は11種の union だが、このprobeは実行時にその全種の生成箇所を" +
      "数えていない——型の網羅はこの段では測らない（この段では測らないと正直に書く）。",
  };
}

/**
 * 項目7（乙）「どれだけ載せるかを、使う側が決められる」。
 * budget 未指定で `budgetApplied:false` か、指定すると実際に落ちるかだけを見る。
 * **既定の向きは当てない**（ADR 0216 決定3）。
 */
async function runItem7(mods) {
  // ADOPTER-SUPPLIED(item7): 配線 — 1件目・2件目とも hashContent とストア構築だけ。
  const { runtime, ctx, stores, embeddingProvider } = buildIsolatedRuntime(
    mods,
    "north-star-probe-item7",
  );
  const longText1 = "北極星段1 probe（item7・記憶1）: " + "あ".repeat(200);
  const longText2 = "北極星段1 probe（item7・記憶2）: " + "い".repeat(200);
  const m1 = await runtime.observe(ctx, { kind: "utterance", text: longText1 });
  const m2 = await runtime.observe(ctx, { kind: "utterance", text: longText2 });
  const id1 = m1.memoryIds[0];
  const id2 = m2.memoryIds[0];
  if (!id1 || !id2) {
    return { fact: "observe() が2件の Memory を作れなかったため、この項目は観測できなかった。" };
  }
  await runtime.tick(ctx, { kinds: ["embed"], leaseMs: TEST_LEASE_MS });

  // 決定性のための試験用配線（ADOPTER-SUPPLIED の対象ではない）。
  const space = embeddingProvider.space;
  const queryVector = new Array(space.dimensions).fill(0);
  queryVector[0] = 1;
  await stores.vectorStore.upsert(ctx, space, id1, queryVector);
  await stores.vectorStore.upsert(ctx, space, id2, queryVector);

  const noBudget = await runtime.recall(ctx, { vector: queryVector, limit: 10 });
  const noBudgetTrace = noBudget.explain.stages.find((s) => s.stage === "budget_truncation");
  const noBudgetApplied = noBudgetTrace?.detail?.budgetApplied;

  const withBudget = await runtime.recall(ctx, {
    vector: queryVector,
    limit: 10,
    // ADOPTER-SUPPLIED(item7): データ — maxMemoryChars は採用者にしか無い「どれだけ載せ
    // たいか」の意思（ADR 0216 候補6の表・項目7）。ここでは差を確実に起こすため極端に
    // 小さい値（1文字）を渡す——既定の向きは当てない（ADR 0216 決定3）。
    budget: { maxMemoryChars: 1 },
  });
  const withBudgetTrace = withBudget.explain.stages.find((s) => s.stage === "budget_truncation");
  const withBudgetApplied = withBudgetTrace?.detail?.budgetApplied;
  const droppedSomething =
    withBudget.memories.length < noBudget.memories.length ||
    withBudget.omitted.some((o) => o.kind === "budget_dropped");

  return {
    fact:
      "budget を渡さない recall() の explain.stages（budget_truncation）.detail.budgetApplied" +
      ` は ${String(noBudgetApplied)}。budget:{ maxMemoryChars:1 } を渡すと budgetApplied は` +
      ` ${String(withBudgetApplied)} になり、返った memories は ${noBudget.memories.length}件` +
      `→${withBudget.memories.length}件（実際に切り詰めが${droppedSomething ? "起きた" : "起きなかった"}）。` +
      "⛔ 既定の向き（既定で切り詰めないことが充足）はこの観測からは判定しない（ADR 0216 決定3）。",
  };
}

/** 1項目ぶんの観測を try/catch で包む。**個別の失敗が全体を止めない**（AGENTS.md）。 */
async function runItemSafe(item, fn, mods) {
  try {
    const { fact } = await fn(mods);
    return { item, mode: "measured", fact };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { item, mode: "print-failed", fact: `印字に失敗した: ${message}` };
  }
}

async function main() {
  let markdown;
  try {
    let canonError = null;
    let statements = [];
    try {
      const northStarText = readFileSync(NORTH_STAR_PATH, "utf8");
      const extracted = extractGoalStatements(northStarText);
      if (extracted.ok) {
        statements = extracted.statements;
      } else {
        canonError = extracted.error;
      }
    } catch (error) {
      canonError = `docs/north-star.md を読めなかった: ${error instanceof Error ? error.message : String(error)}`;
    }
    const registryReport = buildRegistryReport(statements, NORTH_STAR_ITEM_REGISTRY);

    // 公開入口だけを動的 import する——ここで失敗しても（例: ワークスペースを
    // build していない）、トップレベルの catch が拾って exit 0 のまま Markdown を出す。
    const [core, testkit, fixtures] = await Promise.all([
      import("@mnemora/core"),
      import("@mnemora/testkit"),
      import("@mnemora/testkit/fixtures"),
    ]);
    const mods = {
      createRuntime: core.createRuntime,
      DeterministicLLMProvider: testkit.DeterministicLLMProvider,
      DeterministicEmbeddingProvider: testkit.DeterministicEmbeddingProvider,
      InMemoryMemoryStore: fixtures.InMemoryMemoryStore,
      InMemoryVectorStore: fixtures.InMemoryVectorStore,
      InMemoryEventStore: fixtures.InMemoryEventStore,
      InMemoryOutboxStore: fixtures.InMemoryOutboxStore,
      InMemoryTenantSettingsStore: fixtures.InMemoryTenantSettingsStore,
    };

    const itemResults = [
      await runItemSafe(1, runItem1, mods),
      await runItemSafe(2, runItem2, mods),
      {
        item: 3,
        mode: "not-measured",
        fact:
          "機械に載せない（ADR 0216 決定4）。採用者が供給するのは「後から説明できる」の" +
          "読み戻す口（`getRecall`）を呼ぶことだけであり、それが配線か・データか・判定かの" +
          "意味判定は grep でも型検査でも出ない。人手の監査は `docs/roadmap.md` §7.4 の" +
          "表が持つ。",
      },
      {
        item: 4,
        mode: "not-measured",
        fact:
          "機械に載せない（ADR 0216 決定4）。「使われない記憶が、静かに遠ざかる」の対比は" +
          "使用報告（`usedMemoryIds`）という mnemora が原理的に持てない情報に依存し、意味の" +
          "判定を要する。人手の監査は `docs/roadmap.md` §7.4 の表が持つ。",
      },
      await runItemSafe(5, runItem5, mods),
      await runItemSafe(6, runItem6, mods),
      await runItemSafe(7, runItem7, mods),
    ];

    const sourceText = readFileSync(SCRIPT_PATH, "utf8");
    const adopterSuppliedTally = countAdopterSuppliedMarks(sourceText);

    markdown = buildSummaryMarkdown({
      registryReport,
      canonError,
      itemResults,
      adopterSuppliedTally,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    markdown = buildFatalFallbackMarkdown(error);
  }
  console.log(markdown);
}

await main();
// **明示的に 0 を宣言する**——個々の観測が失敗していても、ここまで来たら
// トップレベルの制御は壊れていない。このスクリプトは門ではない（ADR 0216 決定7）。
process.exit(0);
