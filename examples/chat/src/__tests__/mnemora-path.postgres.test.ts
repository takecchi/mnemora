import { afterAll, describe, expect, it } from "vitest";
import type { Ctx } from "@mnemora/core";
import type { Conversation, ConversationTurn } from "../scenario.js";
import { buildConversation } from "../scenario.js";
import { ingestConversation, queryRecall } from "../mnemora-path.js";
import { createExampleRuntime } from "../runtime-factory.js";
import {
  closeTestClient,
  getTestClient,
  requireDatabaseUrl,
  resetTestDatabase,
} from "./test-db.js";

/**
 * `buildConversation()` の結果に、末尾の1 user 発話を追加した `Conversation` を返す。
 * `scenario.ts` はいじらない——他の測定（`compare`/`retrieval-quality`）の再現性の要
 * だからである（下の it() のdocstring参照）。ここで作る発話は `scenario.ts` の
 * 12種類の filler・`FACT_STATEMENT`・`QUERY_TEXT` のいずれとも文字列が一致しない
 * 一意な内容にする。
 */
function appendTailUserTurn(conversation: Conversation, text: string): Conversation {
  const lastIndex = conversation.turns[conversation.turns.length - 1]?.index ?? -1;
  const tailTurn: ConversationTurn = { index: lastIndex + 1, role: "user", text };
  return {
    turns: [...conversation.turns, tailTurn],
    userUtterances: [...conversation.userUtterances, tailTurn],
    query: conversation.query,
  };
}

/**
 * 末尾の一意な発話。40字以下に抑えている——`DeterministicLLMProvider.completeStructured`
 * （packages/testkit/src/__fixtures__/deterministic-llm-provider.ts）は40字を超える
 * `content` の digest を `slice(0, 40) + "…"` に切り詰めるため、40字を超えると
 * `digest === この文字列そのもの` という完全一致で照合できなくなる。
 */
const UNIQUE_TAIL_UTTERANCE = "私が飼っている猫の名前はナナです。";

/**
 * roadmap.md 段階7の完了条件「サンプルアプリが observe → recall の往復を実演し、
 * omitted と usage を画面またはログに可視化する」を、本物の Postgres に対して実際に
 * 検査する（PR 本文「サンプルアプリ自体が壊れていないことを CI で検査する」）。
 *
 * provider は `@mnemora/testkit` の決定的な擬似実装（`createExampleRuntime` に
 * `env: {}` を渡し、`OPENAI_API_KEY` の有無に関わらず deterministic モードを強制する）。
 * DB は擬似物で代替しない——本物の Postgres + pgvector に対して実行する。
 */
describe("examples/chat: observe → recall の往復（本物の Postgres）", () => {
  it("ingestConversation → queryRecall(budget 無し) は memories/omitted/usage/index を返す", async () => {
    await resetTestDatabase();
    await getTestClient(); // マイグレーション・埋め込み空間登録を先に済ませておく
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      expect(handle.mode).toBe("deterministic");
      const ctx: Ctx = { tenantId: "example-chat-roundtrip" };
      const conversation = buildConversation(3);

      await ingestConversation(handle.runtime, ctx, conversation);
      const result = await queryRecall(handle.runtime, ctx, conversation);

      expect(result.memories.length).toBeGreaterThan(0);
      expect(Array.isArray(result.omitted)).toBe(true);
      expect(result.usage.chars).toBeGreaterThan(0);
      expect(result.usage.counter).toBe("heuristic");
      expect(result.index.totalInScope).toBe(conversation.userUtterances.length);
      // budget を渡していないので、切り詰めによる omission は発生しない。
      expect(result.omitted.some((o) => o.kind === "budget_dropped")).toBe(false);
    } finally {
      await handle.close();
    }
  });

  it("ingestConversation → queryRecall(budget 有り) は実際に候補を切り詰め、budget_dropped を報告する", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-roundtrip-budget" };
      // fillerPairs=10 なら user 発話が11件——既定の limit(10) 全件が返る量があるはずで、
      // 小さな budget で確実に切り詰めが起きる。
      const conversation = buildConversation(10);

      await ingestConversation(handle.runtime, ctx, conversation);
      const withoutBudget = await queryRecall(handle.runtime, ctx, conversation);
      const withBudget = await queryRecall(handle.runtime, ctx, conversation, {
        budget: { maxMemoryChars: 40 },
      });

      const dropped = withBudget.omitted.find((o) => o.kind === "budget_dropped");
      expect(dropped).toBeDefined();
      expect(dropped && dropped.kind === "budget_dropped" && dropped.count).toBeGreaterThan(0);
      // budget を渡した方が、渡さなかった場合より返る memories が少ない
      // （同じ入力・同じ ctx に対して、budget の有無だけを変えて比較している——
      // 「同じ値を両辺で使う比較」にならないよう、実行結果を毎回独立に取り直している）。
      expect(withBudget.memories.length).toBeLessThan(withoutBudget.memories.length);
    } finally {
      await handle.close();
    }
  });

  /**
   * ⭐ 北極星の物差しに直接効く歯。
   *
   * `compare` が示す「642ターンで naive の 1.9%」という削減率は、**それだけでは意味を持たない。**
   * 何も返さなければ削減率は 0% になる。削減が意味を持つのは、
   * **呼び出し側が探している答えが、削られた後にも残っている**場合だけである。
   * ——「使う側が、会話ログを全部プロンプトへ積むのをやめられたか」という物差しは、
   * 積むのをやめても答えが得られることを含意している。
   *
   * この歯は、会話が長くなって `recall()` が既定 `limit` で大幅に絞り込むようになっても、
   * 冒頭で一度だけ表明された事実（`FACT_STATEMENT`）が返り値に残ることを検査する。
   *
   * **⚠ この歯が主張しないこと**: 擬似 embedding は意味的な類似度を持たないため、
   * これは「意味的に関連する記憶が正しく上位に来る」ことの証明ではない。
   * 主張しているのは、**この決定的なシナリオにおいて、量を1桁以上削っても
   * 目的の記憶が落ちない**ということだけである（README「この実測の限界」参照）。
   */
  it("会話が長くなって大幅に絞り込まれても、冒頭で表明された事実は返り値に残る", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-fact-survives" };
      // filler 80組 = 162ターン。user 発話 81件に対し、既定 limit は 10 件。
      const conversation = buildConversation(80);
      await ingestConversation(handle.runtime, ctx, conversation);
      const result = await queryRecall(handle.runtime, ctx, conversation);

      // 前提: 実際に大幅な絞り込みが起きていること。
      // （絞り込みが起きていなければ「残った」ことに意味が無い——
      //   この2行が無いと、limit が緩んだ瞬間にこの歯は無意味な緑になる。）
      expect(result.index.totalInScope).toBe(conversation.userUtterances.length);
      expect(result.memories.length).toBeLessThan(result.index.totalInScope / 4);

      // 本題: 絞り込まれた後にも、冒頭の事実が残っている。
      const digests = result.memories.map((m) => m.digest);
      expect(digests.some((d) => d.includes("青"))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  /**
   * ⭐ ADR 0021 の歯——`DEFAULT_TICK_LIMIT`(50)を超える量を ingest しても
   * `ingestConversation` が干上がるまで embed し切ることを検査する。
   *
   * **背景**（docs/decisions/0019-real-openai-measurement-cost.md §5、
   * docs/decisions/0021-drain-embed-ticks-in-ingest.md）: `ingestConversation` は
   * かつて `tick({kinds:["embed"]})` を1回しか呼んでいなかった。`tick()` の既定
   * `limit` は50（`DEFAULT_TICK_LIMIT`、`packages/core/src/runtime.ts`）であり、
   * embed ジョブは `claimBatch` が `ORDER BY available_at ASC` で先着順に claim する
   * ため、**embed ジョブが50件を超えると、51件目以降は埋め込まれないまま
   * `embeddingStatus: "pending"` に残る**。`recall()` はこれを隠さず、
   * `omitted` に `{ kind: "not_indexed", reason: "pending" }` として正直に出す
   * （ADR 0008）。
   *
   * この歯が押さえる2つの性質:
   *
   *   (a) `omitted` に `not_indexed(reason: "pending")` が一切現れないこと。
   *       ⟹ `ingestConversation` の末尾を（`drainEmbedTicks` ではなく）
   *       `tick()` 1回に戻す変異を当てると、この会話は embed ジョブが61件
   *       （> 50）あるため11件が `pending` のまま残り、`omitted` に
   *       `not_indexed(pending)` が必ず現れる——この assertion は必ず赤くなる。
   *   (b) それでも冒頭（turn-0）の事実（`FACT_STATEMENT`）は `recall()` の
   *       結果に残っていること（「削っても目的の記憶が落ちない」側）。
   *
   * **⚠ (b) についての限界**: turn-0 の embed ジョブは常に最初に enqueue される
   * ため、`available_at ASC` の先着順で常に「最初の50件」に含まれる——
   * **(b) 単体は、上の変異（tick() 1回に戻す）を当てても赤くならない。**
   * (b) は「意味的に関連する記憶が正しく上位に来る」ことの証明でもない
   * （擬似 embedding は文字コード由来のベクトルであり、意味的な類似度を持たない。
   * ADR 0019 §7.3 の実測——多様な内容の干し草60件では擬似 embedding の
   * MRR は 0.018 まで落ちる）。ここで使う haystack は `scenario.ts` の
   * 12種類の filler の巡回であり、`probe-set.ts` の「1件ずつ内容が違う」
   * haystack とは異なる——**(b) は上の (a) の歯と同じ会話を使って
   * 「ついでに」確認しているだけで、この歯が (a) の regression を
   * 検知する力は (a) 側の assertion（`not_indexed(pending)` が無いこと）に
   * 単独で依存している。**
   *
   * **⟹ (a)・(b) はどちらも「内部状態」（omitted の中身／turn-0の生存）の主張である。
   * 「かつて pending のまま黙って失われていた記憶が、実際に recall() で拾えるように
   * なった」という振る舞いの主張は、次の it()（末尾に一意な発話を置くテスト）が別に
   * 担う——(b) がそれを証明できない理由（turn-0 は常に先着50件に入る）は上に書いた
   * 通りである。
   */
  it("50件を超える量を ingest しても干上がるまで embed され、pending のまま取り残される記憶が無い", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-drain-past-tick-limit" };
      // filler 60組 = 122ターン。user 発話 61件（fact 1 + filler 60）——
      // DeterministicLLMProvider は1発話につき必ず1件の Memory を作るため、
      // embed ジョブも61件になり、DEFAULT_TICK_LIMIT(50) を11件超える。
      const conversation = buildConversation(60);
      await ingestConversation(handle.runtime, ctx, conversation);
      const result = await queryRecall(handle.runtime, ctx, conversation);

      // 前提: 実際に DEFAULT_TICK_LIMIT(50) を超える量を ingest したこと
      // （超えていなければ (a) の検査は無意味な緑になる）。
      expect(conversation.userUtterances.length).toBeGreaterThan(50);
      expect(result.index.totalInScope).toBe(conversation.userUtterances.length);

      // (a) 干上がるまで処理されており、pending のまま取り残された記憶が無い。
      const pendingOmission = result.omitted.find(
        (o) => o.kind === "not_indexed" && o.reason === "pending",
      );
      expect(pendingOmission).toBeUndefined();

      // (b) それでも冒頭の事実は残っている（上のdocstring「⚠ (b) についての限界」参照）。
      const digests = result.memories.map((m) => m.digest);
      expect(digests.some((d) => d.includes("青"))).toBe(true);
    } finally {
      await handle.close();
    }
  });

  /**
   * ⭐ ADR 0021 の歯——上の「50件を超える量を ingest しても……」歯 (a) は
   * 「`omitted` に `not_indexed(pending)` が無い」という**内部状態**の主張だった。
   * この歯は同じ修正に対して、それとは別の**振る舞い**の主張を検査する:
   * かつて `pending` のまま黙って失われていた記憶が、いま実際に `recall()` で
   * 想起できるようになったこと（この repo の北極星――「トークンを削ったこと自体は
   * 成果ではない。削っても目的の記憶が落ちない、まで言えて初めて成果」――に
   * 直接効く歯）。
   *
   * **仕掛け**（コードを読んで確認済み）:
   *   - `packages/core/src/extraction.ts:42-57` の `observationPayloadText()` は、
   *     `payload.text` が非空文字列ならそれをそのまま返す。
   *   - 同ファイル `71-84` の `buildExtractionPrompt()` は、その文字列を user
   *     メッセージの `content` にそのまま入れる。
   *   - `packages/testkit/src/__fixtures__/deterministic-llm-provider.ts` の
   *     `completeStructured()` は `content: userText` をそのまま Memory の
   *     `content` にする。
   *     ⟹ `kind: "utterance"` で `text: T` を observe すると、Memory の
   *     `content` は `T` と完全一致する。
   *   - `packages/core/src/runtime.ts:318` は `embed(ctx, [memory.content])`
   *     で埋め込む。
   *   - `packages/testkit/src/__fixtures__/deterministic-embedding-provider.ts`
   *     の `DeterministicEmbeddingProvider` は「同じテキストには常に同じ
   *     ベクトルを返す」ことを保証する。
   *     ⟹ `recall({ text: T })` を撃つと、クエリのベクトルは `T` の Memory の
   *     ベクトルと完全に一致し、コサイン距離0（`packages/postgres/src/vector-store.ts`
   *     の ANN 検索は `embedding <=> query` の昇順――距離0は必ず最上位に来る）。
   *   - `packages/core/src/strategies/scoring.ts` の `defaultScoringStrategy` は
   *     `total = similarity * decay * tagMatch * freshness * strength`。
   *     同じ `ingestConversation` 呼び出しでほぼ同時刻に作られる Memory 同士は
   *     `decay`・`freshness`・`strength` がほぼ等しく（半減期は時間単位、経過は
   *     ミリ秒単位）、`tagMatch` はクエリタグ無しで全候補一律1。
   *     ⟹ `similarity`（= `1 - distance`）の差が支配的であり、
   *     distance=0（similarity=1、理論上の最大値）の候補が唯一なら、
   *     **ANN 候補になれてさえいれば必ず最上位（`result.memories[0]`）に来る**。
   *   - 擬似 embedding の意味的な弱さ（ADR 0021、多様な干し草でのMRR 0.018、
   *     ADR 0019 §7.3）に**一切依存しない**――ここで使うのは
   *     「テキストが完全一致すればベクトルも完全一致し、距離は必ず0になる」
   *     という構造だけである。
   *
   * **会話の形**（`scenario.ts` は変更せず、`buildConversation()` の結果に
   * テスト側で末尾の1ターンを足す。`scenario.ts` は他の測定の再現性の要のため
   * 触らない）: 冒頭の事実1件 + filler 60件（`buildConversation(60)`）+ 末尾の
   * 一意な発話1件 = user 発話62件。末尾がちょうど62番目になる。
   * `claimBatch`（`packages/postgres/src/outbox-store.ts`）が
   * `ORDER BY available_at ASC` の先着順で claim する以上、**末尾に置くのが
   * 「先着50件の外に絶対出る」ことがいちばん揺れない**――先頭や中間に置くと、
   * 同時刻に enqueue された場合の同順位の紛れ込みうる余地が末尾より大きくなる。
   *
   * **修正前（`ingestConversation` の末尾を `drainEmbedTicks` ではなく
   * `tick({kinds:["embed"]})` 1回に戻す変異を当てた場合）**: embed ジョブは
   * 62件作られるが、`DEFAULT_TICK_LIMIT`(50) の1回の `tick()` では先着50件
   * （1〜50番目）しか処理されない。末尾（62番目）の発話は必ずその外に出るため
   * `embeddingStatus: "pending"` のまま残り、ANN の候補にすらなれない――
   * 上の理屈で距離0のはずのクエリを撃っても、pending のままの Memory は
   * ベクトルが無くそもそも ANN 検索に載らないため `result.memories` に
   * 現れない。**⟹ この歯の assertion は必ず赤くなるはずである。**
   *
   * 修正後（`drainEmbedTicks` で干上がるまで処理する）は末尾の発話も embed
   * 済みになり、ANN 候補になれるので現れる――上の理屈により最上位に来るはず
   * なので、1位であることまで assert する。
   *
   * **⚠ この歯が依存する未検証の前提**（コードを読んで導いたが、実行で
   * 確かめてはいない）: `DeterministicEmbeddingProvider.vectorFor()` は
   * 文字コードの和を8バケットへ振り分けるだけであり、理論上は異なる文字列が
   * 同じベクトルに衝突する可能性がゼロではない。`UNIQUE_TAIL_UTTERANCE` が
   * `scenario.ts` の filler・`FACT_STATEMENT`・`QUERY_TEXT` のいずれとも
   * 衝突しないことは目視で確認したが、確率的な衝突が起きないことの証明は
   * していない（既存の (a)/(b) の歯も同じ前提の上に立っている）。
   */
  it("50件超で置き去りにされていた末尾の発話が、修正後は recall() で実際に拾えるようになる", async () => {
    await resetTestDatabase();
    await getTestClient();
    const handle = await createExampleRuntime(requireDatabaseUrl(), {});
    try {
      const ctx: Ctx = { tenantId: "example-chat-tail-recallable" };
      const base = buildConversation(60); // fact 1 + filler 60 = user発話61件
      const conversation = appendTailUserTurn(base, UNIQUE_TAIL_UTTERANCE); // 62件目

      // 前提: 末尾がちょうど62番目であり、DEFAULT_TICK_LIMIT(50) を超えていること
      // （超えていない・末尾でなければ、この歯は無意味な緑になる）。
      expect(conversation.userUtterances.length).toBe(62);
      expect(conversation.userUtterances[61]?.text).toBe(UNIQUE_TAIL_UTTERANCE);
      expect(conversation.userUtterances.length).toBeGreaterThan(50);

      await ingestConversation(handle.runtime, ctx, conversation);
      // queryRecall()（conversation.query = QUERY_TEXT を使う）ではなく、
      // runtime.recall() を直接、末尾の発話と完全に同じ文字列で撃つ。
      const result = await handle.runtime.recall(ctx, { text: UNIQUE_TAIL_UTTERANCE });

      // 本題: かつて pending のまま拾えなかったはずの末尾の記憶が、実際に拾える。
      const tailMemory = result.memories.find((m) => m.digest === UNIQUE_TAIL_UTTERANCE);
      expect(tailMemory).toBeDefined();
      // 距離0の完全一致は、候補になれてさえいれば必ず最上位に来る（上のdocstring参照）。
      expect(result.memories[0]?.digest).toBe(UNIQUE_TAIL_UTTERANCE);
    } finally {
      await handle.close();
    }
  });
});

afterAll(async () => {
  await closeTestClient();
});
