# ADR 0317: filler 一意化を、較正標本拡張後の main へ移植し直す — カセットは PR #701 から流用、字数余白の歯の判定は CI へ委ねる（Issue #340）

- **状態**: 記録 (2026-09-25)。⚠ **この ADR は FLOOR・`ACCURACY_TOLERANCE`・較正標本の設計・
  hold-in/hold-out の分け方のいずれも決めていない・動かしていない。** 移植したこと・手元で
  測った予告値を記録するだけであり、CI の実測に対する最終判定はオーナー領分として残す。
- **日付**: 2026-09-25

**⚠ 各主張の出所を分ける**（ADR 0166 / ADR 0201 の体裁を踏む）。

- **【実測】** — この ADR の書き手が自分の手で走らせて確かめた。
- **【現物】** — この repo のコード・文書を読んで確かめた。
- **【受】** — 報告として受け取り、再導出していない。

---

## 結論（先に）

**閉じた [PR #701](https://github.com/takecchi/mnemora/pull/701)（枝 `bench/340-unique-filler`、
head `2c8ea62`）の filler 一意化そのものを、較正標本を15点に増やした後の main
（`8cf82b1`、ADR 0314）の上に移植した。** カセット（`examples/chat/cassettes/compare.json`）は
PR #701 が実 API で録り直したものをそのまま流用し、**この作業では実 API を1回も叩いていない**
（すべて `MNEMORA_PROVIDER_SOURCE=recorded` で走らせ、カセットに無い入力の例外が1件も
出なかったことを確認した）。

移植しなかったもの: PR #701 の `compare-baseline.json`（古い CI 値）・
`recall-footprint-baseline.test.ts` と `packages/core/src/recall-footprint.ts` の変更
（PR #701 時点の古い較正の話）・PR #701 の ADR（仮0298/0299）そのもの。

手元（clean な Postgres + `MNEMORA_PROVIDER_SOURCE=recorded`）で測った**予告値**:

- 較正標本8点（`limit=20` の帯が空の標本、`fillerPairs∈{12,13,16,17,19,21,25,29}`）は、
  新しい filler でも全8点で `bandEntryCount=0` のままだった（設計は崩れていない）。
- 字数で見た誤差の余白（ADR 0201）を新しい filler の実測で計算し直すと、
  **最小余白は 82ターン行・下側で 6.159字、FLOOR(半digest)は 7.215字 — 赤（−1.056字）**。
  PR #701 が閉じた理由（ADR 0201 追記「固定の半digestは外挿の距離を見ていない」）と同じ形の
  赤が、標本を15点に増やした後でも残る。
- ⭐ 門（`compare-summary.mjs` の `evaluateCompare`）を、今の main の
  `compare-baseline.json`（未変更）に対して予行したところ、**turnCount=2/6/8 の3行で
  `mnemoraShareOfNaiveChars` が悪化し、exit 1（赤）になった**。`factStatementSurvived` の
  退行（true→false）は無い。

**これらはすべて「予告」であり、判定ではない。** 判定は CI の実測（`compare-baseline.json` は
まだ更新していない）で行う——このブランチを push した後の CI run を見ること。

---

## 背景

[Issue #340](https://github.com/takecchi/mnemora/issues/340) は、`examples/chat/compare-baseline.json`
の `turnCount=322` 行の非決定性の根本原因が `scenario.ts` の filler user 発話の重複
（12文の固定配列を `i % 12` で巡回するだけ）だと特定した。本物の embedding は同一文字列に
対して bit-for-bit 一致するベクトルを返すため、この重複が連想枠（`maxCount`）の tie-break に
紛れ込み、digest 長が run ごとに変わっていた（ADR 0170 §3）。

[PR #701](https://github.com/takecchi/mnemora/pull/701) が filler を話題×述語の直積で
一意化し、カセットを実 API で録り直して着手したが、[閉じられた](https://github.com/takecchi/mnemora/issues/701#issuecomment-5825370968)。
閉じた理由（オーナーの判定、Issue #340 経由）:

> この PR の基準値では、ADR 0201 の余白の歯が赤になります。（…）**正当な形で緑にする方法が
> ありません。**（…）filler の一意化そのものは捨てません。先に較正標本を増やし（Issue #340
> の案3。帯が空のまま件数が 10〜20件の標本と、生の `index` の記録）、その上で**同じ歯
> （FLOOR も許容誤差も変えない）**で測り直して、再挑戦します。

較正標本の拡張は [ADR 0314](./0314-recall-footprint-calibration-samples-need-ci-sourcing.md)
§4 が済ませ、main（`8cf82b1`）に入っている（#728）。**本 ADR は、その「再挑戦」——filler
一意化そのものを、拡張後の main の上に移植し、同じ歯で測り直す——を行った記録である。**

`ACCURACY_TOLERANCE`・`FLOOR_CHARS` の式（`charsPerDigest/2`）・較正標本の設計
（`CALIBRATION_SAMPLE_DESIGN`: limit=20、fillerPairs={12,13,16,17,19,21,25,29}）・
hold-in/hold-out の分け方（`bandEntryCount === 0`）は、委譲元から「触らない」と指定されている
——本 ADR もこれに従う。

---

## 移植した内容

merge-base は `746bf3b`（`origin/bench/340-unique-filler` と `origin/main` の共通祖先）。
main 側は `746bf3b` 以降 `examples/chat/cassettes/compare.json` を1バイトも変えていない
（`git diff --name-only 746bf3b origin/main -- examples/chat/cassettes/compare.json` が
空【実測】）。

| ファイル | 移植の形 |
| --- | --- |
| `examples/chat/src/scenario.ts` | PR #701 head (`2c8ea62`) との diff を merge-base から直接 `git apply` — クリーンに適用できた |
| `examples/chat/src/probe-set.ts` | 同上 |
| `examples/chat/src/__tests__/scenario.test.ts` | 同上 |
| `examples/chat/src/__tests__/mnemora-path.postgres.test.ts` | 同上 |
| `examples/chat/cassettes/compare.json` | 同上（**PR #701 が実 API で録り直したものをそのまま流用。この ADR の作業では録り直していない**） |
| `examples/chat/src/__tests__/cassette-coverage.test.ts` | **手で統合**。main 側がこのファイルに別の変更（ADR 0309、answer 系カセットの新旧形式対応）を加えていたため、PR #701 の diff は素直に当たらない。「compare のカセット」節（ADR 0052/0299 のコメント更新2箇所）だけを手で移し、main 側の answer 系の変更はそのまま残した |

**移植しなかったもの**（委譲元の指示どおり）:

- `examples/chat/compare-baseline.json`（PR #701 が当時の CI artifact から実測更新したもの。**古い較正・古い基準値**であり、今の main の基準値とは前提が異なる）
- `examples/chat/src/__tests__/recall-footprint-baseline.test.ts` の PR #701 側の変更（同じ理由）
- `packages/core/src/recall-footprint.ts` の PR #701 側の変更（`BUILTIN_RECALL_FOOTPRINT_PROFILE` の再較正——今の main は ADR 0306/0310/0314 で別の値に既に再較正済み）
- PR #701 の ADR（仮 0298/0299）— 必要な背景は上の「背景」節に引用の形で取り込んだだけで、ADR 本文そのものは持ち込んでいない

`git diff --name-only 746bf3b origin/main -- <上表のファイル>` で確認すると、
`compare-baseline.json` / `cassette-coverage.test.ts` / `recall-footprint-baseline.test.ts` /
`packages/core/src/recall-footprint.ts` の4つは main 側で変わっており、
`scenario.ts` / `probe-set.ts` / `scenario.test.ts` / `mnemora-path.postgres.test.ts` /
`cassettes/compare.json` の5つは変わっていない【実測】——後者5つを単純な `git apply` で
移植し、前者のうち `cassette-coverage.test.ts` だけを手で統合し、残り3つ（基準値・古い較正の
テスト・`recall-footprint.ts`）は意図的に触らなかった。

---

## カセットの被覆（実 API を叩いていないことの確認）

`MNEMORA_PROVIDER_SOURCE=recorded` を明示して、次をすべて実行した:

- `pnpm run compare`（独立な clean DB で2回）
- `pnpm run recall-footprint-calibration-samples`（1回）
- `vitest run src/__tests__/cassette-coverage.test.ts`（26 tests 全緑）

いずれも「記録に無い入力」の例外は1件も出なかった。`llmCassetteKey`/`embeddingCassetteKey`
はプロンプト全体（または発話文字列）の SHA-256 であり、内容が1文字でも違えば別の鍵になる
（`packages/testkit/src/__fixtures__/cassette.ts`）——例外が出ずに走り切ったことは、
新しい `scenario.ts` が生成する321種の filler 発話（320種のユニークな filler + 事実表明1種）が
すべてカセットに記録済みであることの、機械的な確認になっている。

`[cassette]` ログはすべての実行で `記録日時=2026-09-24T20:38:29.571Z LLM=gpt-4o-mini(321件)
埋め込み=text-embedding-3-small/256次元(144件)` を報告した——PR #701 本文の「2回目の録音」
（列挙順序を直した後の録音、321回/144回）と件数が一致する。

⚠ **この作業自体が新しく実 API を叩いたわけではない。** PR #701 が録音した時点（2回に分けて
実施、chat.completions 642回・embeddings 281回、費用合計 約$0.0311、予算上限 $0.20 の範囲内
——詳細は PR #701 本文）の記録を、そのまま再生しているだけである。

---

## 較正標本8点: 新しい filler でも帯は空のまま

`recall-footprint-calibration-samples` サブコマンドを clean DB・`MNEMORA_PROVIDER_SOURCE=recorded`
で実行した結果【実測、2026-09-25】:

| fillerPairs | limit | turnCount | totalInScope | bandEntryCount | mnemoraChars |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 20 | 26 | 6 | **0** | 262 |
| 13 | 20 | 28 | 7 | **0** | 279 |
| 16 | 20 | 34 | 8 | **0** | 297 |
| 17 | 20 | 36 | 8 | **0** | 297 |
| 19 | 20 | 40 | 8 | **0** | 297 |
| 21 | 20 | 44 | 9 | **0** | 312 |
| 25 | 20 | 52 | 12 | **0** | 356 |
| 29 | 20 | 60 | 13 | **0** | 369 |

8点全部で `bandEntryCount === 0`。**設計（どの `fillerPairs`/`limit` を使うか）は動かしていない**
——`totalInScope`/`mnemoraChars` の値は filler が変わったことで main の基準値
（`recall-footprint-calibration-samples-baseline.json`）から変わっているが、帯が空という
性質そのものは壊れていない。`recall-footprint-calibration-samples-summary.mjs`
（⛔ 門ではない、ADR 0314 §2）は8点とも相違を報告したが exit 0 だった。

---

## 手元での参考計算（予告 — 判定は CI で行う）

以下はすべて **clean な Postgres（自分専用インスタンス、実行前に毎回 `dropdb`/`createdb`
で作り直した）**・`MNEMORA_PROVIDER_SOURCE=recorded` での実測。独立な2回の clean-DB
実行で `measuredAt`/`commit` を除き `rows` がバイト単位で一致することを確認済み【実測】。

### ⚠ 踏んだ穴: DB を使い回すと古い filler の残骸で判定を誤る

最初の実行では `/tmp/mgr-14dd442f/pg` に既存の Postgres データディレクトリ（別プロセスが
先に作っていたもの）が既にあり、`example-compare-*`/`recall-footprint-calib-*`
というテナントに506行の Memory が既に入っていた。`compare.ts` はテナントIDを
`example-compare-${fillerPairs}` のような固定IDで組み立てるため、この残骸が残ったまま
`compare` を再実行すると、**naive 側の字数（会話ログの生の文字数、DB を経由しない）は
新しい filler を反映するのに、mnemora 側の字数は残骸の記憶を拾って旧 filler 相当の値
（`compare-baseline.json` の現行値と12行すべてでバイト単位一致）に張り付いたまま動かない。**
これに気づかず読むと「filler を一意化しても mnemora 側は何も変わらなかった」という**誤った
結論**を報告するところだった。`dropdb`/`createdb` でスキーマを作り直してから再実行すると、
mnemora 側の値も PR #701 本文の「新」列（207/207/226/226/226/242/262/312/499/1806/4481/4435）
と完全に一致した。**手元で `compare`/`recall-footprint-calibration-samples` を測るときは、
DB を作り直してから走らせること。**

### 較正係数・hold-in の残差

| | main（未変更、`8cf82b1`） | このブランチ（新filler、PR #701 のカセット流用） |
| --- | ---: | ---: |
| hold-in の行数（`compare` 由来 + 較正標本8点） | 15（7+8） | **16（8+8）**——turnCount=42 が hold-out→hold-in へ移動（PR #701 と同じ現象） |
| `charsPerDigest` | 16.175 | **14.430** |
| `fixedIndexChars` | 168.503 | **180.418** |
| hold-in 残差の RSE（自由度 n−2） | 2.180字 | **2.776字** |
| hold-in 最大絶対残差 | 4.922字（較正標本 fillerPairs=12 相当、turnCount=26） | 4.999字（turnCount=22・26、同じ `totalInScope=6` を共有） |

### hold-out 行の誤差・字数の余白

main（hold-out 5行）:

| turnCount | 誤差 | 上側余白 | 下側余白 |
| ---: | ---: | ---: | ---: |
| 42 | 0.850% | 20.029字 | **9.387字** |
| 82 | 0.083% | 33.337字 | 33.899字 |
| 162 | 0.035% | 79.952字 | 73.948字 |
| 322 | 1.122% | 64.286字 | 160.655字 |
| 642 | 0.514% | 138.362字 | 86.728字 |

このブランチ（hold-out 4行——42行は上の表のとおり hold-in へ移動）:

| turnCount | 誤差 | 上側余白 | 下側余白 |
| ---: | ---: | ---: | ---: |
| 82 | 1.235% | 19.114字 | **6.159字** |
| 162 | 0.037% | 45.626字 | 44.697字 |
| 322 | 1.372% | 51.853字 | 169.262字 |
| 642 | 0.281% | 100.930字 | 120.335字 |

### FLOOR・最小余白・12行全体の最大誤差

| | main | このブランチ |
| --- | ---: | ---: |
| 最小余白 | 9.387字（turn42・下側） | **6.159字（turn82・下側）** |
| FLOOR（`charsPerDigest/2`） | 8.088字 | 7.215字 |
| 余白 − FLOOR | **+1.299字（緑）** | **−1.056字（赤）** |
| 12行全体の最大誤差 | 2.023%（turn2） | 1.908%（turn22） |

**`ACCURACY_TOLERANCE`（2.5%）は12行のどの行でも超えていない**——赤くなるのは字数の余白の歯
（ADR 0201）だけである。

### 予測区間の半幅（外挿の距離、ADR 0201 追記「固定の半digestは外挿の距離を見ていない」と同じ式）

| | main | このブランチ |
| --- | ---: | ---: |
| 1×RSE / 2×RSE / 3×RSE | 2.180 / 4.361 / 6.541 | 2.776 / 5.552 / 8.328 |
| 半幅（外挿なし、x0=x̄） | 4.864字 | 6.180字 |
| 半幅（hold-out の`totalInScope`平均まで外挿） | 15.661字（x̄=74.4） | 28.948字（x̄=69） |
| 半幅（hold-out の`totalInScope`最大まで外挿） | 41.233字（最大189） | 64.289字（最大148） |

外挿の距離を入れた予測区間で見ると、main の最小余白（9.387字）もこのブランチの最小余白
（6.159字）も、外挿分を含めた不確かさよりずっと小さい——ADR 0201 追記が PR #701 について
書いた「固定の半digestは外挿の距離を見ていない」という限界は、較正標本を15→16点に増やした
今回も変わらず残っている。

---

## ⭐ 門の予告（`compare-summary.mjs` の `evaluateCompare`）

**今の main の `compare-baseline.json`（未変更）に対して、このブランチの実測を予行した。**
判定に使うのは `mnemoraShareOfNaiveChars` の悪化と `factStatementSurvived` の退行
（true→false）の2つだけ（ADR 0133）。

```
node scripts/compare-summary.mjs --measured <このブランチの compare 出力> \
  --baseline examples/chat/compare-baseline.json
```

結果: **exit 1（赤）。** 3行で `mnemoraShareOfNaiveChars` が悪化:

| turnCount | 基準値 | 実測 |
| ---: | ---: | ---: |
| 2 | 4.183673469387755 | 4.224489795918367 |
| 6 | 1.44 | 1.486842105263158 |
| 8 | 1.0964467005076142 | 1.135678391959799 |

`factStatementSurvived` の退行（true→false）は無い——12行すべてで✅のまま。

**これは PR #701 のときと同じ形の「意図した変更で門が赤くなる」ケースである。** filler の
文面が変われば、短い会話（turnCount=2/6/8）で mnemora 側が拾う digest の構成が変わり、
naive に対する比率がわずかに悪化する行が出る——これは filler 一意化そのものの副作用であり、
実装のバグではない。**`compare-baseline.json` はまだ更新していない**（委譲元の指示、
基準値の更新はオーナー/委譲元が CI artifact の2回一致を確認してから行う、ADR 0121/0133）。
⟹ このブランチを push した後、CI の `example-chat` ジョブの⭐門ステップは赤くなる見込みである
——これは実測の予告であり、確定ではない（CI 環境・カセット再生の一致は CI run 自体で確認する
必要がある）。

---

## 関係するテスト・typecheck・lint

すべて `DATABASE_URL` を clean な自分専用 Postgres（`/tmp/mgr-14dd442f/pg`、port 55432）に向け、
`MNEMORA_PROVIDER_SOURCE=recorded` で実行した。

| 対象 | 結果 |
| --- | --- |
| `vitest run src/__tests__/scenario.test.ts` | 8 tests 緑 |
| `vitest run src/__tests__/cassette-coverage.test.ts` | 26 tests 緑（カセット被覆の機械検査） |
| `vitest run src/__tests__/mnemora-path.postgres.test.ts` | 5 tests 緑（DB 要） |
| `vitest run src/__tests__/recall-footprint-baseline.test.ts` | 40 tests 緑 |
| `pnpm --filter @mnemora/example-chat run typecheck` | 緑 |
| `npx eslint <変更した5ファイル>` | 緑（エラー無し） |
| `npx prettier --check <変更した5ファイル + compare.json>` | 緑 |

**`recall-footprint-baseline.test.ts` が緑であることは、このブランチの filler 変更とは
無関係である**——このテストは `examples/chat/compare-baseline.json` と
`recall-footprint-calibration-samples-baseline.json`（どちらも本 ADR では変更していない、
main の値のまま）だけを読んで検算する歯であり、`scenario.ts` を呼ばない。⟹ 緑であることは
「字数の余白が実際に緑である」ことの確認ではない——上の「⭐ 門の予告」節と「手元での参考計算」
節が示す**予告の赤**が、このテストには反映されていない。この不一致は委譲元の指示どおり
織り込み済みである。

---

## これが覆るとしたら

1. **CI の実測が、この ADR の予告値と一致しなかったとき。** ローカルの clean Postgres と
   CI の service container（`pgvector/pgvector:pg17`）は別環境であり、非決定性
   （ADR 0170 が過去に見つけたような `ORDER BY` 起因のもの）が無いことは、CI run 自体でしか
   確認できない。
2. **オーナーが FLOOR・`ACCURACY_TOLERANCE`・較正標本の設計のいずれかを変える判断をしたとき。**
   本 ADR はこれらを一切動かしていない——動かす判断はこの ADR の範囲外である。
3. **`compare-baseline.json` を実際に更新する判断がされたとき。** その際は ADR 0121/0133 の
   手順（CI artifact を同一 commit で2回以上実行し、バイト単位で一致することを確認してから
   コミットする）を踏む必要があり、本 ADR の手元の値をそのまま基準値へ書き写すことはできない。

---

## 確かめていないこと

- **CI 環境（`pgvector/pgvector:pg17` の service container）での再現。** 上の数値はすべて
  ローカルの自分専用 Postgres 17 + pgvector での実測であり、CI run では未確認。
- **`mnemoraShareOfNaiveChars` が悪化した3行（turnCount=2/6/8）の悪化の原因の切り分け。**
  filler の具体的などの語彙・述語が悪化を引き起こしているかは調べていない。
- **字数の余白の赤（−1.056字）を、FLOOR やhold-in/hold-out の分け方を変えずに解消できるか。**
  この ADR はその設計変更を提案していない——委譲元の指示で触らない対象である。

## 人から受け取った前提（出所付き）

- Issue #340・PR #701 の本文・閉じるコメント（issuecomment-5825370968）——GitHub から
  直接読んだ【現物】。
- ADR 0201「固定の半digestは外挿の距離を見ていない」追記（PR #701 に基づく実測・判断）——
  ADR 本文から直接読んだ【現物】。
- ADR 0314（較正標本拡張、main に入っている前提）——ADR 本文・`main` の現物から確認した
  【現物】。
- 委譲元からの作業指示（移植する/しない対象の切り分け、merge-base=746bf3b、
  `cassette-coverage.test.ts` は main 側で変わっているため手で合わせること、テストは
  名指しの対象のみ、実 API を叩かないこと、基準値を書き換えないこと）——委譲文として
  受け取った。カセット被覆の確認方法・参考計算の具体的な式・DB を使い回すと生じる問題の
  発見はこの作業が自分の実測に基づき行った。
