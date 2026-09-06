import type { Ctx, RecallResult, Runtime } from "@mnemora/core";
import { drainEmbedTicks } from "./embed-drain.js";

/**
 * `tenantId`/`subjectId` のスコープを「動く例」で見せるデモ（examples/chat/README.md
 * 「`scope`」節）。ルート README.md「記憶を誰に紐づけるか」がこの非対称——
 * `tenantId` は隔離境界（跨いだら事故）、`subjectId` はテナント内の整理の単位
 * （跨いでも事故ではない）——を説明済みだが、`examples/chat` はこれまで
 * `ctx.subjectId` を一度も設定していなかった（`grep` で確認: 出現0件）。
 * このファイルは、同じテナントの中に alice/bob という2つの subject を作り、
 * 別テナントも1つ用意して、3通りの `recall()` のスコープの違いを実演する。
 *
 * **⚠ 北極星の主測定（`compare`/`retrieval`）には一切関わらない。**このファイルは
 * `runComparison`/`runRetrievalQualityArm` を呼ばず、`compare.ts`/`retrieval-quality.ts`/
 * `probe-set.ts`/`scenario.ts`/`naive-path.ts` のいずれも import しない——測定条件を
 * 一切共有しない、独立したデモである。
 */

/** alice/bob の subjectId。同じテナント内の2つの整理の単位。 */
export const SCOPE_DEMO_ALICE_SUBJECT_ID = "alice";
export const SCOPE_DEMO_BOB_SUBJECT_ID = "bob";

/**
 * alice/bob それぞれの事実。取り違えたら一目で分かるよう、ペット（犬/猫）と
 * その名前を変えてある。`@mnemora/testkit` の決定的な擬似 LLM は Observation を
 * 要約せず digest が発話そのものになるため（`mnemora-path.postgres.test.ts` と同じ
 * 前提）、返ってきた digest にどちらの名前が含まれるかで「誰の記憶が返ったか」を
 * 目視・機械的に判定できる。
 */
export const ALICE_FACT = "私が飼っているペットは犬のポチです。";
export const BOB_FACT = "私が飼っているペットは猫のタマです。";

/** alice/bob 共通の質問文。ペットについて尋ねる——どちらの事実にも同じくらい関係しうる。 */
export const SCOPE_DEMO_QUERY = "わたしが飼っているペットは何ですか?";

/** `externalId`。同じ ctx に対してこの関数を2度呼んでも Observation が重複しない。 */
const ALICE_EXTERNAL_ID = "scope-demo-alice-pet-fact";
const BOB_EXTERNAL_ID = "scope-demo-bob-pet-fact";

export interface ScopeDemoResult {
  tenantId: string;
  otherTenantId: string;
  /** `{ tenantId, subjectId: "alice" }` で recall した結果。bob の記憶は対象外。 */
  aliceOnly: RecallResult;
  /** `{ tenantId }`（subjectId 省略）で recall した結果。alice・bob 両方が対象。 */
  tenantWide: RecallResult;
  /** 別テナント `{ tenantId: otherTenantId }` で recall した結果。tenantId の記憶は0件のはず。 */
  otherTenant: RecallResult;
}

/** `recall().memories` の digest に、alice/bob の事実に固有の名前が含まれるかを見る。 */
function digestsInclude(memories: { digest: string }[], marker: string): boolean {
  return memories.some((m) => m.digest.includes(marker));
}

export interface ScopeDemoCheck {
  /** aliceOnly recall に alice の記憶（「ポチ」）が含まれるか。 */
  aliceOnlyHasAlice: boolean;
  /** aliceOnly recall に bob の記憶（「タマ」）が含まれないか（含まれなければ true）。 */
  aliceOnlyExcludesBob: boolean;
  /** tenantWide recall に alice・bob 両方の記憶が含まれるか。 */
  tenantWideHasAlice: boolean;
  tenantWideHasBob: boolean;
  /** otherTenant recall が0件か（別テナントの記憶が一切現れないか）。 */
  otherTenantIsEmpty: boolean;
}

/** `ScopeDemoResult` から、見せたい3つの性質を機械的に判定する（印字・歯の両方が使う）。 */
export function checkScopeDemo(result: ScopeDemoResult): ScopeDemoCheck {
  return {
    aliceOnlyHasAlice: digestsInclude(result.aliceOnly.memories, "ポチ"),
    aliceOnlyExcludesBob: !digestsInclude(result.aliceOnly.memories, "タマ"),
    tenantWideHasAlice: digestsInclude(result.tenantWide.memories, "ポチ"),
    tenantWideHasBob: digestsInclude(result.tenantWide.memories, "タマ"),
    otherTenantIsEmpty: result.otherTenant.memories.length === 0,
  };
}

/**
 * スコープのデモ本体（印字を持たない、テストから呼べる形）。
 *
 * 1. `{ tenantId, subjectId: "alice" }` で観測・recall → bob の記憶は返らない。
 * 2. `{ tenantId }`（subjectId 省略）で recall → テナント全体（alice・bob 両方）が対象。
 * 3. `{ tenantId: otherTenantId }`（別テナント）で recall → tenantId の記憶は1件も返らない。
 *
 * `tenantId`/`otherTenantId` は呼び出し側が渡す（CLI 側は実行のたびに一意な値を、
 * テスト側は `resetTestDatabase()` 後の固定値を渡す——`compare.ts` の
 * `runComparison` と同じ「呼び出し側が tenantId を決める」設計に倣った）。
 */
export async function runScopeDemo(
  runtime: Runtime,
  tenantId: string,
  otherTenantId: string,
): Promise<ScopeDemoResult> {
  const aliceCtx: Ctx = { tenantId, subjectId: SCOPE_DEMO_ALICE_SUBJECT_ID };
  const bobCtx: Ctx = { tenantId, subjectId: SCOPE_DEMO_BOB_SUBJECT_ID };
  const tenantCtx: Ctx = { tenantId };
  const otherTenantCtx: Ctx = { tenantId: otherTenantId };

  await runtime.observe(aliceCtx, {
    kind: "utterance",
    text: ALICE_FACT,
    speaker: "user",
    externalId: ALICE_EXTERNAL_ID,
  });
  await runtime.observe(bobCtx, {
    kind: "utterance",
    text: BOB_FACT,
    speaker: "user",
    externalId: BOB_EXTERNAL_ID,
  });
  // outbox の claimBatch はテナント単位（packages/postgres/src/outbox-store.ts、
  // subjectId では絞らない）なので、tenantId だけの ctx で1回干上がらせれば
  // alice・bob 両方の embed ジョブが処理される。
  await drainEmbedTicks(runtime, tenantCtx);

  const aliceOnly = await runtime.recall(aliceCtx, { text: SCOPE_DEMO_QUERY });
  const tenantWide = await runtime.recall(tenantCtx, { text: SCOPE_DEMO_QUERY });
  const otherTenant = await runtime.recall(otherTenantCtx, { text: SCOPE_DEMO_QUERY });

  return { tenantId, otherTenantId, aliceOnly, tenantWide, otherTenant };
}

function formatMemoryList(memories: { digest: string }[]): string {
  if (memories.length === 0) {
    return "  (0件)";
  }
  return memories.map((m) => `  - "${m.digest}"`).join("\n");
}

/** 画面向けの印字（何が返り、何が返らなかったかを人が読める形にする）。 */
export function formatScopeDemo(result: ScopeDemoResult): string {
  const check = checkScopeDemo(result);
  const lines: string[] = [];

  lines.push(`tenantId      = ${result.tenantId}`);
  lines.push(`otherTenantId = ${result.otherTenantId}`);
  lines.push("");

  lines.push('--- 1. { tenantId, subjectId: "alice" } で recall ---');
  lines.push(`件数: ${result.aliceOnly.memories.length}`);
  lines.push(formatMemoryList(result.aliceOnly.memories));
  lines.push(
    `⟹ alice の記憶が含まれる: ${check.aliceOnlyHasAlice ? "はい" : "いいえ"} / ` +
      `bob の記憶が含まれない: ${check.aliceOnlyExcludesBob ? "はい" : "いいえ"}`,
  );
  lines.push("");

  lines.push("--- 2. { tenantId }（subjectId 省略）で recall ---");
  lines.push(`件数: ${result.tenantWide.memories.length}`);
  lines.push(formatMemoryList(result.tenantWide.memories));
  lines.push(
    `⟹ alice の記憶が含まれる: ${check.tenantWideHasAlice ? "はい" : "いいえ"} / ` +
      `bob の記憶が含まれる: ${check.tenantWideHasBob ? "はい" : "いいえ"}`,
  );
  lines.push("");

  lines.push("--- 3. { tenantId: otherTenantId }（別テナント）で recall ---");
  lines.push(`件数: ${result.otherTenant.memories.length}`);
  lines.push(formatMemoryList(result.otherTenant.memories));
  lines.push(
    `⟹ 0件である（tenantId の記憶が一切現れない）: ${check.otherTenantIsEmpty ? "はい" : "いいえ"}`,
  );

  return lines.join("\n");
}
