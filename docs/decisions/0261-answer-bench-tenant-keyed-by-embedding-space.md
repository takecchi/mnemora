# ADR 0261: `answer` ベンチの tenant を埋め込み空間で分ける —— 「抽出の冪等スキップ」がモードを跨ぐと、記憶とベクトルの整合が壊れる（Issue #583）

- **状態**: 提案 (2026-09-21)
- **日付**: 2026-09-21

**⚠ この ADR を書いたのは、自動化された担い手（クローンのマネージャーのセッション）である**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。**オーナー本人は方針（決定1・決定2 と、採らなかった案の選択）を承認している。⛔ 本文の逐語は読んでいない。**

**⚠ 各主張の出所を分ける**（ADR 0068 / 0257 / 0260 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — 書き手または委譲先が、実際に走らせて得た。器を明記する。
- **【受】** — 委譲先の報告として受け取り、書き手が再導出していない。
- **【推論・未検算】** — 読解から導いたが、走らせて確かめていない。

**この ADR の測定環境 【実測】**: **手元に立てた PostgreSQL 17.11 + pgvector 0.8.0**（専用インスタンス）。⛔ **実 API は1回も叩いていない。** 観測基準 `origin/main = 03974c0`（2026-09-21T15:20:26+09:00）。

---

## 文脈 —— Issue #583 は、結論が当たっていて**理由が間違っていた**

[Issue #583](https://github.com/takecchi/mnemora/issues/583) は、[ADR 0260](./0260-answer-names-what-it-actually-runs.md)（Issue #577）の「引き受けた負債」として切り出された。⚠ **起票したのも同じ担い手であり、そこに書かれた因果は【推論・未検算】だった**——逐語「別次元の記憶が残ったまま `recorded` で走ることになる…`RecordedLLMProvider` が例外を投げうる」。

**測った結果、例外は実際に起きる。⛔ だが理由は「次元が混ざる」ではなかった。**

## 測ったこと 【実測】

| 段 | 順序（同じ DB・同じ tenant） | 結果 |
|---|---|---|
| 段0 | まっさら → **既定**（`recorded`/256次元） | exit 0 |
| 段1 | → `deterministic` 明示（8次元） | exit 0 |
| 段2 | → **再び既定** | ⭕ **exit 0。落ちない。** 出力は段0と1バイトも同一 |
| 段3 | 新 DB → 既定 → `deterministic` | exit 0（両方） |
| 🔴 段4 | 新 DB → **`deterministic` を最初に** → 既定 | **exit 1。落ちた。** |

段4 のエラー逐語【実測】:

```
Error: RecordedLLMProvider: このプロンプトは記録に無い（黙って擬似応答へ倒れない）。
最後の user 発話: "(索引: スコープ内 4 件のうち 0 件を提示)
質問: 打ち合わせのとき、わたしに出す飲み物は何がいいですか?"。
    at runAnswerCase (examples/chat/src/answer-bench.ts:381:45)
```

### 🔴 真因 —— **抽出の冪等スキップ**

【現物】2つが噛み合って起きる:

1. **埋め込みは `(provider, model, dimensions)` ごとに完全に別テーブル**（`packages/postgres` の `embeddingSpaceTableName`）。⟹ **次元不一致で pgvector が落ちる経路はそもそも無い。** 実際に両方のテーブルが同じ DB に共存していた【実測】。
2. `observations` は **`ON CONFLICT (tenant_id, external_id) ... DO NOTHING`** の冪等 insert（`packages/postgres/src/memory-store.ts`）。⟹ **同じ tenant に同じ会話を2回入れると、2回目は抽出そのものが走らない。**

⟹ ⭐ **効いているのは「次元」ではなく「どちらが先に *抽出を走らせたか*」である。**

- **既定が先** ⟹ 256次元テーブルに記憶が入る ⟹ 後から `deterministic` が来ても冪等スキップで256次元側は無傷 ⟹ 落ちない。
- **`deterministic` が先** ⟹ 8次元テーブルにだけ記憶が入る ⟹ 後から既定が来ても**抽出はスキップされ、256次元テーブルは0行のまま** ⟹ recall が「スコープ内 N 件のうち **0件** を提示」というカセットに無いプロンプトを組む ⟹ 例外。

### 🔴 そして CI が緑なのは、**たまたまの実行順序**が守っているからだった

【現物】`answer-cli.postgres.test.ts` の3本は**同じ DB・同じ tenant**に「明示 `recorded`（256）→ 既定（256）→ 明示 `deterministic`（8）」の順で走る。⟹ **CI は毎回モードを跨いだ再実行をしており、緑である。**

⟹ ⭐⭐ **守っているのは機械でも、人の規律でもない。*実行順序* である。** ⛔ **これは誰も選んでいない。** `it` の順序を入れ替えるか、`deterministic` の歯を別ファイルへ切り出せば赤くなる。

⚠ **[PR #587](https://github.com/takecchi/mnemora/pull/587) でこの歯を足したとき、書き手は「順序を入れ替えると *上の2本* が落ちうる」とコメントに書いた。⛔ 向きが逆だった**——落ちるのは後から来る `recorded` 側である。**そしてその向きを測っていなかった。**

---

## 決めたこと

### 決定1. `runAnswerCase` の tenant に、埋め込み空間のスラグを挟む

```ts
const ctx: Ctx = { tenantId: `${tenantPrefix}-${embeddingSpaceSlug(embeddingProvider.space)}-${answerCase.id}` };
```

⟹ **空間が変われば tenant も変わる。** ⟹ 「同一 tenant への二重 observe」という**冪等スキップの土台そのものが起きなくなる。**

**スラグは `examples/chat` 側に自前で持つ**（`embeddingSpaceSlug`）。
⛔ **`packages/postgres` の `embeddingSpaceTableName` は import しない。**

> ⚠ **当初この ADR の書き手は「あれは export されていないかもしれず、公開 API 表面の門に引っかかりうる」と考えていた。⛔ それは誤りだった**——【実測】`packages/postgres/src/index.ts:13` の `export * from "./embedding-space-table.js"` で**公開されている。**
> ⭐ **それでも import しない理由は別に在る**【現物】: あれは **PostgreSQL 識別子の63バイト上限**から逆算した関数で、**溢れると切り詰めてハッシュを足す**。⟹ tenant に流用すると、空間名が長くなった瞬間に **tenant が不透明なハッシュへ化け、`memory_embeddings_` という接頭辞まで tenant 名に入る。** `tenantId` は `z.string().min(1)` で**上限が無い**【現物、`packages/core/src/ctx.ts:18`】。⟹ **制約が違うものを流用しない。**

### 決定2. 「記憶は在るが、この空間のベクトルが0件」を、**判定ではなく候補として出力に焼く**

`recall.index.totalInScope > 0 && recall.memories.length === 0` のとき、画面に出す。

🔴 **例外にしない。落ちるのを防がない。** ⟹ **「なぜ落ちたか」が画面に出ることだけが目的である。**
⭐ **候補の一覧として出す**（[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定5 / [ADR 0255](./0255-tools-output-candidates-not-verdicts.md)）——(1) 別の空間で先に記憶が入った (2) 予算・減衰・validAt ゲートで落ちた。**⛔ どちらかは、この行だけでは決まらない。**

**なぜ決定1 だけで足りないか**: 決定1 は**この経路**を消すが、「記憶は在るがこの空間のベクトルが0件」という**状態そのものを禁じてはいない。** ⟹ 別の経路で同じ状態に入ったとき、いまは `RecordedLLMProvider` の例外という**原因から遠い場所**でしか分からない。

---

## 検討して採らなかった案

| 案 | 中身 | 落とした理由 |
|---|---|---|
| **(A)** `runAnswer` も `runId` 入り tenant にする（`recordAnswer` と揃える） | 毎回まっさらな tenant | ⭐ **仕事が違う。** 【現物】`recordAnswer` の docstring の逐語「⚠ **tenantPrefix に `runId` を含め、毎回新しいテナントにする。**…既に取り込み済みのテナントで録ると…**『空のカセット』で `CassetteRecorder.toCassette()` が落ちる**」——あちらが `runId` を要るのは**記録が空になるのを避けるため**で、順序依存の話ではない。⟹ `recordAnswer` は**毎回新しい記録を作る**のが仕事。`runAnswer` は**同じ入力で同じ結果が出る**のが仕事であり、tenant は**入力（空間）で決まるべきで、実行ごとに変わってはいけない**。⛔ 変えると「2回続けて走らせて `measuredAt` 以外一致」を測る歯（`answer-cli.postgres.test.ts`【現物】）が意味を失い、**tenant が無限に積み上がる（掃除の口が無い）** |
| **(B)** 実行前に `answer-bench-*` の tenant を掃除する | 順序依存が消え、tenant も増えない | ⛔ **消す。** 利用者の永続 DB で同名 tenant の他のデータを巻き込む恐れがある。⚠ `answer` だけ別作法になる |
| **(D')** 決定2 を**例外**にする | 食い違ったら止める | ⛔ **正当な (2)（予算・減衰・validAt）でも同じ状態になりうる**——判定にできない。⟹ ADR 0255 のとおり、**判定にできないものは出力に焼く** |
| **(E)** 何もせず、歯の順序を守る規約だけ残す | 最小 | ⛔ **ADR 0068 の逐語「注意書きは足さない。注意書きは検査されない。形で塞ぐ。」** がそのまま当たる。⟹ 歯を1本増やす人が踏む |

---

## 陽性対照 —— **順序を入れ替えて緑であることを見た** 【実測】

⭐ **「直った」と言うには、直す前に落ちた形が通ることを見る必要がある。**

1. **生の CLI**: 新しい DB で **`deterministic` を最初 → 既定** の順に走らせた。⟹ **両方 exit 0、例外なし**（直す前は2回目が exit 1）。
   DB を検めると tenant が `answer-bench-openai-text-embedding-3-small-256-…` と `answer-bench-testkit-deterministic-8-…` に分かれ、**両方の埋め込みテーブルに行が在る**（256次元=38行 / 8次元=46行）。⟹ 直す前は 256次元側が**0行**だった。
2. **歯の順序**: 新しい DB で、**`deterministic` の歯だけを先に**走らせ（`vitest -t`）、続けて3本すべてを走らせた。⟹ **3 passed。**
   ⭐ **ファイルは1バイトも書き換えていない**——`-t` で順序を作ったので、戻す作業も無い。

---

## 引き受けた負債

**`answer-cli.postgres.test.ts` の docstring 3箇所が、この決定で古くなる**【現物、`:51-64` / `:221-229` / `:292-297`】。「`runAnswerCase` の tenant は `${tenantPrefix}-${answerCase.id}` という固定値」「この歯は describe の最後に置く」という記述は、決定1 の後は**要らない制約を読者に要求する形**になる。⟹ **この PR で直す**（負債として残さない）。

---

## これが覆るとしたら

- **`answer` が同じ空間で複数の構成を測るようになったとき。** ⟹ 空間だけでは tenant が分かれなくなる。
- **tenant の長さが問題になったとき。** ⟹ いまは `z.string().min(1)` で上限が無い【現物】。上限が入れば、決定1 のスラグは短縮が要る。

## 確かめたこと

- **【実測】** 段0〜段4 の exit code（手元の Postgres 17.11 + pgvector 0.8.0）
- **【実測】** 直した後、`deterministic` 先行の順序で CLI が2回とも exit 0
- **【実測】** 直した後、`deterministic` の歯を先に走らせても 3 passed
- **【実測】** tenant が空間ごとに分かれ、両方の埋め込みテーブルに行が在る
- **【現物】** `ON CONFLICT (tenant_id, external_id) DO NOTHING` / `embeddingSpaceTableName` / `CtxSchema` の `tenantId` に上限なし / `embeddingSpaceTableName` は公開 API

## 確かめていないこと

- 🔴 **「スコープ内 4 件のうち 0 件を提示」が、なぜ4件見つかって0件提示になるのか**——recall 内部（lexical 経路・予算判定）は追っていない【推論・未検算】。**落ちる事実は実測、内訳は未確認。**
- **`deterministic` が2番目でも、新しい caseId で実際に新規 ingest するなら同じ問題が起きるか**は測っていない。
- **決定2 の候補 (2)（予算・減衰・validAt）が実際にこの状態を作る例**は、走らせて確かめていない【推論・未検算】。
- 【受】**段0/1/3 の exit code は、実験を担当した担い手の報告を引いている**（2026-09-21T15:25–15:29Z）。**書き手が自分の目で開いたのは、段4 のエラー逐語と段2 に例外が無いことだけである。**
