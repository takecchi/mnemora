# ADR 0693: `provenance` の jsonb に `kind` が無い行を CHECK で拒む（ADR 0182 の約束の端を閉じる）

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-07

**これはクローン（miku）の判断で、オーナーの判断ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。出所は Issue [#1909](https://github.com/takecchi/mnemora/issues/1909)。Issue は推奨を置かず、「そのままにして ADR 0182 に追記する」「`kind` を欠く jsonb を拒む」の2案を並べた。後者を採る。

**オーナーの言葉（原文）**: 2026-09-28、ask_human 6911db12 の問6への回答「v1.X.0とかで破壊的変更しちゃっていいよ僕しか使ってないし」。これは破壊的変更一般についての許可である。**#1909 を 🔴（破壊的変更）として数えて出す判断は、クローン（miku）のもので、オーナーが個別に決めたものではない。**
出所の区別: 【現物】は読んだコード、【実測】は手元で走らせた結果、【判断】は担い手の判定。

## 文脈【現物】

[ADR 0182](./0182-provenance-kind-matches-provenance-check.md) は「`provenance_kind`（列）と `provenance->>'kind'`（jsonb）の一致を CHECK で強制する」と約束した。実装は `0016`・`0017` の `CHECK (provenance_kind = provenance->>'kind')` である。

`provenance_kind` は `NOT NULL` だが、jsonb に `kind` が無いと右辺が NULL になり、比較が NULL になる。CHECK は NULL を通す。【実測】Issue #1909 が一時表で測り、この PR の歯が実表で確かめたとおり、次の形は元の制約を通っていた。

| `provenance_kind` | `provenance` | 元の制約 |
| --- | --- | --- |
| `imported` | `{}` | 通る |
| `imported` | `{"kind": null}` | 通る |
| `imported` | `"x"`（オブジェクトでない） | 通る |
| `imported` | `{"kind": "consolidated"}` | 拒む |

配列・JSON の `null` も `->>` が NULL を返すので同じである。つまり「一致」は、jsonb 側に `kind` があるときだけ強制されていた。ADR 0182 はこの端を書いていない。

## 決定【判断】

1. **`kind` を欠く jsonb を拒む。** ADR 0182 の約束の文面（一致を強制する）に素直に沿う読みである。今日の書き込み経路（`memory-store.ts` の3か所）は同じ `input.provenance.kind` から両方を書くので、正規の書き手は壊れない見込み。壊れうるのは、生 SQL など `kind` を欠く jsonb を書く書き手と、すでにそういう行がある DB である。
2. **新しい制約 `memories_provenance_kind_present` を足す。** 式は `CHECK (provenance->>'kind' IS NOT NULL)`。`provenance ? 'kind'` は採らない: `{"kind": null}` は「キーが在る」ので通り、jsonb の文字列 `"kind"` も `?` が真になる（【実測】`'"kind"'::jsonb ? 'kind'` と `'{"kind":null}'::jsonb ? 'kind'` はどちらも `t`）。元の制約が NULL で通す形は「`->>` が NULL になる形」そのものなので、同じ式を `IS NOT NULL` で見るのが、取りこぼしの無い言い方である。
3. **既存の制約は作り直さず、足す。** `IS NOT DISTINCT FROM` に変える案を採らなかった理由: (a) 出荷済みの `0016` が作った制約の定義を、後の migration が消す。(b) DROP から作り直しの間、一致が守られない窓ができる。(c) 同じ名前のまま意味が変わり、エラーの制約名から「一致していない」のか「`kind` が無い」のかが辿れなくなる。足すなら元の制約は無傷で、エラーの制約名が原因を言う。2つの合成は `provenance_kind IS NOT DISTINCT FROM provenance->>'kind'` と同値（`provenance_kind` は `NOT NULL`）。
4. **`NOT VALID`（`0033`）と `VALIDATE`（`0034`）の2ファイルに分ける。** `0016`・`0017` と同じ理由: (a) 同じトランザクションに置くと、`ADD CONSTRAINT` の `ACCESS EXCLUSIVE` が走査の間ずっと続き、読み書きが止まる。(b) 既存行に `kind` を欠く行があって `VALIDATE` が失敗したとき、同居していると `ADD CONSTRAINT` ごと巻き戻り、新しい書き込みを守る効果が消える。分けておけば、`0034` が失敗しても `0033` は commit 済みのまま残る。【実測】この PR の歯がその形（既存行に `{}` がある DB で、`0033` は台帳に残り、`0034` だけが失敗し、新しい `{}` は拒まれ、行を直して流し直すと `0034` だけが走る）を縛っている。
5. **既存行は migration で直さない。** `0034` が失敗したときの手順は `0034` のコメントに書いた（`provenance->>'kind' IS NULL` の行を探し、作った書き手を先に特定する）。データの書き換えはオーナーの領分で、`provenance_kind` と jsonb のどちらが正しいかは migration には決められない。
6. **破壊的変更（🔴）として数える。** 以前は通っていた書き込み（生 SQL など）が実行時の例外になり、既存行があれば `0034` が失敗する。repo の定義（利用者のコードが実行時に壊れる）に当たる。CHANGELOG `[1.4.0]` の `### Breaking` と docs/migration-v1.md の「🔴 破壊的変更（v1.3.0 → 次の版）」の **72** に載せた。`0016`・`0017` を非破壊と数えた前例との違いは、あちらは一致を強制しただけで `kind` を持つ正規の行は全部通った点で、今回は `kind` を欠く行を書いていた書き手と既存行に例外が出る。この数え方の判断は、上に書いたとおりクローンのものである。

## ADR 0692 との関係【現物】

[ADR 0692](./0692-merged-0916-recheck-teeth-postgres-tiebreak-provenance-check-embedding-analyze.md) は「`provenance` の jsonb に `kind` が無い行は、元の CHECK では NULL になって通る。ADR 0182 はこの端を書いていない」ことを約束外とし、変異「`kind` が無い行も拒む」が既存の歯で緑のままなのを、歯にしなかった。この ADR で約束が決まったので、その端は約束の内に入った。**ADR 0692 の本文は書き換えない。** 同 ADR の「約束外」の記述は当時の状態の記録であり、いまは約束内である。ADR 0182 の本文も書き換えず、末尾に追記でこの ADR を指す。

## 歯【実測】

`packages/postgres/src/__tests__/provenance-kind-present.postgres.test.ts`（使い捨ての DB を作る形。`provenance-kind-check-recheck-0916.postgres.test.ts` と同じ作り）。

- 拒む: `{}`・`{"kind": null}`・`"x"`・`"kind"`・`[]`・JSON の `null`、および `kind` を持つ行から `kind` を外す UPDATE。
- 通す（対照）: `kind` が在って一致している5種の行（書き込み経路から）。
- 元の制約が引き続き拒む（対照）: `kind` が在って一致していない行。
- 既存行に `kind` を欠く行があるときの2段の形（決定4）。

直す前（migration 無し）は 15 件中 8 件が赤、6 件（対照）が緑。直した後は 15 件とも緑。

変異（migration `0033` の式を差し替え、そのつど歯を走らせ、戻して `cmp` で一致を確かめた）:

| 変異 | 結果 |
| --- | --- |
| `CHECK (true)`（制約を実質外す） | 7 件赤（拒む歯の全部） |
| `CHECK (provenance ? 'kind')`（緩める） | 1 件赤（`{"kind": null}`）。`?` が足りない理由の実測である |
| `CHECK (provenance->>'kind' IS NULL)`（やりすぎ。正しい行まで拒む） | 12 件赤（対照の5種を含む） |
| `CHECK (NOT (provenance ? 'kind'))`（やりすぎ） | 11 件赤（対照の5種を含む） |
| `CHECK (provenance_kind IS NULL)`（やりすぎ。列は NOT NULL） | 7 件赤（対照の5種を含む） |

## 引き受ける負債・確かめていないこと

- **生 SQL の書き手に新しく例外が出る。** `kind` を欠く jsonb を書いていた書き手は、`0033` の後で書き込みが拒まれる。`@mnemora/postgres` の API を経由する書き手は影響を受けない見込み（同じ値から両方を書く）。
- **既存行に該当する行がある DB では `0034` が失敗する。** 本番の DB に該当行があるかは見ていない（見られない）。失敗しても `0033` の保護は残る。
- 本番規模の `VALIDATE` の費用は測っていない。ADR 0182 が `0017` について 300k 行で 43ms と測っており、同じ形（行ごとに1つの式を評価する CHECK の走査）なので同程度と推測するが、この制約では測っていない。
- 専用スキーマ（`schema` オプション）での適用は試していない（スキーマ名を SQL に書いていない点は `0016` と同じ）。
- 全体の試験は流していない。関係するファイルを名指しして走らせた。

## これが覆るとしたら

- 生 SQL や別の書き手が、`kind` を欠く jsonb を正当に書く必要が出たとき（その場合は「jsonb の `kind` は任意で、列が正」と決め直す。その決定はオーナーのもの）。
- 生成列へ寄せる決定（ADR 0182「将来、生成列へ寄せるとしたら」）が実行されたとき。そのとき複製が無くなり、この制約も一致の制約も要らなくなる。
