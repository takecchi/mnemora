# ADR 0276: MRR/hit@1 の判定を「門ではなく並走」で足す — Issue #572 段1

- **状態**: 採用 (2026-09-23)
- **日付**: 2026-09-23

> **⚠ この ADR を書いているのは、自動化された担い手（クローンのマネージャーから
> 切り出された作業者のセッション）である。**
> 🔴🔴 **ここに書いてあるのは _クローンの決定_ であって、オーナー本人の決定ではない。**
> **投稿者欄・commit の著者欄が誰であっても、それだけでは人間かクローンかを区別しない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)、
> `docs/autonomy.md`）。⟹ ⛔ **後から読む者は、この ADR の決定を「オーナーの決定」として
> 引かないこと。**この形は [PR #600](https://github.com/takecchi/mnemora/pull/600) の
> 追記・ADR 0227 の追記が採っているのと同じ名乗りである。

**⚠ 各主張の出所を分ける**（ADR 0227 / ADR 0220 の体裁を踏む）。

- **【実測】** — この作業者が自分の手で走らせて確かめた（下の「測ったこと」節）。
- **【現物】** — この repo のファイル・[Issue #572](https://github.com/takecchi/mnemora/issues/572)
  本文・コメントを、書き手が自分で読んで確かめた。
- **【受】** — [Issue #572](https://github.com/takecchi/mnemora/issues/572) のコメント2件
  （いずれも「クローンのマネージャーのセッション」名義、⛔ オーナー本人ではない）が
  先行して行った測定・判断を、そのまま前提として受け取ったもの。**この ADR の作業者は
  その測定を再導出していない。**

---

## 結論（先に）

`retrieval-quality-regression.postgres.test.ts`（ADR 0227。`goldRank !== null` だけを見る
既存の門）は **1バイトも変更していない。** 代わりに、MRR・hit@1 の閾値判定を

1. **純関数として切り出し**（`examples/chat/src/retrieval-quality-shadow-verdict.ts` の
   `decideRetrievalQualityShadowVerdict()`）、
2. **新しい別ファイルの it 内で実行して結果を標準出力へ記録するだけにし**
   （`examples/chat/src/__tests__/retrieval-quality-shadow-verdict.postgres.test.ts`）、
3. **その it 自身は `verdict.pass` を assert しない**

という形で足した。**新しい CI job・新しいステップ・branch protection の変更はしていない**
——`.github/workflows/ci.yml` は1バイトも変更していない。既存の `example-chat` ジョブの
`test:db`（`vitest run`。`src/__tests__/` を丸ごと拾う）が、この新しいファイルもそのまま
実行する。⟹ **required check の集合も、その合否条件も変わらない。**

## 文脈

[Issue #572](https://github.com/takecchi/mnemora/issues/572) は、ADR 0227 の門
（`goldRank !== null`）の検出力を実測した。その要旨（Issue 本文・コメント2件、いずれも
クローンのマネージャーのセッション名義、【現物】）:

- 無変異での余裕は順位でみると4つ分あるが、**スコアで見ると `diet` probe だけが 1.34%
  という紙一重の差**で残っている。
- 合成した対称ノイズ 165 run（σ 11 段 × seed 15 通り）を通した実測では、**現行の門の
  赤/緑は MRR・hit@1 とほとんど無相関**だった——MRR が基準より高い run（0.785714）で
  赤になり、MRR が基準より 0.19 低い run（0.547619、hit@1 1/7）で緑のままだった。
- 5案（① `PROBES` の n を増やす、② `goldRank` に順位上限、③ MRR/hit@1 に閾値、
  ④ 別の物差し、⑤ 何もしない）のうち、Issue のコメント2件目が①②⑤を明示的に退け、
  ③の方向を「ただし _いきなり required を差し替えない_」という3段構成で採ると判断した
  （【受】、本 ADR はその判断を引き継ぐ）。

この ADR は、その3段構成のうち**段1**（判定を並走させるだけで、門にはしない）を実装した
記録である。

## 決定

### 段1（本 ADR が実装した範囲）

1. **`examples/chat/src/retrieval-quality-shadow-verdict.ts`** に、MRR/hit@1 の閾値判定
   を純関数として置く（`decideRetrievalQualityShadowVerdict()`）。**DB もカセットも
   要求しない。**
2. **`examples/chat/src/__tests__/retrieval-quality-shadow-verdict.test.ts`** に、その
   純関数だけを対象にした歯を置く（DB 不要。境界値・両側の契約を検査する。下の
   「測ったこと」節）。
3. **`examples/chat/src/__tests__/retrieval-quality-shadow-verdict.postgres.test.ts`** に、
   既存の `retrieval-quality-regression.postgres.test.ts` と**同じ** `recorded` provider・
   同じ `fixedClock(2030-01-01)`・同じ `probe-set.ts` の `PROBES`（1件も足さない・変えない）
   で `runRetrievalQualityArm` を1回走らせ、`armHeadline()` から得た MRR/hit@1 を
   `decideRetrievalQualityShadowVerdict()` にかけ、結果を `console.log` で記録する it を
   置く。**この it は `verdict.pass` を assert しない**——落とすかどうかを検査対象に
   していない。
4. **既存の `retrieval-quality-regression.postgres.test.ts` は 1 バイトも変更していない**
   （`git diff origin/main -- examples/chat/src/__tests__/retrieval-quality-regression.postgres.test.ts`
   が空であることを確認済み。下の「測ったこと」節）。
5. **`.github/workflows/ci.yml` は変更していない。** 新しいテストファイルは、既存の
   `example-chat` ジョブの `test:db`（`vitest run`）にそのまま拾われる——これは
   ADR 0227 が既存の歯を配線したのと同じ経路である。
6. **`examples/chat/src/probe-set.ts` の `PROBES` は1件も変更していない。**
   `examples/chat/cassettes/retrieval.json` は録り直していない。

### なぜ閾値を `MRR >= 0.65` かつ `hit@1 >= 3`（7 probe 中）にしたか

[Issue #572 の2件目のコメント](https://github.com/takecchi/mnemora/issues/572#issuecomment-5787571509)
（【受】、この ADR の作業者は再導出していない）が示した反実仮想の表——`affinity` へ
対称な合成ノイズ `× (1 + σ·ε)` を σ 11 段 × seed 15 通り = 165 run 注入し、各 σ について
「その門が赤になった run 数 / 15」を数えた表——のうち、**σ=0.16（品質が全く落ちて
いない帯のすぐ外）まで、合成ノイズに対する偽陽性が実測で 0/15 だった**組を採った:

| 判定          | 無変異 | σ=0.0025〜0.08（MRR中央値が基準のまま。6段すべて） | σ=0.16 | σ=0.24 |
| ------------- | ------ | -------------------------------------------------- | ------ | ------ |
| `MRR >= 0.65` | 緑     | 0/15                                               | 0/15   | 2/15   |
| `hit@1 >= 3`  | 緑     | 0/15                                               | 0/15   | 0/15   |

現物は `examples/chat/src/retrieval-quality-shadow-verdict.ts` のファイル doc に、
コード側からも辿れる形で書いてある。

### ⭐ 「数を焼き込まない」規律との関係（`AGENTS.md`）

`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」は、**`main` が動けば変わる数
（件数・行番号・実測順位・sha）を道具や生成物に写すこと**を禁じている。

**`SHADOW_MRR_THRESHOLD = 0.65` と `SHADOW_HIT1_MIN = 3` はこれに当たらない。** 見分ける
問い（同節「⭐ 見分ける問いは1つ」）は「その数は、どこか別の場所に在る正本の*写し*か、
それとも*測った記録*か」である。この2定数は写しでも測った記録でもなく、**上の表を根拠に
クローンが下した「この基準で判定する」という決定そのもの**である——ADR 0212 が
`@mnemora/local-embedding` のモデルサイズを歯に焼き込んでよいとした理由（「そのサイズは
`main` では動かない」）と同じ形で、**この2つの閾値も `main` が動いても動かない**（次の
`retrieval` 実行結果に依存しない固定値である）。

⛔ **一方、次は焼き込んでいない**:

- **probe の件数（7）**。`decideRetrievalQualityShadowVerdict()` は `probeCount` を
  引数として受け取り、`SHADOW_HIT1_MIN` の分母には使わない（分子側の下限とは独立）。
  呼び出し側（`retrieval-quality-shadow-verdict.postgres.test.ts`）は
  `PROBES.length`（`probe-set.ts` が唯一の出所）から `probeCount` を渡す。
- **実測順位のベクトル（`1,1,2,6,1,1,2`）**。この ADR のどこにも、この値を判定条件として
  埋め込んでいない——上の表に記録として引用しているだけである。

### なぜ「段1」で止めるか — 3段のロードマップ

[Issue #572 の2件目のコメント](https://github.com/takecchi/mnemora/issues/572#issuecomment-5787571509)
が示した3段（【受】、そのままここに引き継ぐ）:

1. **段1（本 ADR）**: MRR/hit@1 の判定を、_門ではなく_ 並走させる。落とさない。出力に
   記録するだけ。
2. **段2（未着手）**: 一定期間、現行の門（`goldRank !== null`）と新しい判定の両方を記録し、
   何に赤くなるかを並べて残す。ADR 0223 決定3 が要求する「偽陽性率の上限」を事後に
   実測で当てるための材料にする。
3. **段3（未着手・オーナー領分）**: 実測で「新しいほうが品質退行を捕まえる」ことを示して
   から、required check の差し替えをオーナーへ上げる。

🔴 **段3 は branch protection（`required_status_checks`）に触るため、オーナー領分である。**
この ADR・この PR はどちらにも触れていない。

### ⭐ なぜ段1 が「門ではない」まま、クローンの領分で始められるか

**段1 は完全に可逆である。** 新しいファイル3本を削除すれば、`examples/chat` の挙動は
段1着手前と1バイトも変わらない——既存の歯・`ci.yml`・branch protection・probe-set.ts・
カセットのいずれにも触れていないため、可逆性を壊す変更が構造的に存在しない。
⟹ **何もブロックしない。検知は予防より先。そして「測った」と「守っている」は別物である**
（【受】、Issue #572 コメント2件目からの引用）。

## 検討して採らなかった案

### 案1（`PROBES` の n を増やす） — ⛔ 採らない。⭐ ただし否定していない。オーナー領分として残す

**不可逆だからである。** `recorded` provider は記録に無い入力で例外になる
（`packages/testkit/src/__fixtures__/recorded-embedding-provider.ts`）ため、probe を
1件足すには `examples/chat/cassettes/retrieval.json` を **実 API で録り直す** 必要がある。
⟹ (a) **課金が発生する**、(b) **ADR 0033 / 0058 / 0227 が記録した過去の実測（`hit@1` 4/7、
順位 1/1/2/6/1/1/2 など）との前後比較の系列が切れる。**課金も、系列を切る判断も、
オーナーの領分である。**

⭐ **なお、Issue #572 本文が引いた「ADR 0058 §1.4 で `PROBES` は凍結されている」は、
逐語に当たると正確ではない。** §1.4 が言っているのは「既存 probe に時刻を書き込むな
（時間項の統制を外すな）」であり、「件数を増やすな」ではない。「凍結」は ADR 0227 が
§1.4 を根拠に敷衍した扱いである（ADR 0227 §「検討して採らなかった案」）。⟹ 規約上の
障壁は Issue 本文の想定より低い。**それでも不可逆性は変わらない。**

### 案2（`goldRank` に順位の上限を置く） — ⛔ 採らない。実測で死んでいる

- `goldRank <= 3` と `<= 5` は **無変異で赤**になる（`diet` probe が6位）。⟹ 書かれた
  形のままでは成立しない。
- `<= 6` は無変異で余裕ゼロ（境界ぴったり）。**MRR がまったく動いていない帯（σ=0.01、
  15 run 中 9 run で MRR が基準のまま）で既に 6/15（40%）が赤**になった（【受】、
  Issue #572 コメント）。
- ⟹ ADR 0223 決定3（偽陽性率に上限を置けない検査は門にしない）の要求から、**現行より
  遠ざかる。**

### 案5（何もしない） — ⛔ 採らない。🔴 これがいちばん危ない

🔴 **門が在ることが _偽の安心_ を与えているからである。** 上の測定のとおり、MRR が
0.19 落ちても、hit@1 が 1/7 まで落ちても、現行の門（`goldRank !== null`）は緑のままである。
⟹ 「緑だから想起品質は落ちていない」と読める形をしているのに、読めない。「余裕4つ分の
負債を引き受ける」という形で受け入れると、**受け入れた負債の中身を取り違える**
（実際の負債は「検出力が薄い」ではなく「当たる場所が `diet` 1点に偏っていて、赤/緑が
MRR・hit@1 とほとんど無相関である」こと）。

## ⚠ この決定が寄りかかっている測定の、確かめていないこと（測定の射程）

🔴 **下の5点は、Issue #572 の測定担当者（クローンのマネージャーのセッション）自身が
明示した限定であり、この ADR はそのまま引き継ぐ。⛔ 広げて主張しない。**

1. ⛔ **CI の器では一度も測っていない。** 「24回でビット単位一致」という無変異の
   再現性は、**手元の器（`initdb` 自製インスタンス）・PostgreSQL 17・2026-09-23** に
   限定される主張である。**並行実行下の揺れ・別ハードウェアでの浮動小数の差は未測。**
2. ⛔ **測ったのは「スコアリング実装の退行」への感度だけである。** 「埋め込みの劣化・
   データの欠落・SQL の退行・カセットの腐り」への感度には一度も触れていない。
3. ⛔ **ADR 0088 §2.1 / ADR 0033 §3 の「n=7 では閾値を置けない」という懸念を、この
   測定は否定していない。** n は7のままであり、「順位が1つ動くと `hit@1` が 4/7 → 3/7
   になる」という算術も変わらない。**`hit@1 >= 3` は、その1つ分の余裕を明示的に飲み込む
   形になっている**——⛔ **懸念を解いたのではなく、飲み込んだだけである。**
4. 🔴 ⛔ **偽陽性を測った退行は、すべて人工的に注入した合成である。** ⟹ ここで言う
   「偽陽性 0/15」は**合成ノイズに対する**ものであって、**「正当な変更」に対するもの**
   ではない。⛔ **後者は置けない**（測っていないし、測れる形をしていない——過去の
   正当な変更を遡って再測する必要があり、カセットが当時のものではない）。
5. ⚠ **ADR 0223 決定3 の「偽陽性率に上限を置く」には操作的定義が無い**（決定3節は
   実例表を並べるだけであり、`AGENTS.md`「🔴 線は引けない」節は「どちらに倒すかの線は、
   いまのところ書けていない」と自分で名乗っている）。⟹ **段2 で何を測れば「上限を
   置けた」ことになるかは、いまの repo では一意に決まらない。** 段3 へ上げるときに、
   この点も一緒にオーナーへ出す必要がある。

**上の5点は【受】である——この ADR の作業者は Issue #572 の元の測定（165 run・24回連続
実行・δ の二分探索）を自分の手で再現していない。** 下の「測ったこと」節にあるのは、
**この ADR の作業者自身が実際に走らせたもの**（純関数の歯・変異試験・DB 統合の1回実行）
だけである。

## 測ったこと（この作業者の【実測】）

**【実測 2026-09-23 / base `origin/main` = `722f45d`】** 測った場: 手元の PostgreSQL 17

- pgvector（`initdb` で自分専用、ポート 55931。`AGENTS.md` の手順）。⛔ CI ではない。

### 既存の歯を1バイトも変えていないことの確認

```
$ git diff --stat origin/main -- examples/chat/src/__tests__/retrieval-quality-regression.postgres.test.ts
(出力なし)
```

### 純関数の歯（DB 不要）

```
$ pnpm --filter @mnemora/example-chat exec vitest run src/__tests__/retrieval-quality-shadow-verdict.test.ts
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

### DB 統合（既存のカセット・`fixedClock(2030-01-01)`・同じ `PROBES` を再利用）

```
$ DATABASE_URL=postgresql://worker@127.0.0.1:55931/mnemora_test \
  pnpm --filter @mnemora/example-chat exec vitest run \
    src/__tests__/retrieval-quality-shadow-verdict.postgres.test.ts --reporter=verbose
[retrieval-quality shadow verdict / Issue #572 段1] MRR=0.738095238095238 (閾値>=0.65)
hit@1=4/7 (最低3) => pass=true
 ✓ …影分身判定の結果を記録する(⛔ 落とさない) 1531ms
 Test Files  1 passed (1)
      Tests  1 passed (1)
```

⟹ **測定値は Issue #572 コメント2件目が実測した基準（MRR=0.738095、hit@1=4/7）と一致した。**
既存の `retrieval-quality-regression.postgres.test.ts` も同じ条件で緑のままであることを
確認済み（上の「測ったこと」直前の diff、および単体実行で `1 passed`）。

### 変異試験 — 「足りない」側（判定ロジックを緩める）

`examples/chat/src/retrieval-quality-shadow-verdict.ts` を `cp` で退避し、変異を入れ、
`vitest run src/__tests__/retrieval-quality-shadow-verdict.test.ts` を実行、`cp` で戻す、
という手順（`AGENTS.md`「⛔ 変異を戻すのに `git checkout` を使わない」節どおり）。

**M1: `pass: mrrOk && hit1Ok` → `pass: hit1Ok`（MRR 側のガードを外す）**

```
Tests  2 failed | 6 passed (8)
 FAIL … > MRR だけが閾値を下回れば fail、reasons は MRR の理由だけを積む
   AssertionError: expected true to be false
 FAIL … > MRR が閾値よりわずかでも下なら fail(境界のすぐ外)
   AssertionError: expected true to be false
```

戻した後、`cp` で復元 → `8 passed (8)` を再確認。`git status --porcelain` は空。

**M2: `pass: mrrOk && hit1Ok` → `pass: mrrOk`（hit@1 側のガードを外す）**

```
Tests  2 failed | 6 passed (8)
 FAIL … > hit@1 だけが最低件数を下回れば fail、reasons は hit@1 の理由だけを積む
 FAIL … > hit@1 が最低件数よりちょうど1件少なければ fail(境界のすぐ外)
```

戻した後、`8 passed (8)` を再確認。`git status --porcelain` は空。

### 変異試験 — 「やりすぎ」側（ガードを外して無条件に通す／落とす）

**M3: `pass: mrrOk && hit1Ok` → `pass: true`（無条件に pass）**

```
Tests  5 failed | 3 passed (8)
```

fail を期待するテスト5本すべてが red になった（境界・単独条件・両方下回るケースを含む）。
戻した後、`8 passed (8)` を再確認。`git status --porcelain` は空。

**M4: `pass: mrrOk && hit1Ok` → `pass: false`（無条件に fail）**

```
Tests  3 failed | 5 passed (8)
```

pass を期待するテスト3本すべて（無変異・MRR境界・hit@1境界）が red になった。
戻した後、`8 passed (8)` を再確認。`diff` で元ファイルとバイト一致を確認、
`git status --porcelain` は空。

⟹ **4種の変異（緩めた側2本・無条件側2本）すべてで、狙った歯だけが赤くなり、復元後に
全8本が緑へ戻ることを確認した。** 契約の両側（下回ったら fail・上回ったら pass）を
証明できている。

## これが覆るとしたら

- **段2 の記録期間中に、`hit@1 >= 3` / `MRR >= 0.65` が「正当な変更」に対しても頻繁に
  赤くなることが分かったとき。** そのときは閾値を緩める（または別の物差しへ乗り換える）
  判断が要る——この ADR に追記するか、新しい ADR を起こすかは、その時点の判断に委ねる。
- **段2 の記録期間中に、現行の門（`goldRank !== null`）が拾わず、新しい判定だけが拾った
  実際の退行が観測されたとき。** そのときが段3（required への差し替えをオーナーへ
  提起する）の根拠になる。
- **ADR 0223 決定3 の「偽陽性率に上限を置く」の操作的定義が repo 内で定まったとき。**
  そのとき、上の「測定の射程」5番の留保が解け、段2 で何を測ればよいかが一意に決まる。

## ⚠ 確かめていないこと（この ADR 自身の作業について）

- ⛔ **CI の器での挙動は測っていない。** 上の「測ったこと」はすべて手元の
  `initdb` インスタンスに対するものである。
- ⛔ **`decideRetrievalQualityShadowVerdict()` を通した実際の run は1回だけである**
  （上の DB 統合の実行）。分布・再現性は測っていない——Issue #572 の24回連続実行・
  165 run の合成ノイズ注入は、この ADR の作業では再現していない（【受】のまま）。
- ⛔ **段2・段3 は着手していない。** この ADR は段1 の範囲に限定される。
- ⛔ **`examples/chat/src/retrieval-quality-shadow-verdict.postgres.test.ts` が
  `example-chat` ジョブの `test:db` を通して CI 上で実際に緑のまま通ることは、
  この作業では GitHub Actions 上で観測していない**——手元の `initdb` インスタンスでの
  実行のみ確認した。CI 上での確認は、この PR の CI 実行そのものに委ねる。
