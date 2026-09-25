# mnemora

**既存の LLM アプリケーションの下に敷く「認知レイヤー」。**

単発の `入力 → LLM → 出力` の外側に、永続する記憶と継続する認知処理を置く。

```
Application → Agent / LLM → Cognitive Runtime → Storage / LLM / Queue
                              ├── Observation
                              ├── Memory / Recall / Association
                              ├── Reinforcement / Forgetting / Consolidation
                              └── Reflection / Background Cognition
```

**エージェントフレームワークを作り直すものではない。** LangGraph・Mastra・自作 Agent の
**下に足せる**位置を狙う。

---

## 目指しているもの

**LLM アプリケーションに「思い出す」を与えること。「保存する」ではなく。**

保存はすでに解けている。解けていないのは、
**大量に貯めたものの中から、いま必要な分だけを引き当てること**である。

**近づいたかどうかを測る物差しは一つだけ**——
**使う側が、会話ログを全部プロンプトへ積むのをやめられたか。**

→ **[docs/north-star.md](./docs/north-star.md)**（正典。目的 / 目指す姿 / 物差し / 迷ったときの問い）

---

## 何をするものか

特定のチャットボット専用ではなく、Web アプリ・AI 秘書・Discord Bot・ゲーム NPC・
コーディングエージェント・ロボット・個人 AI・業務エージェントから再利用できる汎用基盤を目指す。

大量の会話ログを毎回 LLM へ全部渡すのではなく、**必要な記憶だけを**
意味・構造・時間・重要度・利用頻度・関連性から思い出す。

そこから新しい知識を統合し、使われない記憶は自然に想起されにくくなり、
必要なときだけ過去の記憶を呼び戻せる。

外から見える API は小さく保つ:

**⚠ `brain` のような受け皿オブジェクトは無い。**下の**中核の5動詞**は
`createRuntime()`（`@mnemora/core`）が返す `runtime` のメソッドであり、
**すべて第一引数に `ctx`（`tenantId` 必須）を取る。**

```ts
import type { Runtime } from "@mnemora/core";

// runtime は createRuntime() で組み立てる（実装は @mnemora/postgres・@mnemora/openai から。
// 配線の詳細は packages/core/README.md）。ここでは型だけを示す骨格。
declare const runtime: Runtime;
const ctx = { tenantId: "guild-123", subjectId: "user-456" };

await runtime.observe(ctx, { kind: "utterance", text: "明日、京都へ出張する", speaker: "user" });
const recalled = await runtime.recall(ctx, { text: "京都の予定は?" });
await runtime.reflect(ctx, { target: { memoryIds: [] } });
await runtime.consolidate(ctx, { target: { memoryIds: [] } });
await runtime.forget(ctx, { memoryIds: [] });
```

**⟹ 中核の5動詞の正式なシグネチャは「## 外から見える API」節、`ctx` の意味は
「## 記憶を誰に紐づけるか」節を見ること。**

---

## いまの状態

**Phase 1（MVP）の実装が一巡した。**`packages/core`（型・interface・runtime）、`packages/postgres`、
`packages/openai`、`packages/anthropic`、`packages/local-embedding`、
`packages/testkit`（適合テスト）、`examples/chat`（サンプル CLI）がある。
Phase 1 の範囲と、そこに入れなかったものは [docs/roadmap.md](./docs/roadmap.md) を参照。

**版の付け方**: `v1.0.0` 以降は [semver](https://semver.org/lang/ja/) に従う
——**公開 API の破壊的変更は major を上げる。**⛔ **「もう変わらない」という意味ではない。**
破壊的変更は major を上げる形で起こりうる。ただしそのとき **ADR を書くことは必須である**
（[docs/autonomy.md](./docs/autonomy.md) §3 逐語「公開 API の破壊的変更も、ADR を書けば
実装してよい……ただし ADR に書くことは変わらず必須」、
[ADR 0156](./docs/decisions/0156-delegate-5-grade-judgment-and-breaking-changes.md)）
⟹ **何がどの版で変わったかは [CHANGELOG.md](./CHANGELOG.md)、なぜ変わったかは
[docs/decisions/](./docs/decisions/) から辿れる。**

名前は `mnemora`（`@mnemora/*`）に確定しており、暫定ではない
（経緯は [docs/vision.md](./docs/vision.md) の「名前について」と
[ADR 0014](./docs/decisions/0014-package-name-mnemora.md)）。

| 文書 | 何が書いてあるか |
|---|---|
| [docs/north-star.md](./docs/north-star.md) | **正典。**目指すもの・物差し・迷ったときの問い |
| [docs/vision.md](./docs/vision.md) | プロジェクトの理解 / 用語 / やらないこと / 名前 |
| [docs/architecture.md](./docs/architecture.md) | 全体アーキテクチャ / package 構成 / 主要 interface |
| [docs/memory-model.md](./docs/memory-model.md) | DB schema 案 / Memory lifecycle / 矛盾 / 忘却 / 監査ログ |
| [docs/recall.md](./docs/recall.md) | Recall pipeline / 「無い」の分類 / 目次帯 / 量の計測と予算 |
| [docs/roadmap.md](./docs/roadmap.md) | Phase 1 実装計画 / リスク / まだ判断が必要な点 |
| [docs/alteroid-findings.md](./docs/alteroid-findings.md) | 設計の材料にした運用知見を、現物で検証した記録 |
| [docs/decisions/](./docs/decisions/) | ADR — 重大な設計判断と、その理由 |

このリポジトリで作業する人・エージェント向けの手引きは [AGENTS.md](./AGENTS.md) にある。

---

## 想起の質をどう測っているか

**`recall()` が「必要な記憶だけを思い出せているか」を、CI で毎 PR 測っている。**
API キーは要らない——**実 API が返した埋め込みの記録を再生している**（下の「⚠ 『実 embedding』の意味」）。

| ジョブ（[.github/workflows/ci.yml](./.github/workflows/ci.yml)、`jobs.<キー>`） | 何を測るか | 埋め込み |
|---|---|---|
| 想起の質（[ADR 0088](./docs/decisions/0088-retrieval-quality-measured-in-ci.md)）`retrieval-quality` | 意味的関連性 probe **7件**の `hit@1` / `hit@10` / MRR | 記録の再生 |
| 識別子・固有名詞 probe（[ADR 0094](./docs/decisions/0094-identifier-probes-local-embedding.md)）`identifier-probes` | 識別子・固有名詞 probe **30件**（`examples/chat/src/identifier-probe-set.ts` の `IDENTIFIER_PROBES`） | `@mnemora/local-embedding`（プロセス内推論） |
| 単独トークンの数詞・記号索引 probe（[ADR 0135](./docs/decisions/0135-numeral-token-discriminator-probe-domain-design.md)）`numeral-token-probes` | 文字種（漢数字/算用数字/アルファベット）×共有前置長（長/中/短）の9セル×2 probe **18件**（`examples/chat/src/numeral-token-probe-set.ts` の `NUMERAL_TOKEN_PROBES`）の `hit@1` / `hit@10` / MRR / margin（gold−distractor の similarity 差、分布で読む） | 同上 |
| 統合の費用（[ADR 0101](./docs/decisions/0101-how-to-measure-whether-consolidate-moved-the-north-star.md)）`consolidation-cost` | `consolidate()` が「載る量」に効いたか | 同上 |

**⚠ `identifier-probes`/`numeral-token-probes` の2ジョブは、上の表が示す
`@mnemora/local-embedding` の測定に加えて、OpenAI 実埋め込み（`text-embedding-3-small`/
256次元、`recorded` provider でカセットを再生——鍵もネットワークも要らない）の追加
arm も走らせる（Issue #109 後半）。**識別子・日本語固有名詞 probe（`identifiersSparse`/
`identifiersDense`/`japaneseNamesSparse`/`japaneseNamesDense`）と数詞・記号索引 probe
（`numeralSparse`/`numeralDense`）の計6群。**⛔ 門ではない**——Job Summary に基準値との
差分と「並走の判定」を出すだけで、相違しても・並走の判定が red でも `exit 0` のまま
（[ADR 0316](./docs/decisions/0316-openai-embedding-false-positive-ceiling.md)。
Issue #109 の閉じる条件と、実測した偽陽性率の上限は
下の「OpenAI 実埋め込みでの偽陽性率の上限（Issue #109 後半）」を見ること）。

**⚠ この表は、`ci.yml` の測定系ジョブの全部ではない。**上の4つのほかに
`association-probes`（連想枠が想起の質を動かすか）・`archive-sweep-cost`（掃引が「載る量」/ hit@k に
効くか）・`time-term`（時間項が順位を動かすか）・`validity`（`validAt` ゲートが候補の有無を動かすか）が
**同じく毎 PR 走っている。**⟹ **ここに挙げていないジョブが無いとは読まないこと**——
一覧は `.github/workflows/ci.yml` の `jobs` を直接見ること。

**⚠ 行番号ではなくジョブ名（`jobs.<キー>`）で引く。**ジョブが増減すると行番号は動くが、
ジョブ名は動かない——`.github/workflows/ci.yml` の該当ジョブを `grep -n "^  <ジョブ名>:"`
で探すこと。引き金は `on.push.branches: [main]` と `on.pull_request` である——
**`schedule` ではなく、毎 PR 走る。**値は `retrieval-quality` ジョブの **Job Summary**と
成果物 `retrieval-quality.json`（同ジョブの `actions/upload-artifact` ステップ）に残り、
`examples/chat/retrieval-baseline.json` の基準値と突き合わされる。
**基準値は手で更新する**（CI が書き換えることはない）。

### ⚠ 「実 embedding」の意味

**この2つは別物なので、書き分ける。**

- ⛔ **実 API を毎回叩いてはいない。**CI は `OPENAI_API_KEY` を持たない。
- ✅ **実 API が返した埋め込みを再生している。**`examples/chat/cassettes/retrieval.json`
  （`text-embedding-3-small` / 256次元 / 152件）を `MNEMORA_PROVIDER_SOURCE=recorded`
  （`retrieval-quality` ジョブの env）で再生する。

**⟹ 鍵の無い CI でも、擬似物ではない埋め込みで測れる。**
（擬似 provider で測った想起の質は性能について何も言っていない。3層の区別は [AGENTS.md](./AGENTS.md) を見ること。）

### 🔴 この仕組みが測っていないこと

**「継続的に測っている」は「想起の質を保証している」ではない。**採用を検討する側が
過大に読まないように、測れていない範囲をここに並べる。

- **閾値の門は無い。**基準値と相違しても `exit 0` のままである
  （`scripts/retrieval-quality-summary.mjs:19` に意図として明記）。理由は
  [ADR 0088](./docs/decisions/0088-retrieval-quality-measured-in-ci.md) §2——
  **probe が7件では閾値の門が偽陽性を出す。**
- **埋め込みモデル側が変わったことによる退行は、再生では検知できない。**
  カセットを録り直すまで同じベクトルが返り続ける。
- **このベンチは語彙チャンネルを一度も通していない**
  （[ADR 0108](./docs/decisions/0108-retrieval-bench-does-not-exercise-lexical-channel.md)）。
  ⟹ [ADR 0092](./docs/decisions/0092-lexical-or-coverage.md) で入れた語彙側の変更は、まだ測られていない。
- **順位を実際に決めているのは `similarity` ただ1項である**
  （[ADR 0109](./docs/decisions/0109-which-score-terms-actually-rank.md)）。
  スコアは5項あるが、**このベンチでは残り4項が順位を動かしていない。**
- **probe 7件は意図して凍結されている。**時間項を定数に保つ統制条件（既存 probe に時刻を
  書き込まない）は [ADR 0058](./docs/decisions/0058-measure-the-time-term-in-a-separate-arm.md) §1.4
  が置いたもので、1件も足さない・変えない扱いは
  [ADR 0227](./docs/decisions/0227-fixed-retrieval-probe-gold-presence-gate.md) の「決定」節の2番が
  敷いている。件数を足すとカセットを実 API で録り直すことになり、課金と、過去の実測との
  比較の系列が切れることを伴う
  （[ADR 0276](./docs/decisions/0276-retrieval-quality-shadow-verdict-stage1.md)「検討して採らなかった案」の案1）。
  gold/distractor の14件は変更しない。
  **⟹ ゴールデンセットを増やすときは、この集合を書き換えず別の集合を作る**（ADR 0094 がその形）。

### OpenAI 実埋め込みでの偽陽性率の上限（Issue #109 後半）

**Issue #109 の「これが覆るとしたら」第1項（ADR 0094）——標本が数十件になり、その母数で
偽陽性率に上限を置けると実測できたとき——を、識別子・日本語固有名詞・数詞・記号索引の
6群（`text-embedding-3-small`/256次元、実 API）で実測した。**測ったこと・実測した上限の
値と射程（何の揺れに対する上限か）は
[ADR 0316](./docs/decisions/0316-openai-embedding-false-positive-ceiling.md) に記録してある
——⛔ **ここには実測値を写さない**（`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。
測った記録そのものは `examples/chat/openai-embedding-fp-ceiling-measurement.json`
（コミット済み）にある。

**再計測の手順**（`OPENAI_API_KEY` を持つ人が手で行う。CI からは呼ばない）:

```bash
OPENAI_API_KEY=... DATABASE_URL=postgresql://<user>@127.0.0.1:<port>/<db> \
  tsx examples/chat/src/scripts/openai-embedding-fp-ceiling.ts
```

- **鍵の渡し方**: 環境変数 `OPENAI_API_KEY` を、実行するシェルにだけ渡す。スクリプトは
  値をログ・生成物のどちらにも出力しない——呼び出し回数・トークン数・概算費用だけを
  出力とコミット済みの JSON に残す。
- **回数**: 既定 59 回（`MNEMORA_OPENAI_FP_CEILING_ROUNDS` で変更可能）。1回 = 6群が
  要求する全テキストを1回のバッチ embed 呼び出しに投げ、6群それぞれを本物の
  Postgres + pgvector の `recall()` パイプラインに通す。
- **費用の目安**: 1巡あたり概算 $0.0002 前後（`text-embedding-3-small`、テキスト約450件・
  数千〜1万トークン）。59巡+ round 0 で合計 $0.02 に届かない
  （実測の総額は測定記録 JSON の `cost.totalUsd` を見ること）。
- **出力**: `examples/chat/cassettes/identifier-probes.openai.json` /
  `numeral-token-probes.openai.json`（CI が再生するカセット）、
  `examples/chat/identifier-probe-baseline.openai.json` /
  `numeral-token-probe-baseline.openai.json`（基準値。手で更新する。CI は自動更新しない）、
  `examples/chat/openai-embedding-fp-ceiling-measurement.json`（測定記録そのもの）。

**⚠ この測定は「同じモデル・同じコードでの独立な録り直し」に対する上限である。**
モデルの交代や、カセットが日〜週単位で経年するずれ（録画からの日数が空くと埋め込みが
どれだけ乖離するか）には及ばない——射程の詳細は ADR 0316 を読むこと。

外から評価する立場からの現状の評価は、[Issue #109](https://github.com/takecchi/mnemora/issues/109)
に測定付きで書いてある。

---

## ローカルでの開発（手元で CI と同じ認証方式を踏む）

`packages/postgres` / `examples/chat` の検査は本物の Postgres + pgvector を要求する
（擬似物へのフォールバックは無い）。**CI の service container は `POSTGRES_PASSWORD`
を設定しており、これは公式 postgres イメージの host 認証を既定で `scram-sha-256`
にする。** 手元でパスワード無し（`trust` 認証）の Postgres を使っていると、
認証方式に依存する壊れ方（パスワード付け忘れ等）が手元の門を素通りしうる
（[Issue #232](https://github.com/takecchi/mnemora/issues/232) /
[ADR 0130](./docs/decisions/0130-postgres-auth-parity-docker-compose.md)）。

手元でも CI と同じ認証方式を踏みたい場合は、repo ルートの
[`docker-compose.yml`](./docker-compose.yml)（CI の service container と値を
揃えてある）を使う:

```bash
docker compose up -d
# health になるまで少し待つ（`docker compose ps` で確認できる）
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemora_ci \
  pnpm --filter @mnemora/postgres run migrate
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/mnemora_ci pnpm run test
docker compose down
```

**使うかどうかは任意である。** `DATABASE_URL` を渡さない既定の `pnpm run test` の
挙動は変えていない——DB テストは「実行していません」と告知して緑のまま通る
（[ADR 0015](./docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md)）。

`docker-compose.yml` と `.github/workflows/ci.yml` の値が食い違うと、
`scripts/__tests__/postgres-auth-parity.test.mjs` が赤くなる。

---

## インストール

```bash
pnpm add @mnemora/core @mnemora/postgres @mnemora/openai
# または
npm i @mnemora/core @mnemora/postgres @mnemora/openai
```

**Node.js >= 22 と ESM が要る**（CommonJS からは Node 22.12 以降の `require(esm)` で読める）。
`@mnemora/postgres` は本物の Postgres + pgvector を要求する——擬似物での代替は無い。

LLM を Anthropic で回すなら `@mnemora/anthropic` を足す。**ただし埋め込みは別の provider が要る**
——Anthropic は埋め込み API を提供していないため、`@mnemora/anthropic` は `LLMProvider` だけを実装する
（[ADR 0072](./docs/decisions/0072-anthropic-llm-provider.md)）。

adapter を自作してテストするなら `@mnemora/testkit` も devDependency として入れる。
各パッケージの install コマンドと動く最小の例:

- [packages/core/README.md](./packages/core/README.md)
- [packages/postgres/README.md](./packages/postgres/README.md)
- [packages/openai/README.md](./packages/openai/README.md)
- [packages/anthropic/README.md](./packages/anthropic/README.md)
- [packages/testkit/README.md](./packages/testkit/README.md)

---

## 外から見える API

```ts
observe(ctx, input)      // 起きたことを記録する
recall(ctx, query)       // 問いに対して記憶を取り出す
reflect(ctx, opts)       // 入力が無い状態で、既存の記憶から新しい記憶を作る
consolidate(ctx, opts)   // 複数の記憶を統合する
forget(ctx, target)      // 記憶を落とす / 失効させる
```

**内部が複雑でも、記憶そのものを動かす中核操作はこの5つに保つ。ここは増やさない。**

**⚠ 冒頭の構成図にある `Association`（連想枠）は、`@mnemora/core` の `recall()` では
既定で走らない。**`recall()` に `association: { maxCount: 10 }` のように**明示的に渡した
ときだけ**走る（省略時は連想を一切走らせない——`packages/core/src/recall.ts:1132`、
[ADR 0151](./docs/decisions/0151-recall-association-unprompted.md)）。
⟹ **npm から入れたままの既定の振る舞いは「聞かれたことにしか答えない」。**
渡し方・各フィールドの既定値・渡したときの実測値は
[packages/core/README.md](./packages/core/README.md) を見ること。
⚠ **渡すとき、`anchorCount` だけを上げても連想の裾野は広がらない**——連想の起点は
`RecallQuery.limit`（既定 10）の内側から取るので、`limit` が天井になる（同 README /
[docs/recall.md](./docs/recall.md) §9.2）。

### `Runtime` の中核5動詞以外 — 中核を守る3つの層

**`Runtime` には、中核5動詞のほかにもメソッドがある。**⭐ **何が在るかの正本は
`packages/core/src/runtime.ts` の `export interface Runtime` である**——⛔ **ここに個数を写さない**
（写せば `Runtime` にメソッドが1本増えるたびに腐る。`AGENTS.md`「⚠ 数を、道具と生成物に
焼き込まない」と [ADR 0234](./docs/decisions/0234-bake-no-numbers-into-tools-and-artifacts.md)）。
それらは「6つ目の動詞」ではなく、**中核を狭く保つために別の層へ出した口**であり、
3つに分かれる（詳細と検討過程は
[ADR 0171](./docs/decisions/0171-five-verbs-plus-three-layers.md)）。

⚠ **下の3層の列挙は、ADR 0171 が分類した時点のものであり、⛔ いま在るものの全部ではない。**
実際に `findCorrectionCandidates`（[ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md)）は
どの層にも置かれていない——どこへ置くかは意味の判定であり、機械には決まらない
（[Issue #605](https://github.com/takecchi/mnemora/issues/605)）。⛔ **書き込まない口**なので、
少なくとも「是正・取り消し」（**書き込む**口）ではない。

⚠ **`applyCorrection`（[ADR 0242](./docs/decisions/0242-runtime-apply-correction.md)）も、
どの層にも置かれていない。**ただし `findCorrectionCandidates` と同じ理由では説明できない
——`applyCorrection` は `markContested`/`resolveContested` を呼んで実際に書き込む口である
（ADR 0242 決定3）。**「書き込まないから」という除外は使えない**以上、どの層に当たるかは
依然として意味の判定であり、この一覧はそれを決めていない（Issue #605）。

- **保守操作**（`tick` / `reembed` / `reextract` / `sweepArchive`）——「いつ動かすか」を
  呼び出し側が決める口。自動では走らない（`sweepArchive` の doc コメント自身が
  「呼び出し側が明示的にこれを呼んだときだけ走る保守操作である」と書いている）。
- **是正・取り消し**（`markContested` / `resolveContested` / `restoreArchived` /
  `restoreSuperseded` / `purge`）——呼び出し側（人・上位のアプリケーション層・将来の
  自動検出）が既に下した判断（矛盾の指摘・決着・復帰・完全削除）を、決められた形で
  書き込む口。どちらが正しいかを mnemora 自身は判定しない。**⚠ 矛盾を*見つける*処理も
  持たない**——下の「⚠ mnemora が保証していないこと」の節を見ること。
- **説明**（`getRecall`）——なぜそれが想起されたかを、後から読み戻す口
  （`docs/north-star.md`「目指す姿」の3番目）。

**この分類の要点は、歯止めが *どこに* 効くかである。**新しく何かを足したくなったとき、
それが記憶そのものを動かす操作（中核5動詞と同じ性質）なら、足せない。保守・是正・説明の
どれかに当たるなら、その層の性格に合っているかを問う——**「分類できるから足してよい」では
ない。**3層はあくまで**既に在る口**を説明する後付けの整理であり、新しい口を作る免罪符には
しない。

### 「mnemora を使うべきか」を判定する（動詞ではない）

**mnemora を入れるとプロンプトが小さくなるのか、会話ログを全部積むほうが小さいのかは、
会話の長さによって変わる**——短い会話では mnemora のほうが大きい。
その判定は `@mnemora/core` の**純関数**として提供する（[ADR 0147](./docs/decisions/0147-recall-footprint-estimator.md)）。

```ts
import { compareWithFullLog } from "@mnemora/core";

const verdict = compareWithFullLog({
  fullLogChars: transcript.length,        // 会話ログを全部積んだときの文字数（呼び出し側が測る）
  shape: { memoryCountInScope: 120 },     // スコープ内の Memory 件数
});
// verdict.verdict                 → 'mnemora_smaller' | 'full_log_smaller' | 'too_close_to_call'
// verdict.breakEvenFullLogChars   → 会話ログが何文字を超えたら mnemora が小さくなるか
// verdict.reasons                 → なぜそう判定したか（コードで分岐できる形）
```

⚠ **これは「6つ目の動詞」でも、上の保守・是正・説明のどの層でもない。**`Runtime` の
メソッドですらなく、`ctx` も取らない純関数であり、**`recall()` を一度も呼んでいない時点でも
使える**——「mnemora を入れるべきか」を判断したいのは、まさにその時点だからである。
`Runtime` のメソッドにすると DB も provider も配線済みの環境でしか呼べなくなってしまい、
それでは問いに答えられない（[ADR 0147](./docs/decisions/0147-recall-footprint-estimator.md)
決定5、[ADR 0171](./docs/decisions/0171-five-verbs-plus-three-layers.md)）。

⚠ **見ているのは量だけである。**「削っても目的の記憶が落ちていないか」には答えない
（下の「想起の質をどう測っているか」を見ること）。**量で負けていても、想起のために
mnemora を使うという判断はありうる。**

⚠ **同梱の既定係数は、このリポジトリのベンチ（日本語・記録済みカセット）で測った値である。**
自分の環境の値ではない。`calibrateRecallFootprint()` に `recall()` の結果を渡せば較正できる
（新しい計測は要らない）。較正したかどうかは戻り値の `estimate.profileOrigin.kind` で分岐できる。

---

## 記憶を誰に紐づけるか（`tenantId` / `subjectId`）

**上の5つは、すべて第一引数に `ctx` を取る。**その `ctx` が、記憶を誰に紐づけるかを決める。

```ts
// tenantId は必須。subjectId は省略できる。
const ctx = { tenantId: "guild-123", subjectId: "user-456" }

await observe(ctx, input)
const recalled = await recall(ctx, { text: "..." })
```

| | 何の単位か | 跨いだら |
|---|---|---|
| **`tenantId`** | **隔離境界。安全性の単位** | **事故** |
| **`subjectId`**（省略可） | テナント**内**の整理の単位 | 事故ではない |

**この非対称が芯である。**ひとつの Discord Bot をいくつものサーバーへ導入する場合、
**導入先のサーバーが `tenantId`、そのサーバー内の各ユーザーが `subjectId`** になる。
別のサーバーの記憶が出てくることは設計上あってはならない事故だが、同じサーバー内で
ユーザー A と B の記憶が混ざるのは整理の失敗であって、性質が違う。

**⟹ ひとつの DB で複数のエージェントを動かすなら、`tenantId` を分ける。**
`subjectId` を渡すと `recall()` はテナント内のその subject に絞られ、**省略するとテナント全体**になる。

**クロステナントで漏れないことは、`packages/testkit` の適合テストが測っている**——
どの adapter 実装に対しても走る:

- `VectorStore conformance` — 「クロステナントの search には他テナントの vector が現れない」
- `OutboxStore conformance` — 「クロステナントの claimBatch は他テナントの未処理ジョブを返さない」
- `EventStore conformance` — 「クロステナントの list は他テナントのイベントを含まない」

### ⚠ mnemora が保証していないこと

**`tenantId` は呼び出し側が渡す不透明な文字列である。mnemora はテナントの台帳を持たず、
`tenantId` の存在確認も認証もしない。**

**⟹ 隔離は「使う側が正しい `tenantId` を渡すこと」に依存している。**
誰がどの `tenantId` を名乗ってよいかを決めるのは、mnemora ではなく上のアプリケーションである。

詳細は [docs/vision.md](./docs/vision.md) の「Tenant と Subject を混同しない」と
[docs/architecture.md](./docs/architecture.md) §3.7。

**⚠ もう1つある: 矛盾の検出も、mnemora は行わない。**
`markContested` / `resolveContested` は **「この2件は対向する」と*既に決まっている*ものを
書き込む口**であり（上の「是正・取り消し」）、**会話の中から矛盾を*見つける*処理は
`@mnemora/core` に存在しない**（[ADR 0134](./docs/decisions/0134-mark-contested-explicit-operation.md)
決定1・[Issue #197](https://github.com/takecchi/mnemora/issues/197)）。**これは
`findCorrectionCandidates`/`applyCorrection`（ADR 0232/ADR 0242、下記）を挟んでも変わらない**
——それらは「発見」と「呼び出し側が確定させた対を書き込む」口であり、「どれが訂正か」
「関連度の高い候補が本当に相手か」の判定は依然として呼び出し側が持つ。

**⟹ npm から入れたままの既定の振る舞いは「訂正しても、古いほうが出続ける」。**
古いほうを遠ざけるには、**採用側が「どの2件が矛盾しているか」を決めて
`markContested` を呼び、決着を `resolveContested` で渡す**必要がある
（またはその2段をまとめて呼ぶ `applyCorrection` を使う）。
⛔ **どちらが正しいかも、どちらが新しいかも、mnemora は判定しない。**

⚠ **これは `docs/north-star.md`「目指す姿」の項目5「間違いを正すと、古いほうが先に
出てこなくなる」が、出荷物の既定では*まだ*満たされていないということである**
（[docs/roadmap.md](./docs/roadmap.md) §7.13）。**自動検出（会話から「これは訂正だ」を
機械が判定する経路）の設計は [ADR 0185](./docs/decisions/0185-contradiction-detection-path.md)
（状態: 提案）が2軸に分け、そのうち (B)「主張キー」方式は
[Issue #534](https://github.com/takecchi/mnemora/issues/534) の判断により
`v1.0.0` には入れていない**（設計上の却下ではなく、カセット全滅の実費と鍵の制約が理由。
[#371](https://github.com/takecchi/mnemora/issues/371)/[#372](https://github.com/takecchi/mnemora/issues/372)
がその段を引き継ぐ）。**この README はそれらの設計決定を上書きしない。**
具体例と境界の契約は次の節を見ること。

---

## 訂正の境界: `observe()` と `applyCorrection()` は別操作である（Issue #692）

**会話の中で「さっきのは間違いで、本当はこうでした」と言われたことを `observe()` に渡すことと、
古い記憶を実際に失効させることは、別の操作である。自然な訂正の発話を `observe()` すれば
自動で旧情報が消える、と受け取られうる誤解を、具体例で正す。**

### (a) `observe()` だけの場合

```ts
await observe(ctx, { kind: "utterance", text: "私の好きな色は青です。", speaker: "user" });
await observe(ctx, {
  kind: "utterance",
  text: "訂正します。よく考えたら、好きな色は青ではなく赤でした。",
  speaker: "user",
});

const recalled = await recall(ctx, { text: "わたしの好きな色を覚えていますか?", limit: 1 });
```

**何が起きるか**: 2件とも独立した `Memory`（`status: "active"`）として保存される。
**何が起きないか**: どちらの `status` も変わらない。`contestedWithId` / `supersededById` は
どちらも `null` のまま。mnemora は2件の関係を一切記録していない——「これは訂正の発話だ」
という判断そのものを `observe()` は行わない（`observe()` の契約に訂正の検出は無い）。

**実測**（`examples/chat/src/correction-demo.ts` を実際に Postgres に対して走らせ、
書き込み操作に一切進んでいない段階——`findCorrectionCandidates` は呼ばれているが、
これは読み取り専用で DB を書き換えない——で `recall()` した結果。2026-09-25、
deterministic provider、`pnpm --filter @mnemora/example-chat run correction`）:

```
問い合わせ: recall({ text: "わたしの好きな色を覚えていますか?", limit: 1 })
件数: 1
  - "私の好きな色は青です。" (retrievedVia=ann)
```

**⟹ 通常のランキング（`retrievedVia=ann`）だけで答えが決まり、しかもこの実行では
「訂正済みのつもりの古い値」がそのまま単独で返っている。** `contested` / `superseded` の
どちらの印も付いていない——`recall()` から見ると、これは「ただの `Memory`」でしかない。
⚠ **どちらが上位に来るかは埋め込みの質に依存し、実行によって逆になりうる。**
「新しいほうが自然に勝つ」という保証は無い、という契約そのものが本体であって、
この実行での順位の向きは本題ではない。

### (b) 候補探索 → 対象選択 → `applyCorrection`

呼び出し側が「これは訂正だ」と判断したら、次の3段を明示的に踏む:

```ts
// 1. 発見: 既存の recall() を1回呼ぶだけ。書き込み・LLM 呼び出しは無い（ADR 0232）。
const discovery = await runtime.findCorrectionCandidates(ctx, {
  text: "訂正します。よく考えたら、好きな色は青ではなく赤でした。",
  excludeMemoryIds: [correctionMemoryId],
});
// discovery.candidates は関連度順の一覧——mnemora はここでは何も選ばない。

// 2. 選択: どの候補が「訂正される相手」かを、呼び出し側が決める。
//    discovery.candidates[0] を機械的に採らない——下の「関連度だけで確定しない」を参照。
const correctedId = /* 呼び出し側が選んだ memoryId（人が選ぶ・UI で選ばせる 等） */;

// 3. 確定・書き込み: 選んだ相手が候補一覧に実在するかを照合してから markContested する。
const marked = await runtime.applyCorrection(ctx, {
  discovery,
  correctedId,
  correctingId: correctionMemoryId,
});
// marked.kind: "awaiting_choice" | "not_a_candidate" | "contested" | "resolved"
```

**実測**（同じ会話に対して、同じ `findCorrectionCandidates`/`applyCorrection` を実際に
呼んだ結果。2026-09-25、deterministic provider、
`pnpm --filter @mnemora/example-chat run correction`）:

```
--- 0. 発見の段: findCorrectionCandidates(text: 訂正の発話, excludeMemoryIds: [訂正自身]) ---
outcome=candidates / 候補1件
  - #2位 "私の好きな色は青です。" (memoryId=a72fa827-..., score.total=0.80518)
⟹ この候補一覧は棄権しない(ADR 0232 実測: B群8件中0件が棄権)。
   mnemora は候補を出す。だが選ぶのは人であり、人が選ばなければ何も起きない。

--- 2. markContested(指名, 訂正) ⟹ outcome=contested ---
件数: 2
  - "私の好きな色は青です。" (retrievedVia=ann)
  - "訂正します。よく考えたら、好きな色は青ではなく赤でした。"
    (retrievedVia=mandatory_companion, companionOf=a72fa827-...)
⟹ 両方出た: はい / mandatory_companion として出た: はい

--- 3. resolveContested(supersede, winner=correction) ⟹ outcome=resolved ---
件数: 1
  - "訂正します。よく考えたら、好きな色は青ではなく赤でした。" (retrievedVia=ann)
⟹ 古いほうが消えた: はい
⟹ omitted に "superseded" として記録された(=最初から無かったのではなく消えた): はい
```

**⟹ ここで初めて、古い記憶が `recall()` から落ちる。** (a) との差は、mnemora が何かを
賢く判定したことではない——**呼び出し側が `correctedId` を明示的に渡したこと**である。

`applyCorrection` は `resolution` を渡さずに1回呼ぶと `markContested` 相当だけで止まり
（`kind: "contested"`）、その `resolution` を渡した2回目の呼び出しで `resolveContested`
相当まで進む、という2段呼び出しにも対応する（[ADR 0242](./docs/decisions/0242-runtime-apply-correction.md)
決定3。上の実測もこの2段呼び出しで走っている）。

### 関連度だけで対象を確定しない — 否定・曖昧・別人・別期間は失効させてはいけない

**`findCorrectionCandidates` が返す候補は、関連度の高い順に並んでいるだけである。
1位だから訂正の相手だとは限らない。**
[ADR 0232](./docs/decisions/0232-correction-candidates-returned-not-chosen.md) が
実測した数字（23件の手書きケース。⛔ 代表性は主張しない）:

| 群 | 内容 | 結果 |
|---|---|---|
| A（15件、訂正すべき相手が実在） | hit@1 | **100%**（15/15 が1位） |
| B（8件、⛔ 訂正してはいけない） | 棄権率（0件を返す） | **0%**（1件も止まらない） |
| B（8件） | 深い誤爆（守るべき事実を1位に返す） | **75%**（6/8） |
| A/B | score の分布 | **重なっており、閾値では分離できない** |

**B群は次の4分類（`docs/autonomy.md` §2.2 決定1）——実例は
[examples/chat/src/correction-case-set.eval.ts](./examples/chat/src/correction-case-set.eval.ts)
にある held-out ケースから引く**（見て実装や閾値を調整していない集合）:

- **否定**（negation）: 「今朝はジョギングをしませんでした。」——「毎朝6時に起きてジョギングを
  しています」という**習慣**の記憶を失効させてはいけない。1日しなかったことは習慣の否定ではない。
- **曖昧**（vague）: 「やっぱりさっきのは違ったかもしれません。」——何を指しているかが発話から
  決まらない。どの候補を相手として選んでも、選んだ根拠が発話に無い。
- **別人**（other_person、`speaker`/`subject` の違い）: 「訂正します。同僚が生まれ育ったのは
  高知ではなく新潟でした。」——訂正の主語は同僚であり、**本人**の出身地
  （「私が生まれ育ったのは高知です」）には掛からない。
- **別期間**（other_period）: 「去年所属していたのは品質保証チームではなく開発支援チームでした。」
  ——訂正しているのは**去年**の所属であり、「いま所属しているのは品質保証チームです」という
  **現在**の記憶には掛からない。

**この4分類はいずれも、埋め込みの関連度だけを見れば1位（またはそれに近い順位）で返ってくる**
（ADR 0232 実測: 上表の「深い誤爆 75%」の内訳は、否定 2/2・別人 2/2・別期間 2/2・曖昧 0/2）。
**⟹ `applyCorrection` に渡す `correctedId`（＝「これが相手だ」という確定）は、関連度の
ランキングから機械的に導ってはいけない。**発話の主語・時制・法（肯定/否定/推量）まで読んだ
上で、呼び出し側が決める。**mnemora 自身はこの読解を一切行わない**——`findCorrectionCandidates`
は関連度で候補を並べるだけであり、`applyCorrection` は指名が候補一覧に実在するかしか見ない。

### 自動検出は未提供 — どこが呼び出し側の責任か

**mnemora は「この発話が訂正である」ことも、「関連度の高い候補が実際に訂正の相手である」ことも、
自動では判定しない。** 提供しているのは、次の発見と確定の口だけである:

1. **`findCorrectionCandidates`**（発見）— 呼び出し側が「これは訂正の発話だ」と*既に判断した*
   `text` を渡すと、関連度順の候補を返す。⛔ 書き込まない・LLM を呼ばない。
2. **`applyCorrection`**（確定・書き込み）— 呼び出し側が指名した `correctedId` が候補一覧に
   実在するかを照合し、実在すれば `markContested`/`resolveContested` を呼ぶ。⛔ 相手を選ばない
   （`discovery.candidates[0]` を一切参照しない）。

**次の2つの判断は、mnemora が持たない責任範囲であり、呼び出し側（人・上位のアプリケーション層）
が担う**:

- 「この発話は訂正である」という分類（`findCorrectionCandidates` に渡すかどうかの判断）。
- 「関連度の高い候補が、実際に訂正の相手であるか」という確定（`applyCorrection` に渡す
  `correctedId` の選定。上の否定/曖昧/別人/別期間を踏まえる責任）。

**自動検出（会話から訂正を見つけ、対象まで機械が決める経路）は、この issue の範囲外であり、
実装していない。** 既存の関連 issue とその設計決定を上書きしない:

- [#197](https://github.com/takecchi/mnemora/issues/197) — 矛盾の検出経路が1つも無い（親issue）。
- [#371](https://github.com/takecchi/mnemora/issues/371) — (B) 第1段: 抽出に「主張キー」を
  持たせる（検出はまだしない）。
- [#372](https://github.com/takecchi/mnemora/issues/372) — (B) 第2段: 主張キー・重なる有効期間で
  機械的に `contested` にする（`superseded` へは進めない）。
- [#534](https://github.com/takecchi/mnemora/issues/534) — 自動検出（(B) 主張キー方式）は
  `v1.0.0` に入れない（オーナー判断。設計上の却下ではなく、カセット全滅の実費と鍵の制約が理由）。

⚠ **この節は、#371/#372 が引き継ぐ「主張キー」方式（(B)）の設計を一切変えていない。**
決めているのは、その自動検出が着地するまでの間、**出荷物の既定の振る舞い（`observe()`
だけでは何も失効しない）と、明示 API を使った安全な訂正フローが何か**だけである。
**⛔ 本節は「文書によって自動理解を実現した」ことを主張しない**——上の (a)/(b) はどちらも
呼び出し側の明示的な判断を前提にしている。

### 実際に動くコード

- [`examples/chat/src/correction-demo.ts`](./examples/chat/src/correction-demo.ts) — 上の
  (a)/(b) を実際に `Runtime` に対して走らせる、本物の Postgres 向けデモ実装。実行手順・
  成功/保留（`awaiting_choice`/`choice_not_in_candidates`）の扱いは
  [examples/chat/README.md](./examples/chat/README.md) の `correction` 節を見ること。
- [`examples/chat/src/correction-candidate-arm.ts`](./examples/chat/src/correction-candidate-arm.ts) —
  上の A群/B群の数字を再現する評価アーム
  （`pnpm --filter @mnemora/example-chat run correction-candidates`）。
- 型と3態/4態の契約は
  [`packages/core/src/apply-correction.ts`](./packages/core/src/apply-correction.ts) の
  `ApplyCorrectionResult`（`"awaiting_choice" | "not_a_candidate" | "contested" | "resolved"`）。
  歯は
  [`packages/core/src/__tests__/apply-correction.test.ts`](./packages/core/src/__tests__/apply-correction.test.ts)
  （成功・保留・失敗を握り潰さないことを実測。件数は `main` が動けば変わるためここには
  写さない——`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」）。`markContested`/`resolveContested`
  自身が返す `conflict`（並行書き込み時の TOCTOU）は
  [`mark-contested.test.ts`](./packages/core/src/__tests__/mark-contested.test.ts)/
  [`resolve-contested.test.ts`](./packages/core/src/__tests__/resolve-contested.test.ts) が
  検査済みであり、`applyCorrection` はその結果をそのまま運ぶだけで独自の分岐を持たない
  （ADR 0242 決定3 のコメント「`markResult`/`resolveResult` は…そのまま運ぶ」）。

---

## ⚠ 暫定

- **ここに書かれているのは設計であって、実装された事実ではない。**
  実装の進み具合は [docs/roadmap.md](./docs/roadmap.md) を見ること
