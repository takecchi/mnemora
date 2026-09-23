# AGENTS.md

このリポジトリで作業する人・エージェント向けの手引き。

---

## 最初に読むもの

**[docs/north-star.md](./docs/north-star.md) を読むこと。**

そこに、**このプロジェクトが何であろうとしているか**・**何を物差しにするか**・
**迷ったときにどの順で問うか**が書いてある。

**判断に迷ったら、そこへ戻る。**機能を足すかどうか、どちらの設計を採るかは、
北極星の「迷ったときの問い」に当てて決める。**その問いは、実際に案を落とすためにある。**

### ⚠ ここに北極星の要約を置かない

**複製した瞬間から、正文と要約はずれ始める。**
片方を直してもう片方を直し忘れることは、規律ではなく注意力に依存しており、必ず失敗する。

**だから、この文書は北極星を「指す」だけで、中身を持たない。**
`CLAUDE.md` も同じ理由で `AGENTS.md` への symlink であり、独立した中身を持たない。
**要約を置きたくなったら、代わりに北極星のほうを短くすること。**

⭐ **同じ理由は、文書だけでなく道具（script・CI job）と生成物にも当たる。**
そちらは下の「**⚠ 数を、道具と生成物に焼き込まない**」に書いてある——
**ここには繰り返さない**（繰り返せば、この節自身が破っていることになる）。

### 正典と実装が食い違ったら

**バグなのは実装のほうである。**
実装の都合で `docs/north-star.md` を書き換えないこと。
**方向そのものを変えるときだけ、書き換える。**その変更はオーナーの判断である。

---

## いまの状態

**Phase 1（MVP）の実装が一巡した。**`docs/roadmap.md` §2 の段階1〜7 がすべて着地している。

| package | 中身 |
|---|---|
| `packages/core` | 型・interface・`runtime.observe/tick/recall`・純関数の戦略。実行時依存は zod だけ（機械的に検査している） |
| `packages/testkit` | adapter の適合テスト一式（conformance suite）とインメモリのプレースホルダ実装 |
| `packages/postgres` | `MemoryStore` / `VectorStore` / `LexicalStore` / `EventStore` / `OutboxStore` / `TenantSettingsStore`。手書きマイグレーション |
| `packages/openai` | `EmbeddingProvider` / `LLMProvider` |
| `packages/anthropic` | `LLMProvider` の Anthropic 実装。**`EmbeddingProvider` は実装しない**（Anthropic は埋め込み API を提供していないため。[ADR 0072](./docs/decisions/0072-anthropic-llm-provider.md)） |
| `packages/local-embedding` | **外部サービスに繋がない `EmbeddingProvider`**。ONNX のモデルをプロセス内・CPU で推論する（[ADR 0085](./docs/decisions/0085-local-embedding-provider.md)）。⚠ **鍵は要らないが、実行時に4ファイル計42MB（うち重み本体36MB）を落とす**（ADR 0085 決定7の実測） |
| `examples/chat` | サンプル CLI と、**naive（会話ログ全部）と mnemora を実測比較する `compare`** |

**Phase 1 に入っていないもの**は `docs/roadmap.md` §1.3 の通り（関係グラフ本体・reranking・
`reflect()` の実運用・`packages/bullmq`・HTTP server）。

**テストは本物の Postgres + pgvector に対して走る。**`packages/postgres` と `examples/chat` の
検査は `DATABASE_URL` が無いと失敗する——**擬似物へ黙ってフォールバックしない。**
ただし LLM と埋め込みは CI に API キーが無いため実 API を叩かない
（`OPENAI_API_KEY` があれば本物に切り替わる）。この非対称は
[examples/chat/README.md](./examples/chat/README.md) に明記してある。

**⚠ 「実 API を叩かない」は「擬似物で走る」と同じではない。CI のジョブごとに層が違う**
（[ADR 0088](./docs/decisions/0088-retrieval-quality-measured-in-ci.md)）。
`example-chat` ジョブの `compare` も、`retrieval-quality` ジョブも、
**`recorded`（記録した実 API の応答の再生）**で走る——
**鍵は要らないが、擬似物でもない。**下の4層の表で、どのジョブがどの層かを見分けること。

**⚠ `.github/workflows/ci.yml` の `example-chat` ジョブの `name:`（"examples/chat
（本物の Postgres + pgvector、擬似 provider）"）は、この段落が警告している読み違い
そのものを名乗っている——だが**直せない**。この文字列は branch protection の
required status check の*文脈名*であり（【実測】`gh api
repos/takecchi/mnemora/branches/main/protection/required_status_checks` の
`contexts` に逐語で入っている）、変えると required check が「見つからない」
状態になる（branch protection 側の設定変更はオーナー領分）。**訂正は
ジョブ名の直上のコメントに積んである**（同ファイル、`example-chat:` の直下）。
経緯は [ADR 0274](./docs/decisions/0274-required-check-context-name-is-frozen-annotate-dont-rename.md)。

**required status check（上の6件）が branch protection の側で実際に何を指しているかは、
`.github/required-status-checks.json` に宣言（写し）として在り、
`pnpm check:required-status-checks` が突き合わせる**
（[ADR 0279](./docs/decisions/0279-required-status-checks-declaration-and-check.md)）。
**⚠ この突き合わせは CI に繋がっていない——手で実行すること。** 理由は実測済み:
CI の既定の `GITHUB_TOKEN` は `contents: read` / `metadata: read` しか持たず、
`gh api repos/takecchi/mnemora/branches/main/protection` は `HTTP 403 Resource not
accessible by integration` で失敗する（本 PR 自身の CI ジョブでの実測。詳細は
ADR 0279）。**branch protection の設定が変わったかもしれないと疑ったら、
自分の `gh` 認証（`gh auth status`）で手元から `pnpm check:required-status-checks`
を実行すること。** 一致すれば exit 0、ずれていれば exit 1（どちらが正しいかは
道具には決められない——人間が判断する）、読めなければ exit 2。

**provider は4層ある**（[ADR 0051](./docs/decisions/0051-recorded-provider-cassette.md)が
`deterministic`/`recorded`/`openai` の3層を、[ADR 0085](./docs/decisions/0085-local-embedding-provider.md)
が4層目の `local` を導入している）。**用途で使い分けること。**

| 層 | 何か | 使う場所 |
|---|---|---|
| `deterministic` | 意味を持たない stub（文字コードからベクトルを作る／発話を40字で切る） | 配線・契約・適合テスト |
| `recorded` | 記録した実 API の応答の再生。**記録に無い入力は例外** | 北極星の物差し（`retrieval` / `compare`） |
| `openai` | 実 API | 記録を録るとき・乖離を測るとき |
| `local` | 外部サービスに繋がない、プロセス内 ONNX 推論（`@mnemora/local-embedding`、[ADR 0085](./docs/decisions/0085-local-embedding-provider.md)）。**擬似物ではなく実推論**。⚠ **embedding 専用——LLM 側に `local` は無い**（`examples/chat/src/providers.ts` の `ProviderMode`） | CI の `identifier-probes` / `consolidation-cost` / `archive-sweep-cost`（3ジョブとも `MNEMORA_EMBEDDING=local` を固定で使う） |

**⚠ 上の3ジョブ（`identifier-probes` / `consolidation-cost` / `archive-sweep-cost`）の数字を
`deterministic` の行に当てはめないこと。**`local` は本物の ONNX 推論であり、
「性能について何も言っていない」という次段の警告は `deterministic` にだけ掛かる。

**⚠ `recorded` で測った `compare` の数字も、「実運用でも同じ削減率になる」ことを
保証しない。**理由は「擬似物だから」ではない——**カセットは記録した時点の応答の再生**
であり（[ADR 0051](./docs/decisions/0051-recorded-provider-cassette.md)）、記録に無い
入力は黙って別のものへ倒れず例外になる。割り引くのは、擬似物だからではなく、
**記録した時点のものだからである。**

**⚠ `deterministic` で測った想起の質は、性能について何も言っていない**——arm A の MRR は
**0.018**（実質ランダム）である。**擬似物での ✅ を「引けた」と読まないこと。**

**ルートの `pnpm run test` は、DB テストを走らせたかどうかを必ず報告する。**
`DATABASE_URL` が無ければ**「実行していない」と名指しで出力して緑のまま通り**、
在れば DB テストも実行して**落ちれば赤くなる**。**緑をそのまま「全部通った」と読まないこと**——
出力に「DB テストは実行していません」と出ていたら、その門は DB 側を見ていない。
理由と、採らなかった案は [ADR 0015](./docs/decisions/0015-root-test-gate-reports-skipped-db-tests.md)。

---

## 手元で Postgres を立てる（`packages/postgres` の変異試験のため）

**`docs/autonomy.md` §2 は PR を出す条件に「歯が実際に噛むことを、変異試験で示した」を挙げている。**
`packages/postgres` の実装に対してこれを満たすには、**手元に本物の Postgres + pgvector が要る。**

**⚠ `docker compose up` を実行できない担い手が居る**（[Issue #247](https://github.com/takecchi/mnemora/issues/247)
が 2026-09-15 に実測。docker も podman も無い）。**そういう環境でも、`initdb` で自分専用の
インスタンスを立てられることがある。**下はその手順である。

**⚠ この手順は「どの担い手の環境でも通る」ことを主張しない。**
【実測】2026-09-17、`initdb` と pgvector が在る器で通った、というだけである。
**バイナリ自体が無い器では通らない**——その場合は Issue #247 の「考えられる方向」へ戻ること。

### 在るかどうかを先に見る

```bash
ls /usr/lib/postgresql/*/bin/initdb          # サーバのバイナリ
ls /usr/share/postgresql/*/extension/vector.control   # pgvector
```

**両方無ければ、この手順は使えない。**片方だけでも使えない（pgvector が無いと
`0001_init.sql` が通らない）。

### ⛔ 共有資源に触らない

**他の担い手と同じ器を共有していることがある。**次を守ること:

- **既定のポート 5432 を使わない。自分専用のポートにする。**
- **`pg_ctlcluster` / システムのサービスを使わない。**既存のインスタンスを起動・停止しない。
- **データディレクトリと socket ディレクトリを、自分の作業ディレクトリの下に作る。**

### 手順

```bash
export PATH=/usr/lib/postgresql/17/bin:$PATH

# ⚠ 3つとも自分専用の値にすること
PGDATA=/path/to/your/work/pgdata
PGPORT=<自分専用ポート>          # ⛔ 5432 は使わない
PGSOCK=/path/to/your/work/pgsock

mkdir -p "$PGSOCK"
initdb -D "$PGDATA" -U worker --auth=trust --encoding=UTF8 --locale=C
pg_ctl -D "$PGDATA" -l /path/to/your/work/pg.log \
  -o "-p $PGPORT -k $PGSOCK -c listen_addresses=127.0.0.1" start

createdb -h 127.0.0.1 -p "$PGPORT" -U worker mnemora_test
psql -h 127.0.0.1 -p "$PGPORT" -U worker -d mnemora_test \
  -c "CREATE EXTENSION IF NOT EXISTS vector;" \
  -c "CREATE EXTENSION IF NOT EXISTS btree_gin;" \
  -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"

export DATABASE_URL="postgresql://worker@127.0.0.1:${PGPORT}/mnemora_test"
pnpm install --frozen-lockfile
pnpm --filter @mnemora/core run build
pnpm --filter @mnemora/postgres run build
pnpm --filter @mnemora/postgres run migrate
pnpm --filter @mnemora/postgres run test:db

# 使い終わったら
pg_ctl -D "$PGDATA" stop
```

**拡張の3本（`vector` / `btree_gin` / `pgcrypto`）は `.github/workflows/ci.yml` の
`postgres` ジョブと同じである。**片方だけ増やさないこと。

### 1本に絞って走らせる（変異試験はこちら）

**`test:db` 全体は約4分かかる**【実測】。変異試験では毎回これを待たないこと:

```bash
pnpm --filter @mnemora/postgres exec vitest run \
  src/__tests__/conformance.postgres.test.ts -t "<it の名前の一部>"
```

### ⛔ 変異を戻すのに `git checkout` を使わない

**`git checkout <file>` は未コミットの編集も一緒に消す**（`docs/autonomy.md` の「穴」の表。
実際に3ファイル失われている）。**`cp` で退避し、`cp` で戻すこと。**

```bash
cp packages/postgres/src/memory-store.ts /tmp/memory-store.ts.orig   # 退避
# ... 変異を入れる → 狙った it が赤くなることを確認 ...
cp /tmp/memory-store.ts.orig packages/postgres/src/memory-store.ts   # 戻す
git status --porcelain                                                # 空になることを確認
```

**戻した後、同じ it が緑に戻ることまで実測すること。**「赤くなった」だけでは、
壊したのが狙った歯なのか別のものなのかが分かれていない。

**この手順で実際に何が測れたかは
[ADR 0183](./docs/decisions/0183-local-postgres-makes-postgres-mutation-testing-possible.md)。**

---

## 文書の地図

| 文書 | 何が書いてあるか |
|---|---|
| [docs/north-star.md](./docs/north-star.md) | **正典。**目的 / 目指す姿 / 物差し / 迷ったときの問い / やらないこと |
| [docs/vision.md](./docs/vision.md) | プロジェクトの理解 / 用語 / 設計上の非目標 / 名前 |
| [docs/architecture.md](./docs/architecture.md) | 全体アーキテクチャ / package 構成 / 主要 interface |
| [docs/memory-model.md](./docs/memory-model.md) | DB schema 案 / Memory lifecycle / provenance / 矛盾 / 忘却 / 監査ログ |
| [docs/recall.md](./docs/recall.md) | Recall pipeline / 「無い」の分類 / 目次帯 / 量の計測と予算 |
| [docs/conformance.md](./docs/conformance.md) | **適合テストが何を検証し、何を検証していないか** — 走らない歯 / 実 API に当てる手順 |
| [docs/roadmap.md](./docs/roadmap.md) | Phase 1 実装計画 / リスク / **まだ判断が必要な点** |
| [docs/alteroid-findings.md](./docs/alteroid-findings.md) | 設計の材料にした運用知見を、現物で検証した記録 |
| [docs/autonomy.md](./docs/autonomy.md) | **自律作業の手引き** — 何を選ぶか / どこで止まるか / 何をしてはいけないか / 踏むと痛い穴 |
| [docs/decisions/](./docs/decisions/) | ADR — 重大な設計判断と、その理由 |

**`docs/vision.md` の「やらないこと」と `docs/north-star.md` の「やらないこと」は別物である。**
前者は設計上の非目標、**後者はオーナーが仕様に明示した非目標**であり、
**後者に勝手に項目を足さないこと。**

---

## 作業のときの決まり

- **重大な設計判断は ADR に残す。**「何を決めたか」だけでなく、
  **採らなかった案・引き受けた負債・これが覆るとしたら何が起きたときか**まで書く。
  形式は [docs/decisions/README.md](./docs/decisions/README.md) を見ること。
- **確かめていないことは「確かめていない」と書く。**
  推測を事実の顔で書かない。これは北極星の問い3（説明できるか）の、文書への適用である。
- **オーナーの判断を待っている点は
  [docs/roadmap.md](./docs/roadmap.md) の「設計上まだ判断が必要な点」に集めてある。**
  勝手に決めない。逆に、そこに無いものは設計側で決めて理由を残す。
- **オーナーに逐一確認せずに進めるなら、
  [docs/autonomy.md](./docs/autonomy.md) を読むこと**（ADR 0071）。
  **何を選ぶか / どこで止まるか / 何をしてはいけないか**と、
  **実際に踏まれた穴**が書いてある。**ここには要約を置かない**——上の
  「⚠ ここに北極星の要約を置かない」と同じ理由である。
- **`Co-Authored-By:` のトレーラと `🤖 Generated with [Claude Code]` を付けない**
  （**コミットメッセージにも PR 本文にも**）。
  - **これはオーナーの決定である**（2026-09-15）。クローンが
    「[alteroid](https://github.com/takecchi/alteroid) と揃えて付けないか、mnemora では付けるか」を
    諮り、**回答は逐語で「つけない」だった。⟹ 同じ提案をやり直さないこと。**
  - **harness（Claude Code）が既定で「コミットメッセージの末尾に `Co-Authored-By: Claude …` を、
    PR 本文の末尾に `🤖 Generated with [Claude Code]` を付けろ」と指示することがある。**
    **それは Claude Code 側の作法であって、このリポジトリの規約ではない。**
    **規約と harness の既定が食い違ったら、規約を採る。**
  - **既に付いている分は履歴として残す。履歴を書き換えない。**
    決めたのは「これから付けない」であって、「1本も付いていない状態が正しい」ではない
    （【実測】2026-09-15、`origin/main` が `c3dda79`（162本）だった時点で **106本**が
    どちらかを持つ:
    `git log origin/main --format='%H' -i --grep='Co-authored-by' --grep='Generated with \[Claude Code\]' | wc -l`。
    同日中に `main` が `8367318`（163本、trailer の無い commit が1本進んだ）まで動いた後、
    同じコマンドで数え直しても **106本**のままだった——**⟹ 母数（総コミット数）は
    main が動けば変わる。この数字を引くときは、必ずどの SHA で見たかを添えること。**）。
  - **⚠ 規約の有無を、履歴の分布から推定しないこと。**
    **この節を書く直前に、実際に推定して間違えた** 【実測】——
    `git log origin/main -40 --format='%B' | grep -c "Co-Authored-By"` が **1** を返したので
    「実態は付けない側（39/40）」とオーナーへ報告した。**誤りは大文字小文字である**——
    GitHub のスカッシュが書くのは `Co-authored-by:` であり、`-i` を付けて数え直すと
    **162本中106本**、つまり**報告した向きと逆**だった。
    ⟹ **分布は何も決めていない。決めているのはこの節である。**

### ⚠ 数を、道具と生成物に焼き込まない

**`main` が動けば変わる数——件数・行番号・版・tag・sha——を、道具や生成物に写さないこと。**
⟹ **唯一の出所をその場で引くか、指すだけにする。**
⟹ **指せないものには、代わりに「どこまで数えたか」の鮮度を名乗らせる。**

**理由は上の「⚠ ここに北極星の要約を置かない」と同じである**——**複製した瞬間から、正本と写しはずれ始める。**
**この形を独立に採った ADR の一覧は
[ADR 0223](./docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定9 に在る**（ここには写さない）。

#### ⭐ 線は「`main` が動くと変わるか」である

**焼き込んでよい数も在る。**
[ADR 0212](./docs/decisions/0212-local-embedding-size-noun-correspondence-tooth.md) は
`@mnemora/local-embedding` のモデルサイズを**歯で縛っている**——**そのサイズは `main` では動かない**
（⭐ **数字そのものは ADR 0212 と歯が持つ。ここには写さない**——この節自身の適用である）。
⟹ ⛔ **「数字が書いてある」だけを理由に直しにいかないこと。**先にこの線を当てる。

#### ⛔ 対象外 —— **実測して repo にコミットした基準値**

**CI の実測 artifact をそのまま基準値としてコミットしたものは、この規律の対象ではない。**
**それは複製ではなく、測った記録そのものである**
（[ADR 0119](./docs/decisions/0119-archive-sweep-cost-bench.md) 決定6 /
[ADR 0121](./docs/decisions/0121-bench-baselines-from-ci-artifacts.md) 決定1 /
[ADR 0133](./docs/decisions/0133-compare-baseline-and-gate.md) 決定1 /
[examples/chat/README.md](./examples/chat/README.md)）。

⚠ **この対象外が書かれていなかったために、実際に誤った判定が出ている**——
[Issue #403](https://github.com/takecchi/mnemora/issues/403) で「基準値を実測で更新する案は
この規律に反する」として一度却下され、後に撤回された。

⭐ **見分ける問いは1つ**: **その数は、どこか別の場所に在る正本の*写し*か。
それとも、それ自体が*測った記録*か。** ⟹ **写しなら指す。記録なら残す。**

### ⚠ 機械には「検出」まで — 確定と書き込みは人に残す

**歯（機械検査）の担当は「検出」までである。「確定」と「書き込み」は人に残す。**
⟹ **機械が判定できなかったときは、従来どおりに倒さず赤／保留で止める。**

**同じ理由を、担い手が打つコマンドの書き方として先に持っているのが
[docs/autonomy.md](./docs/autonomy.md) §4.1「静かに失敗する道具」の
「副作用のある手（`gh issue close`・`gh pr merge`・`git push`）を、判定と同じ行に繋がない。
`if` で明示する」である**（ここには写さない）。**この節が足すのは、その一手のさらに手前
——この repo で*新しく作る道具*（script・CI job）自体を、どこまで自動化してよいかという
*設計*の規律である。**

**この形を独立に採った ADR の一覧は
[ADR 0223](./docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定2 に在る**（ここには写さない）。

#### ⭐ 線は「repo の中（戻せる）か、GitHub 側の取り消しにくい面か」である

**線は「機械が書き込むか」ではない。**
[ADR 0179](./docs/decisions/0179-adr-number-assigned-at-merge.md) の `adr-renumber.mjs` は、
ファイル名・見出し・このブランチが足した参照を機械的に書き換える——**機械が書き込む。**
だがそれは repo の中の変更であり、`git mv` も含めて戻せる。

[ADR 0211](./docs/decisions/0211-check-pr-adr-reference-catches-abandoned-numbers-in-title-and-body.md)
が引いている線はもう一段外に在る——**PR タイトルと本文（squash commit のタイトルと本文）は
機械が直せない。**だから同 ADR は検出して CI を赤にするところまでで止め、
`gh pr edit --title / --body` を機械に打たせる案を退けている。

⟹ **割れているのは「repo の中（戻せる）か、GitHub 側の取り消しにくい面（PR・issue の状態や
squash commit の本文）か」である。**新しく作る道具が repo の中だけに書き込み、かつ戻せるなら、
機械が確定・書き込みまで担ってよい余地がある（ADR 0179 の実例）。**GitHub 側の
取り消しにくい面へは、検出までに留め、確定と実行を人に残す**（ADR 0211 の実例）。

### ⚠ 偽陽性率に上限を置けない検査は門にしない

**門（落とす検査）にしてよいのは、偽陽性率に上限を置けると実測できたものだけである。**
⟹ **置けないなら門にせず、代わりに置いたもの（観測口・警告・候補一覧・人手監査）を
同じ場所に明記する。**

**同じ形を、設計案を選ぶ問いとして先に持っているのが
[docs/north-star.md](./docs/north-star.md)「迷ったときの問い」と
「この問いが、実際に案を落とすことの確認」である**（ここには写さない）。**この節が足すのは、
設計案を選ぶ問いではなく、CI に置く*機械の門*そのものについての版である。**

**この形を独立に採った ADR の一覧は
[ADR 0223](./docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定3 に在る**（ここには写さない）。

#### 🔴 線は引けない — [ADR 0178](./docs/decisions/0178-public-api-surface-gate.md) が反例

**偽陽性率に上限を置けない検査は門にしない。⚠ ただし
[ADR 0178](./docs/decisions/0178-public-api-surface-gate.md) は偽陽性を承知で門にしている。
どちらに倒すかの線は、いまのところ書けていない —— 判断するときは両方の ADR
（[ADR 0088](./docs/decisions/0088-retrieval-quality-measured-in-ci.md) /
[ADR 0094](./docs/decisions/0094-identifier-probes-local-embedding.md) と
[ADR 0178](./docs/decisions/0178-public-api-surface-gate.md)）を読むこと。**

経緯・測ったこと・線がまだ書けない理由は
[ADR 0254](./docs/decisions/0254-no-gate-without-a-false-positive-ceiling.md) に在る
（ここには写さない）。

### ⚠ 名乗れないものを道具に名乗らせない — 判定ではなく候補の一覧で出す

**取りこぼしがゼロにならないと分かっている道具に、「これが全部です」と名乗らせないこと。**
⟹ **判定（exit 非0 を「これで全部」の主張として使う）ではなく一覧として出し、取りこぼす側と
余計に拾う側の実例を、出力そのものに焼くこと。**

**同じ規律を、人が書く報告について先に持っているのが、このすぐ上の「確かめていないことは
「確かめていない」と書く」と [docs/autonomy.md](./docs/autonomy.md) §5「報告に必ず書くこと」
である**（ここには写さない）。**この節が足すのは、宛先が人の文章から*道具の出力*へ
移った版である。**

**この形を独立に採った ADR の一覧は
[ADR 0223](./docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定5 に在る**（ここには写さない）。

#### ⭐ 線は「取りこぼしが検査の対象の中で構造的か、対象の外の宣言で足りるか」である

**射程だけを広げると、対象を機械的に確定できる検査——2つのテキストの完全一致、実物の
ファイルの構文解析のような、検査それ自体が対象の外延と一致するもの——まで、毎回の出力に
取りこぼしの実例を焼くことを求めてしまう。**そこに構造的な取りこぼしは無い。**この種の
検査が持つ「保証しない範囲」は対象の外に在る宣言であり、出力にではなくソースの説明
（ADR やコード中の doc コメント）に書けば足りる**
（[ADR 0184](./docs/decisions/0184-conformance-scope-documented-not-closed.md) の形）。

**この節が求めるのは、検査の対象そのものが機械的に確定できないとき**——
[ADR 0214](./docs/decisions/0214-release-candidates-lists-not-judges.md) の
`release-candidates.mjs` がその実例——「どの commit が破壊的変更か」は commit の書き方
だけでは決まらない。**そのときは exit を判定に使わず、取りこぼす側・余計に拾う側の実例を
出力へ焼く。**

### ⚠ 「出なかった」を、事象が無いことの証明にしない — 先に陽性対照を示す

**「再現しなかった」「ヒットしなかった」を積み重ねても、事象が起きないことの証明にはならない。
探り棒が弱いのか、事象が起きないのかが、分かれていないからである。**
⟹ **先に、その事象を*意図的に起こして*、探り棒がそれを捕まえることを示す（陽性対照）。**

**同じ理由を、変異試験という1本の手順に閉じた形で先に持っているのが、この文書自身の
「⛔ 変異を戻すのに `git checkout` を使わない」節（上、「戻した後、同じ it が緑に戻ることまで
実測すること。「赤くなった」だけでは、壊したのが狙った歯なのか別のものなのかが分かれていない」）と
[docs/autonomy.md](./docs/autonomy.md) §2 の止まる条件（「歯が実際に噛むことを、変異試験で示した
——壊した入力で赤く、直したら緑に戻る」）である**（ここには写さない）。**この節が足すのは、
その手順のさらに手前——変異試験に限らず、「出なかった」を根拠に何かを主張するとき全般に
当たる*一般則*である。**

**この形を独立に採った ADR の一覧は
[ADR 0223](./docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定6 に在る**（ここには写さない）。

#### ⭐ 線は「『出なかった』を根拠にするときだけ」である

**陽性対照が要るのは、「出なかった」を根拠にして何かを主張するときだけである。**
「出た」を報告するときは要らない——**出たこと自体が、探り棒が生きていたことの証明になる。**
⟹ **すべての報告に対照を要求しない。**

### ⚠ 「無かった」と書く前に、探した場所を列挙する

**「無い」「見つからなかった」と書く前に、探した場所（コマンドと対象）を列挙すること。**
⟹ **列挙できないなら「当たった範囲での結果であり、断定ではない」と書く。**

**入口に在るのは、この規律の向きが逆の版である**——
[docs/north-star.md](./docs/north-star.md)「目指す姿」に在るのは、
**`mnemora`（製品）が使う側に対して満たすべき姿**としての版である
（⛔ ここには写さない——上の「⚠ ここに北極星の要約を置かない」と同じ理由）。
**この節が足すのは、同じ規律を書き手・担い手が自分の調査手続きへ当て直した版である**
——**同じ言葉が、別の宛先にも効くことを明示する。**

**これは上の「確かめていないことは『確かめていない』と書く」とは別の規律である。**
あちらは推測を事実の顔で書かないという一般則（肯定・否定どちらの主張にも効く）。
こちらは「無かった」という**否定の主張**に対して**具体的にどこを当たったかを列挙する**、
より狭く具体的な要求である。

**この形を独立に採った ADR の一覧は
[ADR 0223](./docs/decisions/0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md)
決定10 に在る**（ここには写さない）。

#### ⚠ 例外 —— 列挙は網羅を示さない

**列挙した探し先が網羅であることは、列挙しただけでは示せない。**
[ADR 0140](./docs/decisions/0140-contested-write-side-companion-required.md) は、
`grep` を横断して「対向無し `contested` 生成箇所は見つからなかった」と書いたあとで、
その `grep` 自身が別の箇所を一度見落としていたことを自分で記録している——見落とした箇所は、
CI の DB ジョブが実際に走って初めて表面化した。
⟹ **「探した場所を書け」は「網羅を証明せよ」ではない。**書かないと、探索の報告が
無限に重くなる。

---

## 名前について

**名前は `mnemora`、スコープは `@mnemora/*` に確定している。**もう仮ではない。
npm の org `@mnemora` はオーナーが作成し、使用できることを確認した（確認したのは
オーナーであり、このリポジトリの作業者ではない）。

**`mnemo` / `@mnemo/*` という旧名で新しい記述を書かないこと。**ただし
`docs/vision.md`「名前について」の経緯節・`docs/roadmap.md` §5.1 と §6・
`docs/memory-model.md` の「確かめていないこと」に残る `mnemo` は**当時の記録であり、
書き換えない**（他人の npm パッケージ `mnemo` と Rufus::Mnemo への言及を含む）。

決定の記録は [ADR 0014](./docs/decisions/0014-package-name-mnemora.md)、
改名前の経緯は [docs/vision.md](./docs/vision.md) の「名前について」にある。
