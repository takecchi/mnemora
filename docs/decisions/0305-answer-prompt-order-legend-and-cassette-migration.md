# ADR 0305: `buildMnemoraPrompt` を `order-legend` 描画に確定し、`answer`/`answer-time-weighting` の再生カセットを新形式へ移行する（Issue #691 続き）

- **状態**: 採用 (2026-09-25)
- **日付**: 2026-09-25

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0295 / 0296 / 0301 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が自分の手で `vitest` / `tsc` / `sha256sum` 等を走らせて確かめた。
- **【受】** — 前の担い手（本 Issue の同じ作業列、API の枠切れで中断した担い手）が実施し、
  マネージャーから逐語で引き継いだ値・判断。この書き手は実 API を一切叩いていない
  （マネージャーの指示による絶対の禁則）ため、**§2 の n=15 の表は【受】である**。

断りの無い【現物】【実測】は、本 ADR の書き手が作業を引き継いだ時点の枝
（`feat/691-answer-prompt-recorded-order-legend`、前の担い手のコミットまで）を対象に、
2026-09-25 に行った。**DB（Postgres）は本作業の環境に用意した**（`initdb` で自分専用の
インスタンスを立てた。`AGENTS.md`「手元で Postgres を立てる」の手順）——ただし
**実 API は一度も叩いていない**ので、後述する新形式カセットの実測はできていない。

---

## 1. 文脈

### 1.1 【受】ここまでの経緯

[Issue #691](https://github.com/takecchi/mnemora/issues/691) は
[ADR 0295](./0295-answer-prompt-provenance-rendering.md) で由来・話者・主題・矛盾候補の
描画を実装し、追記2で `schedule-change-meeting-day`（「金曜→水曜」の訂正が後続するケース）
の正答率が同じ記憶集合の n=15 試行で 8/15 → 3/15 まで落ちる退行を発見した
（オーナー判断で revert はしない・残作業として Issue #691 に残す、と記録済み）。

前の担い手は、この退行に対する描画の候補比較（本 ADR §2 の表）を終え、
`schedule-change-meeting-day` で最も安定していた `order-legend`
（`recall.memories` を `recordedAt` 昇順に並べ替え、1件以上記録順を持つときだけ
先頭に凡例1行を足す描画）を `buildMnemoraPrompt`（`examples/chat/src/mnemora-path.ts`）
へ実装し、契約テスト・`answer-trials-render.ts` の描画レジストリ整理・変異試験3種まで
終えた時点で、**API の枠切れにより中断した**。本 ADR の書き手は、その続き
（残作業 A〜D、マネージャー指示）を引き継いでいる。

### 1.2 【現物】本 ADR の書き手が実際に行ったこと

1. **呼び出し元の洗い出しと、記録の再生が壊れる箇所の特定**（§3）。
2. **カセットの配線変更**: 既存カセット（`answer.json`/`answer-time-weighting.json`）は
   1バイトも書き換えず、新形式カセットへの向き先（`ANSWER_ORDER_LEGEND_CASSETTE_PATH`/
   `ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH`、まだファイルは存在しない）を
   `examples/chat/src/cassette-io.ts` に追加し、`record`/`verify`/CLI の再生
   （`cassettePathFor` 経由）と、影響する `*.postgres.test.ts`・`cassette-coverage.test.ts`
   をそちらへ向けた（§4）。**実 API を叩いていないため、新形式カセットはまだ存在せず、
   該当する歯は意図して赤いまま止めてある**（§4.3）。
3. **前の担い手が仮置きしていた ADR 番号（0304）を、実際に採番できる番号（0305、本 ADR）へ
   修正した**——`node scripts/adr-renumber.mjs --next` を引き継ぎ時点で実行したところ、
   `main` は 0302 までで、open な PR #711/#713 が 0303 を、#712/#715 が 0304 を既に
   主張しており、`--next` は 0305 を返した【実測】。
4. 本 ADR の執筆、[ADR 0295](./0295-answer-prompt-provenance-rendering.md) への追記3、
   `examples/chat/README.md` の更新、ADR 索引の再生成。

## 2. 決定: `order-legend` 描画を採用する【受、前の担い手の実測】

### 2.1 対照の条件

同じ記憶集合（`examples/chat/cassettes/answer.json`、sha256
`303d59031935cbcabad9c55aa9e4b605e697944359d3a71196f4b11ce58acd7b`——本 ADR の書き手が
【実測】で再確認済み）・同じモデル（`gpt-4o-mini`）・既定 temperature・一次判定のみ
（`gradeAnswer`、文字列包含。二次観測 judge は使っていない）・n=15・
`answer-case-set.dev.ts` の dev 6件だけ（eval は一度も見ていない、ADR 0295/0301 と同じ
絶対の線）。ADR 0301（Issue #705）が作った「同じ記憶集合で n 回試行する器」
（`answer-trials`/`answer-trials-render.ts`）で測った。

### 2.2 結果

| 描画 | `schedule-change-meeting-day` | 他の dev 5件 |
|---|---|---|
| `recorded`（PR #698 書式。由来・話者・主題・矛盾候補・生の記録順タグ） | 3/15 | 各15/15 |
| `digest-only`（Issue #691 以前。タグを一切付けない） | 9/15 | 各15/15 |
| `order-sorted`（`recordedAt` 昇順への並べ替えだけ。凡例なし） | 5/15 | 各15/15 |
| `order-sorted-legend`（並べ替え＋凡例1行。**採用、以後 `order-legend`**） | 13/15 | 各15/15 |
| `digest-order-legend`（由来等のタグを落とし、並べ替え＋凡例だけ残す） | 13/15 | 各15/15 |

**他の dev 5件はどの描画でも 15/15 のまま揺れない**——ADR 0295 追記2 §11 の記録と整合する
（このケース1件だけが `digest のみ` でも揺れる、訂正関係を含む特異なケースである）。

### 2.3 採用: `order-legend`（並べ替え＋凡例、由来等のタグは保つ）

`schedule-change-meeting-day` で 13/15 まで戻し、かつ `recorded`（3/15）が持っていた
由来・話者・主題・矛盾候補のタグ（ADR 0295 決定3〜6、Issue #691 完了条件1「由来・話者・
主題・矛盾関係をプロンプトで表現する」の直接の実装）を落とさない描画は、この5候補の
中では `order-sorted-legend`（採用時に `order-legend` へ改称）だけである。

実装は `examples/chat/src/mnemora-path.ts` の `sortMemoriesForDisplay`/`ORDER_LEGEND_LINE`
——`recordedAt` を持つ行だけを昇順に並べ替え、持たない行は元の配列順のまま末尾に残す
（欠落値を先頭に回したり他の値で埋めたりしない、Issue #691 完了条件1・ADR 0298 決定7と
同じ規律）。1件以上が記録順を持つときだけ、本文の先頭に凡例
`(記録順: 数が大きいほど後に記録された。行は記録の古い順に並べてある)`
を1行足す。

### 2.4 採らなかった案とその理由

- **`recorded`（現状維持）**: 3/15 のまま——ADR 0295 追記2 が発見した退行そのものであり、
  維持する理由が無い。
- **`digest-only`（Issue #691 以前へ戻す）**: 9/15 まで戻るが、Issue #691 完了条件1
  （由来・話者・主題・矛盾関係の描画）そのものを撤回することになる。ADR 0295 が実装した
  誤帰属検知の土台（`answer-case-set.eval.ts` の
  `eval-misattribution-order-swapped`/`eval-inferred-habit-not-attributed-to-user`、
  Issue #691 完了条件4）が使う由来等のタグが消える——**この2件は eval であり本 n=15
  対照では測っていないが、タグを消す変更が土台を壊す方向であることは構造的に明らかである**。
  採らない。
- **`order-sorted`（並べ替えのみ、凡例なし）**: 5/15 に留まる。**この結果が示すのは、
  効いているのは並べ替えそのものではなく凡例であるらしいことである**——並べ替えだけでは
  13/15 まで戻らず、凡例を足して初めて戻る。⚠ **ただし「凡例だけを足して並べ替えは
  しない」描画（`legend-only`、並べ替えは `recall()` のスコア順のまま・凡例文だけ足す）は
  この5候補に無く、測っていない。** ⟹ 「並べ替えが要らない」ことまでは、この対照からは
  言えない——言えるのは「並べ替えだけでは足りない」ことだけである。この切り分けは
  引き受けた負債（§6）に残す。
- **`digest-order-legend`（由来等のタグを落とし、並べ替え＋凡例だけ残す）**: 13/15 と
  `order-legend` と同点だが、**由来・話者・主題・矛盾候補のタグを落とす**——`digest-only`
  と同じ理由（Issue #691 完了条件1・4、ADR 0295 決定3〜6が足した欄を落とすと、
  ADR 0295 が完了条件4のために置いた eval の誤帰属検知ケースの土台を壊しうる）で採らない。
  **同点であることは「タグを残す代償が無い」ことを意味しない**——この2案の同点は
  `schedule-change-meeting-day` という1ケースの上でのものであり、タグを落とす影響は
  eval 側（本対照の対象外）に出る可能性がある。

## 3. 呼び出し元の洗い出しと、記録の再生が壊れる箇所【現物・実測】

`buildMnemoraPrompt` の呼び出し元（`grep -rn buildMnemoraPrompt examples/chat/src`
【実測】、`__tests__` を除く）:

| 呼び出し元 | 用途 | `recorded` provider を経由するか |
|---|---|---|
| `answer-bench.ts`（`runAnswerCase`） | `answer`/`answer-trials` 系の回答生成プロンプト組み立て | する（呼び出し側次第。`answer-bench.postgres.test.ts` は `deterministic` 強制なので経由しない） |
| `cli.ts`（`runChat`） | `chat` サブコマンドの画面表示（`console.log`。LLM へは送らない） | しない |
| `time-weighting-bench.ts`（`runTimeWeightingTrial`） | `answer-time-weighting` の回答生成プロンプト組み立て | する |
| `budget-demo.ts` | docstring のみの言及。実装は `cli.ts` 側の既存経路を再利用 | （変更なし） |
| `answer-retention-mutation.ts` | docstring のみの言及（`applyRetentionMutation` は `PromptSpec` を受け取るだけ） | （変更なし） |
| `answer-case-set.eval.ts` | docstring のみの言及（描画の変更を踏まえてケースを書いた、という注記） | （対象外） |
| `answer-trials-material.ts`/`answer-trials-render.ts` | カセットの記録済み文字列を**静的にパース**・**構造から再構成**するだけ（ADR 0301 決定1・2） | しない（DB・recall を一度も経由しない設計） |

**実際にプロンプトの形が変わり、`RecordedLLMProvider`（ADR 0051、`llmCassetteKey` は
`PromptSpec` 全体の SHA-256）の鍵が変わるのは、`answer-bench.ts` 経由（`answer` 系）と
`time-weighting-bench.ts` 経由（`answer-time-weighting`）の2系統だけである。**

### 3.1 落ちる再生の一覧（CI ジョブ・テスト単位）【現物、§4 の変更前の状態として特定】

| CI ジョブ | ステップ / テストファイル | 症状 |
|---|---|---|
| `example-chat` | `test:db`（`pnpm --filter @mnemora/example-chat run test:db`）内の `answer-cli.postgres.test.ts` | `answer` を `recorded` で再生する3本の `it` が `RecordedLLMProvider`「記録に無い」例外で失敗 |
| `example-chat` | 同上、`answer-retention-positive-control.postgres.test.ts` | `runAnswerCase` が新描画のプロンプトを組むため、変異前段階から「記録に無い」例外 |
| `example-chat` | 同上、`time-weighting-recorded-replay.postgres.test.ts` | 2本の `it`（全16ケース×2方針の再生、既知の取り引きの固定）が同じ例外 |
| `example-chat` | 同上、`cassette-coverage.test.ts` | `answer`/`answer-time-weighting` の対応検査が対象カセットの中身と整合しなくなる（このテスト自体は DB 不要・API 不要だが、対象が「使われなくなった形」のカセットのままだと検査の意味が失われる） |
| `example-chat` | 専用ステップ「`RecallQuery.timeWeighting`…を `answer-time-weighting` で再生し…」 | `pnpm --filter @mnemora/example-chat run answer-time-weighting` が `resolveRecordedRun` の中で例外 |
| `root-gate-db-stage` | `test:db` を `run-db-tests.mjs` 経由で examples/chat に対しても実行するステップ | 上と同じ理由で失敗（`example-chat` ジョブと同一原因の重複） |

**変わらず緑のまま**: `answer-bench.postgres.test.ts`（`deterministic` 強制、`recorded` を
経由しない）・`mnemora-path.postgres.test.ts`（カセットを使わない）・`compare` 関連一式
（`buildMnemoraPrompt` を呼ばない、§3 の表参照）・`retrieval` 関連一式（同）。

## 4. 配線: 既存カセットは書き換えず、新しいカセットファイルを足す

### 4.1 決定: `answer`/`answer-time-weighting` の再生対象を新形式カセットへ向け、旧形式は
`answer-trials-material.ts` 専用の基準として固定する

`examples/chat/src/cassette-io.ts` に以下を追加した:

- `ANSWER_ORDER_LEGEND_CASSETTE_PATH` → `examples/chat/cassettes/answer.order-legend.json`
  （新規、まだ存在しない）
- `ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH` →
  `examples/chat/cassettes/answer-time-weighting.order-legend.json`（新規、まだ存在しない）

`CASSETTE_PATH_BY_TARGET`（`record`/`verify`/CLI の `resolveRecordedRun` が引く唯一の
対応表）の `"answer"`/`"answer-time-weighting"` を、上記の新パスへ向けた。
**既存の `ANSWER_CASSETTE_PATH`（`answer.json`）/`ANSWER_TIME_WEIGHTING_CASSETTE_PATH`
（`answer-time-weighting.json`）は1バイトも変更していない**——`cassette-coverage.test.ts`
に、この2ファイルの sha256 を固定して書き換わっていないことを機械的に検査する歯を追加した
（§4.4）。

`examples/chat/src/answer-trials-material.ts`（ADR 0301 の対照の基準）は、
`cassette-io.ts` の対応表を経由せず**独自にハードコードしたパス**
（`fileURLToPath(new URL("../cassettes/answer.json", ...))`）で `answer.json` を直接読む
設計に元からなっている——`CASSETTE_PATH_BY_TARGET` を変更しても影響を受けない。**§2 の
n=15 対照（今後 Issue #705/ADR 0301 の器で追試するときも含めて）は、引き続き同じ
`answer.json`（sha256 `303d59...58acd7b`）を材料にする。**

### 4.2 再生側で更新した箇所

- `examples/chat/src/__tests__/answer-cli.postgres.test.ts`（docstring のカセットパス言及。
  CLI を子プロセスで起動する実装は `resolveRecordedRun` を経由するため、コード自体の変更は無い）
- `examples/chat/src/__tests__/answer-retention-positive-control.postgres.test.ts`
  （`ANSWER_CASSETTE_PATH` → `ANSWER_ORDER_LEGEND_CASSETTE_PATH`）
- `examples/chat/src/__tests__/time-weighting-recorded-replay.postgres.test.ts`
  （`ANSWER_TIME_WEIGHTING_CASSETTE_PATH` → `ANSWER_TIME_WEIGHTING_ORDER_LEGEND_CASSETTE_PATH`。
  併せて、記録し直した後は `EXPECTED_VERDICT` の値を新しい記録の実測から書き直すこと、
  旧記録の値を使い回さないことを docstring に明記した——§5 の理由）
- `examples/chat/src/__tests__/cassette-coverage.test.ts`（`answer`/`answer-time-weighting`
  の対応検査を新形式カセットへ向け、旧形式2ファイルの sha256 固定検査を追加）
- `examples/chat/src/scripts/record-answer-retention-mutation.ts`（旧形式専用の追記スクリプト
  である旨と、新形式では不要になる理由を docstring に追記。**削除はしていない**——旧形式の
  67件+2件はこのスクリプトが記録した歴史そのものであり、消すと来歴が読めなくなる）

### 4.3 【実測】新形式カセットが無いことによる赤——意図した状態

自分専用の Postgres（`initdb`、`AGENTS.md` の手順どおり自分専用ポート・自分専用ディレクトリ）
を立て、`DATABASE_URL` 在りで次を実行した:

```
pnpm --filter @mnemora/example-chat exec vitest run \
  src/__tests__/cassette-coverage.test.ts \
  src/__tests__/answer-retention-positive-control.postgres.test.ts \
  src/__tests__/time-weighting-recorded-replay.postgres.test.ts \
  src/__tests__/answer-cli.postgres.test.ts
```

`cassette-coverage.test.ts` は 26件中13件が「カセットが無い」で失敗（新形式2ファイルを
対象にする13本。旧形式の sha256 固定検査を含む13本は成功）。postgres 系3ファイル・
7件の `it` はすべて「カセットが無い」（`loadCassette`）または CLI がその例外で
非0 exit した結果の assertion 失敗——**いずれも `RecordedLLMProvider`「記録に無い」
以前の、より早い「ファイル自体が無い」段階で止まっている**。型検査
（`pnpm --filter @mnemora/example-chat run typecheck`）・lint（`eslint`）は通る。

**これは意図した状態である**——実 API を叩いて新形式カセットを記録するまで、
この赤は解消しない。次節に、記録に要るコマンドと見込みの呼び出し回数を示す。

### 4.4 記録のコマンドと見込みの呼び出し回数

**⛔ 本 ADR の書き手は実 API を一切叩いていない。** 以下は
`answer-case-set.dev.ts`/`answer-case-set.eval.ts`/`time-weighting-case-set.*.ts` と
`answer-bench.ts`/`time-weighting-bench.ts` の実装を読んで数えた**見込み**であり、
実測ではない。

```
DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:answer
DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:answer-time-weighting
```

の2本で足りる——`recordAnswer`（`cli.ts`）は毎回全ケースを対象にした全置換であり、
Issue #498 完了条件4の陽性対照（`recordRetentionMutationPositiveControl`）も同じ実行の
中で記録するため（§4.1 が触れた `record-answer-retention-mutation.ts` を新形式では
使わない理由）、追加の記録スクリプトは要らない。

**`record:answer`**（`ANSWER_CASE_SET_DEV` 6件 + `ANSWER_CASE_SET_EVAL` 8件、計14件
【現物、`grep -c question: answer-case-set.*.ts`】）:

| 呼び出し種別 | 見込み回数 | 内訳 |
|---|---|---|
| chat（`complete`/`completeStructured`、すべて `gpt-4o-mini`） | **108 + 2 = 110** | 抽出 52（14ケースの user 発話合計、1発話=1抽出呼び出し）+ 回答生成 28（14ケース×naive/mnemora） + judge 28（14ケース×naive/mnemora） + 陽性対照の変異分2（mnemora 回答生成1 + judge 1） |
| embedding | **14 以上**（上限は未確定） | 質問文の埋め込み14（1ケース1回）+ 抽出が生んだ Memory の埋め込み（0件以上、抽出結果に依存するため実行前には確定できない） |

**`record:answer-time-weighting`**（`TIME_WEIGHTING_CASE_SET_DEV` 6件 +
`_EVAL` 6件 + `_EVAL_UNDATED` 4件、計16件【現物】。既存の
`time-weighting-recorded-replay.postgres.test.ts` の docstring「全16ケース×2方針」と
一致）:

| 呼び出し種別 | 見込み回数 | 内訳 |
|---|---|---|
| chat（`complete`、`gpt-4o-mini`） | **32** | 16ケース×`legacy`/`eventAwareFreshness` の2方針（judge は呼ばない。`gradeAnswer` のみ） |
| embedding | **32 以上**（下限） | 質問文の埋め込み（`recall()` を方針ごとに呼ぶため最大32＝16×2、キャッシュされれば16まで減りうる）+ 各ケースが直接書く記憶の埋め込み（ケースごとに件数が違う。`cassette-coverage.test.ts` の「すべてのケースが直接書く記憶の content」検査が数える対象と同じ） |

合計の見込みは **chat 142回・embedding 少なくとも46回**（embedding の上限は抽出結果に
依存するため、実行前には確定できない）。`verify:answer`/`verify:answer-time-weighting`
（記録済みカセットと実 API の乖離を測る、ADR 0051）は任意——実行すればさらに同数程度の
呼び出しが追加で発生する。

### 4.5 記憶集合が変わりうることについて

**録り直すと、抽出（`observe()` → `completeStructured`）がやり直される。** 抽出プロンプト
自体は `buildMnemoraPrompt` の変更で変わっていない（抽出は `packages/core` 側の責務で、
本 Issue の変更対象外）ため、**同じ会話・同じモデルに対して同じ抽出結果が返る可能性は
高い**——しかし LLM の出力は決定的である保証が無く（`time-weighting-recorded-replay.
postgres.test.ts` の docstring が引く `bench-results/STAGE3B-1-NOTES.txt` の実測
「temperature=0でも別セッションでは LLM の応答自体が変わりうる」と同じ事情）、
**新形式カセットの記憶集合（抽出が生成する Memory の集合）が、旧形式カセット
（`answer.json`）の記憶集合と1件も違わない保証は無い。**

⟹ **`answer-trials-material.ts`（ADR 0301 の対照の基準）が読み続ける `answer.json` と、
新形式カセット（`answer.order-legend.json`、記録すればできる）の記憶集合は、別物になりうる。**
これは Issue #705/ADR 0301 の「同じ記憶集合で n 回試行する」という前提そのものには反しない
——**1つのカセットの中では記憶集合は固定**（同じカセットを毎回静的にパースするだけであり、
recall をやり直さない、ADR 0301 決定1）。ただし、**「新形式カセットで再測定した n=15」と
「本 ADR §2 の n=15（旧形式 `answer.json` を材料にした）」を直接比較するときは、
描画の違いだけでなく記憶集合の違いも交絡しうる**——比較するなら、この交絡を認めた上で
読むこと。**新形式カセットで §2 と同じ対照をやり直す（`answer-trials-material.ts` を
新形式ファイルにも向けられるよう拡張する）ことは本 ADR の範囲外とし、Issue #691 の
残作業として残す**（§6）。

### 4.5.1 種カセットで記憶集合を揃える下ごしらえ【現物・実測、本節の書き手】

> ⚠ 本節も、上と同じく自動化された担い手が書いた。⛔ オーナー本人の判定ではない。

**マネージャーが実 API で `record:answer` を実際に1度走らせ、上（§4.5）の懸念が
現実に起きたことを実測した**——録り直しで digest が変わり、Issue #498 完了条件4の
陽性対照（`applyRetentionMutation`、`answer-retention-mutation.ts`）が「変異対象の
部分文字列…が見つからない」で落ち、新形式カセットが1件も書き出されなかった
（マネージャーからの逐語の引き継ぎ。**本節の書き手は実 API を一切叩いていない**
——上（§4.4冒頭）と同じ絶対の禁則。抽出は非決定的なため、録り直すたびに記憶集合が
変わりうる、という§4.5の分析どおりの結果が実際に出た形になる）。

**この書き手は、記憶集合を旧カセット（`answer.json`/`answer-time-weighting.json`）へ
揃えやすくするための「種カセット」を `record:answer`/`record:answer-time-weighting`
に実装した**（環境変数 `MNEMORA_RECORD_SEED_CASSETTE=<path>`、`examples/chat/src/
providers.ts`・`cli.ts`）。LLM・埋め込みのどちらも、種カセットに同じ鍵
（`llmCassetteKey`/`embeddingCassetteKey`、`@mnemora/testkit`——**既存の鍵の作り方を
再利用しており、新しい鍵の作り方は増やしていない**）のエントリがあれば実 API を呼ばずに
その値を返し、無ければ実 API を呼ぶ。**どちらの場合も新しいカセットへ記録し、新しい
カセットは自己完結する**（種への参照は残らない、値そのものをコピーして持つだけ）——
`SeededLLMProvider`/`SeededEmbeddingProvider`（`@mnemora/testkit`、新規）を real と
`RecordingLLMProvider`/`RecordingEmbeddingProvider`（ADR 0051、既存）の間に挟む
組み立て順（real → Seeded → Recording）を取る。順を誤る（例: Recording が real を
直接包み、Seeded がその外側に来る）と、種から返した値が一度も recorder を通らず、
新しいカセットに記録されない——この壊れ方は変異試験で実際に再現して確かめた
【実測】。種のモデル名・埋め込み空間が今の設定（`OPENAI_LLM_MODEL`/
`OPENAI_EMBEDDING_MODEL`/`OPENAI_EMBEDDING_DIMENSIONS`）と食い違えば構築時に例外に
する——黙って混ぜない。

**歯（DB 不要）**: `packages/testkit/src/__tests__/seeded-provider.test.ts`
（`SeededLLMProvider`/`SeededEmbeddingProvider` 自体——種にある入力では delegate
を呼ばない・無ければ呼ぶ・モデル/空間の不一致は例外・種由来実 API 由来どちらも
recorder に記録される、の4点）・`examples/chat/src/__tests__/providers.test.ts`
（`createProviders` の配線——`seedCassette` 省略時は挙動を変えない・
`readSeedUsage` の有無・モデル/空間不一致の例外・`openai` 以外のモードでは
種の不一致を検査しない）。**変異試験**（`cp` で退避・復元、コミットしていない）:
「種を見ずに常に real を呼ぶ」実装・「種から返した分を recorder に入れない
（組み立て順を誤る）」実装のそれぞれで、狙った歯が赤くなることを確認した
【実測】。

**録音のコマンド（旧カセットを種として渡す）**:

```
MNEMORA_RECORD_SEED_CASSETTE=examples/chat/cassettes/answer.json \
  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:answer

MNEMORA_RECORD_SEED_CASSETTE=examples/chat/cassettes/answer-time-weighting.json \
  DATABASE_URL=... OPENAI_API_KEY=... pnpm --filter @mnemora/example-chat run record:answer-time-weighting
```

**理由は2つ**: (1) 記憶集合を§2の n=15 対照（`answer.json` を材料にした）と揃えること
——抽出（`observe()` → `completeStructured`）の入力プロンプトは `buildMnemoraPrompt` の
変更と無関係（§4.5冒頭）なので、種にヒットする見込みが高い。抽出が種から返れば、
その戻り値（digest 文字列）は記録済みの値そのものであり、そこから生まれる Memory の
埋め込み入力も旧カセットの記録と一致する——**種が抽出に当たれば、その下流の埋め込みも
連鎖して種に当たる見込みが高い。** (2) 陽性対照（`applyRetentionMutation`）が変異対象に
する部分文字列（回答生成が返す digest の一部）を安定させること——ただしこれは
間接的な効果である（抽出＝記憶集合が同じになることを経由する）。

**種にヒットしない見込みのもの**（コードを読んで数えた見込みであり、実測ではない
——§4.4 と同じ区別）: `record:answer` の回答生成・judge・陽性対照の回答生成
（§4.4 の内訳で言う 110 回のうち抽出 52 回を除いた 58 回）は、`buildMnemoraPrompt`
が `order-legend` 描画に変わったことで、プロンプトのハッシュ鍵（recall した memory の
並び・凡例行を含む）が旧カセットと一致しない——**実 API を呼ぶ見込み。**
`record:answer-time-weighting` は `observe()`（抽出）を一度も通らない設計
（記憶を直接書く、`time-weighting-bench.ts`）——回答生成（`legacy`/
`eventAwareFreshness` の2方針、§4.4 の 32 回）は同じ理由（`order-legend` 描画）で
**実 API を呼ぶ見込み**である一方、**質問文・記憶本文の埋め込みはケース定義
（`time-weighting-case-set.*.ts`）から決まる固定文字列で `buildMnemoraPrompt` と
無関係なため、種にヒットする見込みが高い**（§4.4 の 32 回以上）。

⟹ **記憶集合が実際に旧カセットと揃ったかどうか・上の「見込み」が実測とどれだけ
一致したかは、この書き手はまだ確かめていない（実 API を一切叩いていないため）。**
マネージャーが `MNEMORA_RECORD_SEED_CASSETTE` を渡して実際に記録を実行した後、
`formatSeedUsageReport` の画面出力（種から再生した件数／実 API を呼んだ件数、
LLM・埋め込み別）と、記憶集合が§2の対照（`answer.json`）と一致したかどうかを、
ここに追記すること。

## 5. 記録した時点の gradeAnswer/検証値は、録り直すたびに書き直す

`time-weighting-recorded-replay.postgres.test.ts` の `EXPECTED_VERDICT`（16ケース×2方針の
記録済み正誤）・`answer-cli.postgres.test.ts` の層2（内容保持）検査のように、**カセットの
記録内容そのものを固定値として assert している歯がある。** §4.5 のとおりプロンプトの
文言が変わればモデルの実際の回答文字列も変わりうるため、**これらの固定値は、新形式カセット
を記録した後、そのカセットの実測ログからそのまま書き写すこと。** 旧形式カセットで記録された
値を新形式にそのまま使い回さない——**特に `schedule-change-meeting-day` に類する
「訂正の後続を含むケース」は、§2 の対照そのものが正答率を動かすことを示しているため、
結果が変わる可能性が高い。**

## 6. 引き受けた負債

1. **本 ADR の§2 は【受】であり、この書き手自身の実測ではない。** 実 API を叩く手段が
   無いため、独立に再現することもできていない。
2. **「凡例だけを足して並べ替えはしない」描画（`legend-only`）を測っていない**（§2.4）——
   `order-sorted`（5/15）と `order-legend`（13/15）の差が、並べ替えと凡例のどちらの寄与か、
   厳密には切り分けられていない。
3. **`digest-order-legend`（タグを落とす案）が eval の誤帰属検知ケースを壊すかどうかは
   測っていない**（§2.4）——本対照は dev 6件だけで行っており（ADR 0301 と同じ絶対の線）、
   eval を材料にした対照はこの ADR の範囲外のまま。
4. **新形式カセットをまだ記録していない**（§4.3/§4.4）——`answer`/`answer-time-weighting`
   の CI 再生（`example-chat`/`root-gate-db-stage` の該当ステップ）は、記録するまで赤の
   ままである。記録・マージのタイミングはオーナーの判断領域（ADR 0295 §4 と同じ先例）。
5. **新形式カセットでの記憶集合が旧形式と一致する保証が無い**（§4.5)——一致するかどうかの
   実測も、記録後にしかできない。**§4.5.1 で、記憶集合を揃えやすくする下ごしらえ（種
   カセット、`MNEMORA_RECORD_SEED_CASSETTE`）を実装したが、これも実 API で記録して
   初めて「実際に揃ったか」が分かる**——下ごしらえ自体はこの書き手が歯・変異試験で
   確かめたが、記憶集合が揃うことそのものはまだ実測していない。
6. **embedding の呼び出し回数は上限が確定できない**（§4.4）——抽出が生成する Memory の
   件数に依存し、記録を実行するまで正確な数は分からない。
7. **`answer-retention-positive-control.postgres.test.ts` の「変異後」の期待 outcome
   （現状 `"fail"`/`"fail"` に固定）も、新形式での記録後に書き直しが要る可能性がある**
   ——docstring には注記したが、値そのものはまだ直していない（旧形式の値のまま）。
8. **種カセット（§4.5.1）は、まだ実 API に対して一度も走らせていない。** 歯（DB 不要）と
   変異試験は通ったが、それは「種にある入力では real を呼ばない／種に無い入力では呼ぶ／
   どちらも記録される」という**構造**の検査であり、実際の `answer.json`/
   `answer-time-weighting.json` を種にして `record:answer`/`record:answer-time-weighting`
   を実 API で走らせたときに、§4.5.1 の「見込み」（抽出・埋め込みは当たる／回答生成・judge・
   陽性対照は当たらない）が実測とどれだけ一致するかは確かめていない。

## 関連

- Issue #691（本 ADR の対象、続き）
- [ADR 0295](./0295-answer-prompt-provenance-rendering.md)・追記・追記2（由来等の描画、
  `schedule-change-meeting-day` 退行の発見。本 ADR 追記3で本 ADR への1段落のポインタを足す）
- [ADR 0298](./0298-recalled-memory-recorded-occurred-at.md)（`recordedAt`/`occurredAt`、
  欠落値を推測しない規律の先例）
- [ADR 0301](./0301-answer-trials-same-memory-set.md)（Issue #705、同じ記憶集合で n 回
  試行する器。本 ADR §2 の対照はこの器を使う）
- [ADR 0051](./0051-recorded-provider-cassette.md)（`recorded` カセットの設計、
  `llmCassetteKey` の鍵の作り方。§3/§4 の「記録に無い」で落ちる理由）
- [ADR 0052](./0052-compare-cassette-and-provenance-survival.md)（カセットをサブコマンド
  ごとに分ける設計。§4 の新形式ファイルの分け方はこれを踏襲する）
- `AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」（§4.4 の呼び出し回数を、実行前の
  見込みと明示して書いた理由）
