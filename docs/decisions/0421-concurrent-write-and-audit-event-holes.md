# ADR 0421: 同時の書き込みと監査イベントの小さな穴——直したもの（Q1）と、実測して縛って負債にしたもの（R4・R5）

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-30

> **⚠ これはクローンの委譲で動く担い手が書いた。オーナーの判断ではない**（ADR 0220）。
> 方針（Q1 は直す、R4・R5 は塞がず今の振る舞いを縛る歯に留める）は、委譲元のマネージャーが決めた。
> **オーナーが覆せる点は「これが覆るとしたら」にまとめてある。**

3つの穴を1本にまとめる。**Q1 は監査イベントの欄が足りなかっただけで、直した。R4 と R5 は同時実行の窓で、
どの直し方も小さくないので、実測して歯で縛り、負債として名指しした。**

---

## 文脈

同時の書き込みまわりを読み直していて、次の3つが見つかった。3つとも、この ADR の前に実測して確かめた。

### Q1: 群の解消で負けた側のイベントに `meta.supersededById` が無い

`runtime.resolveContestedGroup`（`resolution: { kind: "supersede", winnerId }`）で負けた側に積む
`kind: "superseded"` のイベントの `meta` が `{ reason, resolution }`（と `note`）だけで、勝った側の id を持たなかった。
2者版の `resolveContested` は持っている（[ADR 0150](./0150-resolve-contested-explicit-operation.md) の
2026-09-27 の追記が決めた。`consolidate`・`reextract` の `superseded` と同じ形）。`memories.superseded_by_id`
の列は群版でも入っていた——足りなかったのは `memory_events` の `meta` だけである。

[ADR 0381](./0381-contested-group-write-path-implementation.md) の実装の説明に
「（群の解消のイベントの `meta` は `supersededById` を持たない）」という括弧書きがある。**これは事実の注記であって、
持たせない理由は書かれていない。**

### R4: recall の途中で forget → purge が終わると、purge 前の digest が `recalls.index_band` に残る

`recall` は目次帯（`indexBand.digestBand`）を組んだ後で `createRecall` が `recalls` の行を INSERT する。
その間に、目次帯に載る記憶の forget → purge が終わると、purge の書き換え（`recalls.index_band` の digest を
トゥームストーンへ）は「purge の時点で在る行」にしか届かないので、後から INSERT された行には purge 前の digest が入る。
InMemory（testkit）と Postgres の両方で再現した。歯は
`packages/postgres/src/__tests__/recall-purge-race.postgres.test.ts`（まず赤で窓を示し、その後、今の振る舞いを縛る歯と
負債のコメントに書き換えた。commit は枝の履歴にある）。

### R5: reextract と tick の抽出、または reextract どうしが同時に走ると、同じ Observation から2件が active になる

[ADR 0347](./0347-extract-write-path-redelivery-and-unsaveable-candidates.md) は tick どうしの並行を
「引き受けた負債」として実測している（2026-09-28 の追記。`tick-concurrent-extract.postgres.test.ts`）。
`reextract` と tick、`reextract` どうしは扱っていない（0347 は「`reextract` は決定1の確認を通らない」と書くだけ）。
歯は `packages/postgres/src/__tests__/reextract-concurrent-extract.postgres.test.ts`。

---

## 決めたこと

### Q1: ADR 0150 に揃えて直した

1. 群の解消で負けた側の `superseded` イベントの `meta` に、`supersededById`（勝った側の id）を足した。
   **値は store へ渡している `supersededById` と同じ**（ADR 0381 の大文字小文字の救済のあと、`memberIds` の綴りに寄せた
   `winnerId`）。勝者の `updated` と `both_active` の `updated` には足さない（置き換えられていないため。2者版と同じ）。
2. 欄を足すだけなので**破壊的変更には数えない**（既存の欄は変えていない。conformance にも `it` を足していない）。
3. 歯: `packages/core/src/__tests__/resolve-contested-group.test.ts`（Fake。通常の綴りと、大文字の `winnerId`）と、
   `uppercase-uuid-contested-runtime.postgres.test.ts` の既存の1本への追記（Postgres。イベントの `meta` を読む）。
   赤は commit `afe4d0c`（歯のみ）、緑は `aa806e5`。直しを外すと赤に戻ることも確かめた（下の「測ったこと」）。
4. **ADR 0381 の括弧書きに理由が無かったことの確認**: ADR 0381 の本文で `supersededById` が出る箇所（180・742・746・747 行付近）を
   全部読んだ。747 行の括弧書きは、大文字小文字の救済の説明の末尾に事実として添えられており、なぜ持たせないかは
   どこにも書かれていない。実装した [PR #1442](https://github.com/takecchi/mnemora/pull/1442) の本文（3224 字）にも `supersededById` の語は出てこない
   （PR のコメント・レビューコメント・レビューは0件）。⟹ 持たせない判断があった
   証拠が無く、ADR 0150 の決定と食い違ったまま出ていただけだと読んだ。ADR 0381 の本文は書き換えず、末尾に追記した。

### R4: 塞がない。今の振る舞いを歯で縛り、負債にする

- ADR 0375 が約束しているのは「**purge より前に撃った** recall」の `recalls.index_band` である（#994。同 ADR の文脈）。
  purge の最中・後に**始まって書き込みが後にずれた recall** は、約束の範囲に書かれていなかった。今回の窓はその範囲外の
  ふるまいを実測したものである——約束を破った不具合ではなく、約束の外が空いていた。
- 直し方は3案あり、どれも小さくない:
  - **(a)** `createRecall` の後に Runtime が書き換える。`recalls` を書き換える公開の口（`MemoryStore` の新メソッド）が要る。
    公開の約束（store 契約）が増え、自前の store を持つ人に義務を課す。
  - **(b)** adapter の `createRecall` が、目次帯の記憶行を `FOR SHARE` で読み、purge 済みなら digest を伏せて書く。
    [ADR 0395](./0395-create-recall-activity-clock-single-statement.md) が1文に縮めた `createRecall` に、recall ごとの行ロックと
    2文目を足し、`NewRecallRecord` を「渡したとおりに保存する」約束から外す（InMemory も揃える）。recall の熱い経路を動かす。
  - **(c)** purge が実行中の recall を待つ。recall 側に居場所の登録が要る。大きい。
- **直さなかった理由**: 3案とも公開の約束か recall の熱い経路を動かす。残るのは「同時に走った recall 1件の記録に
  purge 前の digest が残る」ことで、窓は recall の1呼び出しの長さに限られ、purge は別途、以後の recall には効く。
  この大きさの変更を、監査イベントの1欄の直しと同じ枝で入れる釣り合いにない。
- **歯**: 上の `recall-purge-race.postgres.test.ts`。直したらこの `it` は「元の digest が残らない」へ書き換える
  （その ADR で ADR 0375 に「同時に走る recall」の扱いを追記する）。

### R5: 塞がない。今の振る舞いを歯で縛り、負債にする（ADR 0347 の続き）

**実測**（Postgres。順序は門で決めた。詳細は歯のコメント）。先に始めた側を止めて後から始めた側を最後まで走らせ、
その後で先の側を進めた。止める場所は2種類:

| 先に始めて止まる側・止める場所 | 後から終わらせる側 | active になった記憶 |
|---|---|---|
| reextract①・書く直前（既存の記憶を読んだ後）。記憶がまだ無い Observation | reextract② | **2件**（A・B） |
| reextract①・書く直前。記憶が1件（初期）ある Observation | reextract② | **2件**（A・B。初期は②が supersede、①の supersede は `status_changed_concurrently` で skipped） |
| reextract①・LLM の中（`reextract` は LLM の後で既存の記憶を読む） | reextract② | 1件（A。B と初期は superseded） |
| tick の抽出①・LLM の中（tick は書く前に読み直さない。決定1の確認は LLM の前） | reextract② | **2件**（A・B） |
| reextract①・書く直前 | tick の抽出② | **2件**（A・B） |
| reextract①・LLM の中 | tick の抽出② | 1件（A。①が B を読んで supersede する） |

- **前提の一部は違った**: 「reextract どうしなら2件になる」は、止める場所による。`reextract` は LLM が返った**後**に
  既存の記憶を読む（`listBySourceObservation`）ので、LLM の待ちの中で並行しても、後から書いた側が先に書いた側を
  supersede して1件に収束する。**2件になるのは、読んだ後・書く前の窓に、他の書き込みが入ったとき**である
  （reextract の supersede は CAS だが、新しい記憶の INSERT は CAS の結果に関わらず残る）。窓は LLM の待ちより
  ずっと短いが、0ではない。
- tick の抽出は、ADR 0347 決定1の確認（LLM の前）のあとは何も読み直さないので、reextract が LLM の中で書いても、
  reextract の窓の外でも2件になる。これは 0347 の tick どうしの負債と同じ形（同じ Observation から、違う本文なら2件 active）。
- **直さなかった理由**: 塞ぐには、Observation 単位の直列化（advisory lock か、書き込み側の行ロックと再確認）か、
  抽出の冪等性を Observation × 版で縛る新しい制約が要る。ADR 0347 が tick どうしで「塞げない」と負債にしたのと
  同じ理由（LLM の待ちを含む長い区間にロックを持てない。書く直前の再確認だけでは新しい窓が残る）が、reextract にも当たる。
  **同じ Observation を同時に抽出しない運用（Observation 単位で1本ずつ）を、呼び手に求める形の負債**である。
- **歯**: 上の `reextract-concurrent-extract.postgres.test.ts`（6本。2件になる4形と、1件に収束する2形の両方を縛る）。
  **今の振る舞いを縛る歯であり、望ましい姿ではない。**直すなら先にこの歯を書き換える。

---

## 検討した代替案

1. **R4・R5 も同じ枝で直す。** 採らなかった。上のとおり、どれも公開の約束・熱い経路・並行制御の設計を動かす。
   実測して縛らなければ、直す案の比較すらできなかったので、まず縛った。
2. **Q1 の `supersededById` を、ADR 0381 の注記どおり持たせない。** 採らなかった。持たせない理由が書かれておらず、
   ADR 0150 の追記（同じ `superseded` を積む経路は `meta.supersededById` を持つ）と食い違う。`memory_events` だけを読む人
   （監査・エクスポート）が「誰に負けたか」を引けなくなる。
3. **Q1 を破壊的変更として migration-v1 に載せる。** 載せなかった。欄を足すだけで、読む側は知らない欄を無視できる。
   conformance に `it` を足していないので、migration-v1 の一覧に載せる対象でもない。

## 引き受けた負債

- **R4**: purge と同時に走る recall 1件の `recalls.index_band` に、purge 前の digest が残りうる。purge の約束は
  「purge より前に撃った recall」までで、同時に走る recall は範囲外のまま（ADR 0375 への追記で明記した）。
- **R5**: 同じ Observation への reextract と tick の抽出、reextract どうしの並行は、2件 active になりうる（上の表）。
  ADR 0347 の tick どうしの負債と同じ種類で、範囲が reextract に広がった。呼び手は、同じ Observation を同時に
  抽出しないこと。
- **歯が今の振る舞いを縛っている**: 直すときは、先に歯を書き換える。歯が「望ましい姿」に見えないように、
  it 名とコメントに「負債」と ADR を入れた。
- **R5 で測っていないこと**: 3本以上の並行、`supersedeWithNewMemories` の口が無い adapter の経路（`createMemoryWithOutbox` の
  ループ + `updateStatusWithEvent`）での窓、InMemory（testkit の fixture・core の Fake）での並行。窓の位置は runtime の
  コードから読める（読んだ後・書く前）が、歯では確かめていない。

## これが覆るとしたら

- **R4**: recall 記録の digest が purge の約束に含まれるという要請が強まったとき（法的な射程をオーナーが広げたとき）。
  そのときは (b) が最小で、`NewRecallRecord` の約束を変える破壊的変更として migration-v1 に載せる。
  recall の熱い経路の測定（ADR 0395 の1文への縮め方と同じ物差し）で、行ロックの費用が許されるなら (b)。
- **R5**: 同時の抽出が実運用で起きた（reextract をバッチで並列に回す利用者が出た）とき。Observation 単位の
  直列化（advisory lock）を ADR 0347 の負債と同時に設計し直す。
- **Q1**: `meta.supersededById` を持たせない理由が新しく見つかったとき（群のイベントの meta を軽く保つ必要など）。
  そのときは ADR 0150 の追記の側を「群を除く」と直す。

## 測ったこと

- Q1: 赤（歯が2本失敗。`meta` が `{ reason, resolution }` だけ）→ 直して緑。直しを外すと2本（core）・1本（Postgres）が赤に戻る。
- R4: 歯の実測は上。InMemory・Postgres の両方で、purge 後に記録された recall の digestBand に purge 前の digest が残る。
- R5: 上の表。6本を5回続けて走らせ、5回とも同じ結果。歯の期待値を1か所変えると赤になる。
- **測っていないこと**: 上の「R5 で測っていないこと」。
