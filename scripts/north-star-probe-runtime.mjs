/**
 * 北極星「目指す姿」7項目の既定差分を、渡された `@mnemora/*` のモジュール（`mods`）から
 * `Runtime` を組んで観測する、**段1・段2で共有する**probe ロジック（Issue #387 /
 * ADR 0216 決定7）。
 *
 * ## なぜ切り出したか
 *
 * ADR 0216 決定7は、観測を2段に分けている:
 *
 * - 段1（`north-star-default-probe.mjs`）: ワークスペース内から `@mnemora/core` /
 *   `@mnemora/testkit` を import して組む（毎 PR、`build` ジョブに相乗り）。
 * - 段2（`north-star-tarball-probe.mjs`）: `pnpm pack` した tarball を `npm install` した
 *   先から import して組む（手動起動）。
 *
 * **観測する項目・観測のやり方（何を渡さない呼び出しと何を渡した呼び出しの差を見るか）は
 * 両段で同一であるべきである**——違うのは「`mods`（`createRuntime` 等）をどこから
 * import したか」だけ。この前提が崩れる（=段1と段2で別のロジックを書く）と、
 * 「段1は通ったのに段2は落ちた」の差が、probe 自体の実装差なのか、workspace解決と
 * tarball解決の差なのかが分からなくなる。**だからこのファイルは複製せず、共有する。**
 *
 * このファイルは `mods`（`createRuntime` / `DeterministicLLMProvider` /
 * `DeterministicEmbeddingProvider` / `InMemory*Store` の5種）を受け取るだけで、
 * それをどう import したか（workspace か、tarball を install した先か）を一切知らない。
 * ⛔ **このファイル自身は `@mnemora/*` を1つも import しない。**
 *
 * ⛔ **判定しない。** 差が出た/出なかった/観測に失敗した、という事実だけを文字列で返す。
 * ⛔ **例外を外へ投げない。** `runItemSafe`/`runAllNorthStarItems` が個々の観測を
 * try/catch で包む——1項目の失敗が他の項目・呼び出し元全体を止めない。
 */

/** `packages/core/src/__tests__/runtime.test.ts` と同じ、操作上のリース長（測定対象の数ではない）。 */
const TEST_LEASE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** node:crypto を渡さずに済むよう、呼び出し側の環境で使える hash だけに依存する。 */
export function makeHashContent(createHash) {
  return (content) => createHash("sha256").update(content).digest("hex");
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
export function buildIsolatedRuntime(mods, tenantId, hashContent) {
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
export async function runItem1(mods, hashContent) {
  // ADOPTER-SUPPLIED(item1): 配線 — hashContent と in-memory ストアの構築だけを供給する。
  const { runtime, ctx, stores, setNow } = buildIsolatedRuntime(
    mods,
    "north-star-probe-item1",
    hashContent,
  );
  const text = "北極星probe（item1）: 出張の予定を伝えた";
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
export async function runItem2(mods, hashContent) {
  // ADOPTER-SUPPLIED(item2): 配線 — hashContent と in-memory ストアの構築だけを供給する。
  const { runtime, ctx, stores, embeddingProvider } = buildIsolatedRuntime(
    mods,
    "north-star-probe-item2",
    hashContent,
  );
  const anchorObserve = await runtime.observe(ctx, {
    kind: "utterance",
    text: "北極星probe（item2）: アンカー記憶",
  });
  const neighborObserve = await runtime.observe(ctx, {
    kind: "utterance",
    text: "北極星probe（item2）: 連想候補記憶",
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
export async function runItem5(mods, hashContent) {
  // ADOPTER-SUPPLIED(item5): 配線 — hashContent と in-memory ストアの構築だけを供給する。
  // markContested/resolveContested/applyCorrection は一切呼ばない——既定経路だけを見る。
  const { runtime, ctx, stores, embeddingProvider } = buildIsolatedRuntime(
    mods,
    "north-star-probe-item5",
    hashContent,
  );
  const original = await runtime.observe(ctx, {
    kind: "utterance",
    text: "北極星probe（item5）: 田中さんの誕生日は3月です",
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
    text: "北極星probe（item5）: 田中さんの誕生日は5月です",
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
      "probe では測っていない。",
  };
}

/**
 * 項目6（甲）「知らないことを、知らないと言える」。
 * `result.omitted` が空でないか。`Omission.kind`（11種の union）の型網羅は実行時には
 * 測れないため、このprobeでは測らない（ADR 0216 決定2、決定4-2と同じ「載せない」明記の規律）。
 */
export async function runItem6(mods, hashContent) {
  // ADOPTER-SUPPLIED(item6): 配線 — 何も渡さない（recall(ctx, {}) を呼ぶだけ）。
  const { runtime, ctx } = buildIsolatedRuntime(mods, "north-star-probe-item6", hashContent);
  const result = await runtime.recall(ctx, {});
  const nonEmpty = result.omitted.length > 0;
  const kinds = [...new Set(result.omitted.map((o) => o.kind))];
  return {
    fact:
      "text も vector も渡さない recall(ctx, {}) の result.omitted は" +
      `${nonEmpty ? `空でなかった（このprobeで実際に現れた種別: ${kinds.join(", ")}）` : "空だった"}。` +
      "⛔ `Omission.kind` は11種の union だが、このprobeは実行時にその全種の生成箇所を" +
      "数えていない——型の網羅はこのprobeでは測らない（このprobeでは測らないと正直に書く）。",
  };
}

/**
 * 項目7（乙）「どれだけ載せるかを、使う側が決められる」。
 * budget 未指定で `budgetApplied:false` か、指定すると実際に落ちるかだけを見る。
 * **既定の向きは当てない**（ADR 0216 決定3）。
 */
export async function runItem7(mods, hashContent) {
  // ADOPTER-SUPPLIED(item7): 配線 — 1件目・2件目とも hashContent とストア構築だけ。
  const { runtime, ctx, stores, embeddingProvider } = buildIsolatedRuntime(
    mods,
    "north-star-probe-item7",
    hashContent,
  );
  const longText1 = "北極星probe（item7・記憶1）: " + "あ".repeat(200);
  const longText2 = "北極星probe（item7・記憶2）: " + "い".repeat(200);
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
export async function runItemSafe(item, fn, mods, hashContent) {
  try {
    const { fact } = await fn(mods, hashContent);
    return { item, mode: "measured", fact };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { item, mode: "print-failed", fact: `印字に失敗した: ${message}` };
  }
}

/**
 * 項目3・4（丙）は機械に載せない（ADR 0216 決定4）。段1・段2 共通の固定文面。
 */
export function notMeasuredItemResults() {
  return [
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
  ];
}

/**
 * 7項目ぶんの `ItemResult` を一括で組み立てる。**段1・段2はこの関数を呼ぶだけ**——
 * 何をどう観測するかはここに集約し、複製しない。
 *
 * @param {object} mods `createRuntime` / `DeterministicLLMProvider` /
 *   `DeterministicEmbeddingProvider` / `InMemory*Store` の5種（呼び出し側が段ごとに
 *   別の場所から import して渡す）。
 * @param {(content: string) => string} hashContent
 */
export async function runAllNorthStarItems(mods, hashContent) {
  const [item3, item4] = notMeasuredItemResults();
  return [
    await runItemSafe(1, runItem1, mods, hashContent),
    await runItemSafe(2, runItem2, mods, hashContent),
    item3,
    item4,
    await runItemSafe(5, runItem5, mods, hashContent),
    await runItemSafe(6, runItem6, mods, hashContent),
    await runItemSafe(7, runItem7, mods, hashContent),
  ];
}
