/**
 * ⛔ 段1・段2で共有し、複製しない。別のロジックにすると、差が probe の実装差か解決の差か分からなくなる。
 * ⛔ このファイル自身は `@mnemora/*` を1つも import しない（`mods` を受け取るだけ）。
 * ⛔ 判定しない。例外を外へ投げない（1項目の失敗が他の項目を止めない）。
 */

const TEST_LEASE_MS = 60_000;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export function makeHashContent(createHash) {
  return (content) => createHash("sha256").update(content).digest("hex");
}

function buildStores(mods) {
  const memoryStore = new mods.InMemoryMemoryStore();
  const outboxStore = new mods.InMemoryOutboxStore(memoryStore.outboxJobs);
  const eventStore = new mods.InMemoryEventStore(memoryStore);
  const vectorStore = new mods.InMemoryVectorStore(memoryStore);
  const tenantSettingsStore = new mods.InMemoryTenantSettingsStore();
  return { memoryStore, outboxStore, eventStore, vectorStore, tenantSettingsStore };
}

/**
 * ⛔ ストアも Clock も項目間で共有しない（時計を進める項目1が他の項目の忘却ゲートへ影響しないように）。
 * ⚠ Clock は「上書きするまでは実時間を素通し」にする。固定日付を最初から使うと、`InMemoryMemoryStore` が
 * `Clock` を経由せず `new Date()` で書く outbox ジョブの `availableAt` とずれ、`tick()` が `processed:0` のままになる。
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

  // 決定性のための試験用配線（ADOPTER-SUPPLIED の対象ではない）。`DeterministicEmbeddingProvider` の
  // ハッシュ挙動に依存させず、2件のベクトルを直接上書きして類似度を固定する。
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
    // ADOPTER-SUPPLIED(item2): データ — maxCount は採用者が決める量。
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

  // 決定性のための試験用配線（ADOPTER-SUPPLIED の対象ではない）。ベクトルを固定のクエリベクトルへ揃える。
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
      "注: 明示操作 applyCorrection（ADR 0242、docs/roadmap.md §7.15。⚠ 同§は 2026-09-29 に削除（#762）、" +
      "当時の本文は 635c93d の版）を使う経路は、この" +
      "probe では測っていない。",
  };
}

/** `Omission.kind` の型網羅は実行時には測れないので、測らない。 */
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

/** ⛔ 既定の向きは当てない。 */
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
    // ADOPTER-SUPPLIED(item7): データ — maxMemoryChars は採用者にしか無い意思。
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

export async function runItemSafe(item, fn, mods, hashContent) {
  try {
    const { fact } = await fn(mods, hashContent);
    return { item, mode: "measured", fact };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { item, mode: "print-failed", fact: `印字に失敗した: ${message}` };
  }
}

export function notMeasuredItemResults() {
  return [
    {
      item: 3,
      mode: "not-measured",
      fact:
        "機械に載せない（ADR 0216 決定4）。採用者が供給するのは「後から説明できる」の" +
        "読み戻す口（`getRecall`）を呼ぶことだけであり、それが配線か・データか・判定かの" +
        "意味判定は grep でも型検査でも出ない。人手の監査は `docs/roadmap.md` §7.4 の" +
        "表が持つ（⚠ 同§は 2026-09-29 に削除（#762）。当時の表は 635c93d の版、" +
        "現在形は `docs/north-star-paths.md`）。",
    },
    {
      item: 4,
      mode: "not-measured",
      fact:
        "機械に載せない（ADR 0216 決定4）。「使われない記憶が、静かに遠ざかる」の対比は" +
        "使用報告（`usedMemoryIds`）という mnemora が原理的に持てない情報に依存し、意味の" +
        "判定を要する。人手の監査は `docs/roadmap.md` §7.4 の表が持つ（⚠ 同§は 2026-09-29 に" +
        "削除（#762）。当時の表は 635c93d の版、現在形は `docs/north-star-paths.md`）。",
    },
  ];
}

/**
 * @param {object} mods
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
