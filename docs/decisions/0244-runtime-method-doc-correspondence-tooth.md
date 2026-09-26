# ADR 0244: `Runtime` のメソッドが3文書（README/vision/architecture）で名指しされていることを歯で縛る（Issue #518）

- **状態**: 採用 (2026-09-19。[ADR 0283](./0283-adopt-merged-adrs-whose-decision-is-on-main.md) で担い手が「草案」から倒した——オーナー本人の判定ではない)
- **日付**: 2026-09-19

> **⚠ この判定は、自動化された担い手（クローンのマネージャーのセッション）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: クローンの署名は repo 上では `takecchi` になり、**オーナー本人と区別が付かない**
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が
> 要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0241 / 0242 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` を走らせて確かめた。
- **【受】** — 報告として受け取り、再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】は `origin/main` = `41b07fd`（本 ADR の作業を始めた時点）の木で、
2026-09-19 に行った。

---

## 文脈

[Issue #518](https://github.com/takecchi/mnemora/issues/518) は「README.md / docs/vision.md /
docs/architecture.md の3文書が `Runtime` のメソッド数を独立に焼き込んでいる」ことを報告した。
[PR #531](https://github.com/takecchi/mnemora/pull/531)（マージ 2026-09-17T22:51:15Z、
`Refs #518`）が方向1（数を消して正本を指す）を実装し、**数の焼き込みは解消した。**
⟹ 【実測】`grep -rn "10個" --include=*.md .` の当たりは
`docs/decisions/0124-purge-physical-delete.md:26` の1件だけである——`purge` が無かった当時の
記録であり、触ってはいけない側（ADR 0213 が「ソース全件を書き換える」を却下した理由と同じ、
記録の書き換えになるため）。

🔴 **しかし [Issue #518](https://github.com/takecchi/mnemora/issues/518) 本文が方向1の弱点として
逐語で予告していたことが、1日で現実になった**:

> 数だけ消して列挙を残すと、列挙のほうが腐る。

【実測】[PR #537](https://github.com/takecchi/mnemora/pull/537)（マージコミット `dc995fa`、
2026-09-18、ADR 0242）で `Runtime.applyCorrection` が入り、**3文書のどこにも名前が出ていない
状態になった**——本 PR の【コミット1】で確かめ、直した（3文書に `applyCorrection` を
「どの層にも置かれていない」側として名指しした）。

---

## ⛔ Issue #518 は「引き受けないこと」に「歯を作ること」を挙げていた。本 ADR はそれを覆す

Issue #518 本文の逐語:

> ⛔ **歯を作ること。**#512 が同じ理由で保留している（逐語「**#505 の決定9 が成文化される前に
> 歯を作ると、歯が『正しい焼き込み』まで捕まえる**」）。⟹ **この ISSUE も同じ理由で保留する。**

**その前提は崩れている**。【実測】次の3箇所が `AGENTS.md` に在る（行番号は補助であり、
**出典は逐語の文字列のほうである**——`main` が動けば行番号はずれる）:

```
grep -Fn -- '数を、道具と生成物に焼き込まない' AGENTS.md
→ 255:### ⚠ 数を、道具と生成物に焼き込まない

grep -Fn -- '線は「`main` が動くと変わるか」である' AGENTS.md
→ 266:#### ⭐ 線は「`main` が動くと変わるか」である

grep -Fn -- '対象外 —— **実測して repo にコミットした基準値**' AGENTS.md
→ 274:#### ⛔ 対象外 —— **実測して repo にコミットした基準値**
```

出所コミットは `29d4864`（[PR #520](https://github.com/takecchi/mnemora/pull/520)、
MERGED 2026-09-17T18:44:36Z）、ADR は
[ADR 0234](./0234-bake-no-numbers-into-tools-and-artifacts.md)（**状態: 採用 (2026-09-18)**【現物】）。

[#505](https://github.com/takecchi/mnemora/issues/505) の判定コメント
（[issuecomment-5714433725](https://github.com/takecchi/mnemora/issues/505#issuecomment-5714433725)）
の逐語要求:

> yes（`AGENTS.md` の射程を道具・生成物まで広げる）。ただし「線」と「対象外」を*同時に*書くこと

⟹ **両方が入っている**（上の grep で実在を確認した「線」節と「対象外」節）。

⚠ **ただしこの判定コメントはクローンのものであり、オーナー本人の決定ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
**この限定は必ず付けたまま読むこと。**「#505 決定9 が成文化された」というのはクローンの
判定にオーナー本人がまだ直接応答していない状態での実測であり、方向そのものの正しさを
オーナーが承認した、という意味ではない。

⟹ **Issue #518 が歯を保留した根拠（「#505 の決定9 が成文化される前」）は、字義どおりには
既に満たされている。** これを根拠に、本 ADR は Issue #518 の保留を覆し、方向2（歯を作る）を採る。

---

## 決定

### 決定1. Issue #518 の方向2 を採る

`Runtime` のメソッド名の集合を実体から機械的に数え直し、3文書がそれを名指ししているかを
検査する歯を置く（`scripts/__tests__/runtime-method-doc-correspondence.test.mjs`）。

### 決定2. 正典はテストの中に写さない。`packages/core/src/runtime.ts` から導出する

⭐ **理由**: `Runtime` のメソッド集合は **`main` が動けば変わる**側であり、`AGENTS.md` の
「線」（決定9 が広げた射程の「⭐ 線は『main が動くと変わるか』である」節）がまさにそれを禁じている。

### 決定3. ADR 0212 の型（正典値を literal で持つ）はそのままでは持ち込めない

⚠ ADR 0212（`local-embedding-size-noun-correspondence.test.mjs`）が literal でよいのは、
**モデルサイズが `main` では動かない側**だからである。

⟹ **本 ADR が ADR 0212 から継いだのは「literal を持つなら、その literal が一次資料に実在する
ことを別の `it` で検査する」という部分だけで、「正典値を literal で持つ」部分は継いでいない。**
⭐ この書き分けを落とすと、先例を型ごと持ち込むことになり、この歯自身が
「main が動けば変わる数を焼き込まない」という規律を破ることになる。

### 決定4. literal で持つのは中核5動詞だけ

正典（`docs/vision.md`「外から見える API: 中核の5動詞」）が逐語で「ここは増やさない」と
固定している＝`main` が動いても変わらない側だからである。そのうえで一次資料
（`docs/vision.md`）に実在することを歯（`it` 1）で検査する。

### 決定5. 歯が縛るのは名前の集合だけである。3層への振り分けは縛らない

意味の判定であり機械には決まらない（Issue #518 本文、
[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定2 見出しの
逐語「機械に載せてよいのは『実体から機械的に数え直せるもの』だけ。意味の判定と、副作用のある手は
機械に打たせない。判定できないときは、通さずに止める」、同決定2が引く
[ADR 0199](./0199-identifier-probes-readme-freshness-tooth.md) の逐語
「**歯が縛ってよいのは実体から機械的に数え直せる件数・群数だけであり、性能の解釈は人間の
読み物（README のプローズ）に残す**」）。

### 決定6. 新しい CI ジョブ・新しいステップを足さない

`vitest.config.mts` の `include: ["scripts/**/*.test.mjs"]` に相乗りし、required ジョブ
`typecheck / lint / test / build` の `pnpm run test` で走る（ADR 0212 決定6 と同じ論拠——
【現物】`local-embedding-size-noun-correspondence.test.mjs` も同じ形で相乗りしている）。

### 決定7. 失敗メッセージに「どの文書のどこを直すか」と「何をしてはいけないか」を出す

⚠ **検査が存在することは、誰がそれを満たすべきかを何も言っていない**——赤いだけで手順が
分からない歯は、次の担い手が回避策で越える。歯の失敗メッセージは「どのファイルにどの
メソッド名が無いか」と「3層のどれかに分類する義務は無い（どの層にも置かれていない側へ
名指しするだけでよい）」「個数を書き戻さない」を明示する。

---

## 歯が噛むことを示した【実測】

`scripts/__tests__/runtime-method-doc-correspondence.test.mjs`（vitest、4 tests、全緑）。

| 検査                                                                             | it                                                                                                        |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| 中核5動詞の literal が一次資料（`docs/vision.md`）に実在する                     | `中核5動詞の literal が、一次資料 docs/vision.md に実在する`                                              |
| `export interface Runtime` から名前の集合を機械的に数え直せる（陽性対照 + 下限） | `export interface Runtime から、メソッド名の集合を機械的に数え直せる`                                     |
| 非中核メソッドが3文書すべてで名指しされている（本体）                            | `Runtime のメソッド（中核5動詞を除く）は、README / vision / architecture の3文書すべてで名指しされている` |
| 3文書が実在して空でない（空回り防止）                                            | `この歯が読んでいる3文書が、実在して空でない`                                                             |

**変異試験【実測】**（`cp` で退避・復元。⛔ `git checkout` は使っていない）:

1. **README.md から `applyCorrection` の全出現（バッククォート付き、2箇所）を消す変異**
   （sed で1コマンド。バッククォート文字自体を含むため、ここではフェンス付きブロックで示す）:

   ```
   sed -i 's/`applyCorrection`/APPLYCORRECTION_REMOVED/g' README.md
   ```

   `pnpm exec vitest run scripts/__tests__/runtime-method-doc-correspondence.test.mjs` を
   打つと、本体の `it` だけが赤くなり（4 tests 中 1 failed）、失敗メッセージに逐語で
   次が出た:

   ```
   Runtime のメソッドが、生きた文書で名指しされていない:

     README.md         に無い: applyCorrection

   ⟹ どうすればよいか:
     packages/core/src/runtime.ts の `export interface Runtime` に口を足したら、
     上の文書の「中核を守る3つの層」の節に、その名前を `バッククォート付き` で書くこと。
     ⭐ 3層のどれに分類するかは意味の判定であり、この歯は縛っていない。
        分類が決まらないなら「どの層にも置かれていない」側に名指しするだけでよい
        （README.md / docs/vision.md / docs/architecture.md に既にその形が在る）。
     ⛔ この歯を満たすために、個数を文書へ書き戻さないこと
        （AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。
   ```

   `cp /tmp/README.md.orig README.md` で復元後、同じ4 tests が全緑に戻ることを実測した
   （`diff` で復元前のファイルと一致することも確認済み）。

2. **`packages/core/src/runtime.ts` に架空のメソッド `fooBarBaz(): void;` を1行足す変異**——
   `export interface Runtime {` の直後に挿入。同じ vitest を打つと、本体の `it` が赤くなり、
   失敗メッセージに **README.md / docs/vision.md / docs/architecture.md の3文書すべて**が
   「`fooBarBaz` に無い」として列挙された——**正典側（`runtime.ts`）が動いたら、3文書すべてに
   対して同時に鳴る**ことを実測した。`cp` で復元後、`diff` で一致を確認し、同じ4 tests が
   全緑に戻ることも実測した。

`eslint scripts/__tests__/runtime-method-doc-correspondence.test.mjs` — 成功（警告0）。
`prettier --check`（同ファイル・本 ADR・README.md・docs/vision.md・docs/architecture.md）
— `prettier --write` で歯のファイルを整形後、成功。**3文書（README/vision/architecture）は
本 PR の変更前から `prettier --check` が失敗する既存の状態だった**——【実測】
`git stash` で本 PR の変更を一時的に外した状態でも同じ3ファイルが `prettier --check` で
警告を出すことを確認した。⟹ 本 PR がこの失敗を新しく持ち込んだのではない。

---

## ⛔ この歯が捕まえないもの

⚠ **検査が存在することは、それが何を保証するかを何も言っていない。**
⟹ **この節を消さないこと。**消すと、次の担い手が「歯が在るから3文書は正しい」と読む。

本 ADR の不変条件は「`Runtime` のメソッド（中核5動詞を除く）の各名前が、3文書すべてに
バッククォート付き（`` `name` ``）で**実在する**」だけである。⟹ **次の3つは緑のまま通る。**

1. 🔴 **名前は在るが、割り振られた層が間違っている。**
   例: `applyCorrection` を誤って「**保守操作**」の列に書いても、この歯は緑である（名前は在るため）。
   ⟹ **層の正しさは、人が読むことでしか守られていない。**
2. 🔴 **「どの層にも置かれていない」と名指しされた口の集合が、実体と食い違っている。**
   ⟹ 当初案（`Runtime` のメソッド集合 ＝ 中核5動詞 ∪ 3層の列挙 ∪ 未配置の名指し、の**完全一致**）は
   この面を狙っていたが、**採らなかった**——完全一致を機械で見るには「どの名前がどの層に属すると
   書かれているか」をプローズから読み取る必要があり、それは下の採らなかった案4（節を切り出して
   プローズをパースする形、ADR 0199）に落ちるためである。
   ⟹ ⭐ **これは取りこぼしを承知で選んだトレードオフであって、見落としではない。**
3. 🔴 **名前が「どこに」書かれているかを見ていない。** 3文書のまったく無関係な場所に名前が1度
   出ていれば通る。⟹ 保証するのは「**名前が落ちていないこと**」だけで、「正しい節で説明されて
   いること」ではない。

⭐ **⟹ この歯が実際に止めるのは、Issue #518 が踏んだ形そのもの1つだけである**——
**`Runtime` に口が増えたのに、3文書のどれかがそれを一度も名指ししないまま `main` へ入ること。**
（【実測】`applyCorrection` が `dc995fa` で入ってから本 PR まで、3文書のどこにも名前が出ていなかった。）
⛔ **それ以上のことは主張しない。**

---

## 引き受けた負債

- ⭐ **この歯が捕まえないもの3つ（層の取り違え / 未配置の集合の食い違い / 名前の書かれている
  場所）は、上の「⛔ この歯が捕まえないもの」に独立した節として分けて書いた。そちらを読むこと。**
- **`Runtime` 以外の interface（`MemoryStore` など）に同じ形の焼き込みが在るかは掃いていない**
  （Issue #518 本文も同じことを「確かめていないこと」に挙げている）。
- **中核5動詞の literal は、正典が「増やさない」と言っていることに依存している。** その方針が
  変われば、この literal は腐る（ただし `it` 1 が一次資料との食い違いを検出する）。

## これが覆るとしたら何が起きたときか

- `Runtime` に「3文書では説明しない」と決めた口が入ったとき（⟹ 除外の形が要る。いまは無い）。
- 3文書のどれかが畳まれたとき、または `Runtime` interface の宣言の形（行頭2スペース）が
  変わったとき（⟹ `it` 2 の陽性対照が先に落ちる）。

## 採らなかった案

### 1. 方向1のみ（数を消すだけ）

⛔ **既に PR #531 が実施済みで、それでも列挙が腐った。**本 ADR はその実測の上に立っている。

### 2. 方向3（3文書のうち1本を正文にし、残り2本は指すだけにする）

⛔ 3本は宛先が違う（README=利用者 / vision=理解 / architecture=実装者）。Issue #518 本文が
この点を指摘している。

### 3. 方向4（腐ったまま名乗る）

⛔ 腐りが1日で再発したことを実測した後にこれを採ると、**次も同じ形で腐る。**

### 4. 節を切り出してプローズをパースする形

⛔ [ADR 0199](./0199-identifier-probes-readme-freshness-tooth.md) が、表現が変わると
歯自体が壊れる形として落としている。⟹ ファイル全体に文字列が在るかだけを見る（この歯の形）。

### 5. 3層への分類まで歯で縛る形

⛔ 意味の判定であり機械には決まらない（Issue #518 本文が自ら切り分けている。決定5 参照）。

---

## 測ったこと / 確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- 【実測】`grep -rn "10個" --include=*.md .` — `docs/decisions/0124-*.md` の1件のみ。
- 【実測】`export interface Runtime` を機械的に数えると17本、うち非中核12本
  （`tick` / `getRecall` / `findCorrectionCandidates` / `reextract` / `reembed` /
  `sweepArchive` / `restoreArchived` / `restoreSuperseded` / `purge` / `markContested` /
  `resolveContested` / `applyCorrection`）。この12本すべてが、本 ADR の作業直前の時点で
  3文書すべてに `` `name` `` の形で在ることを確認した（歯を書く前の手作業での確認）。
- 【実測】上記「歯が噛むことを示した」節の変異試験2本（README.md 側・runtime.ts 側）。
- 【実測】`pnpm exec vitest run scripts/__tests__/runtime-method-doc-correspondence.test.mjs`
  （変異前後とも）、`pnpm exec eslint`、`pnpm exec prettier --check`。
- 【実測】AGENTS.md の3箇所（255/266/274行、逐語一致）、PR #520 のマージ日時、
  ADR 0234 の状態、Issue #505 の判定コメント本文。
- 【実測】PR #531（マージ 2026-09-17T22:51:15Z）・PR #537（マージコミット `dc995fa`、
  2026-09-18）の存在とマージ状態（`gh pr view`）。

### 確かめていないこと

- ⛔ **ルートの `pnpm run test`（全体）は走らせていない**（依頼元の指示どおり、新規テスト
  ファイル1本だけを走らせた）。
- ⛔ **`packages/postgres` の DB テスト・実 API を通した経路は確認していない**——本 ADR の
  変更は `scripts/` のテスト1本とドキュメント3本のみであり、DB・LLM・embedding のいずれにも
  触れていない。
- ⛔ **オーナー本人の確認は取っていない**（冒頭のバナーのとおり、これはクローンの判定である。
  「#505 決定9 が成文化された」という前提の再評価もクローンが行ったものである）。
- ⛔ **3文書以外（`packages/*/README.md` 等）に同じ形の焼き込みが無いかは調べていない**
  （Issue #518 のスコープがこの3文書だったため、歯の対象もそれに揃えた）。

---

## 追記（2026-09-26、Issue #926）

> ⚠ この追記は、自動化された担い手（クローン miku のセッションから切り出された担い手）
> のものである。
> ⛔ オーナー本人の判定ではない
> （[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。

**上の「⛔ この歯が捕まえないもの」が挙げた3つとは別に、4つ目の盲点が在った。**
`extractRuntimeMethodNames`（`scripts/__tests__/runtime-method-doc-correspondence.test.mjs`）の
抽出用正規表現（`/^ {2}([A-Za-z][A-Za-z0-9_]*)\s*[(<]/`）は、TypeScript の任意メソッド構文
（`name?(`/`name?<`）を抽出できなかった。**名前を抽出できないメソッドは、下の「本体」の
`it` の検査対象（`target`）にそもそも入らない**——3文書のどれにも名指しされていなくても、
この歯は一度も検査せず緑のままになる。この歯が本来止めるはずだった壊れ方
（`Runtime` に口が増えたのに3文書のどれも名指ししないまま `main` へ入ること）を、任意
メソッドに限って素通りさせる形であり、上の3つ（層の取り違え・未配置集合の食い違い・
名前の場所）のどれとも異なる。

**発見の経緯**: [Issue #605](https://github.com/takecchi/mnemora/issues/605) の検算
（`main = 7849377`）で、`resolveOrphanedContested?`（[Issue #825](https://github.com/takecchi/mnemora/issues/825)、
`7ab8948`）が抽出結果から丸ごと落ちることを見つけ、[Issue #926](https://github.com/takecchi/mnemora/issues/926)
として切り出した。この ADR・ADR 0270・ADR 0272 のいずれも、当時（`Runtime` に `?` 付き
メソッドが存在しなかった時点）この形を想定していなかった。

**直したこと**: 正規表現を `/^ {2}([A-Za-z][A-Za-z0-9_]*)\??\s*[(<]/` に変え、名前の
直後の任意の `?` を許すようにした。抽出関数はブロック文字列を引数に取る形
（`extractMethodNamesFromBlock`）に分け、`resolveOrphanedContested` を含む18本すべてを
抽出できることを確認した。

**変異試験【実測】**（`cp` で退避・復元。⛔ `git checkout` は使っていない）:

直す前の正規表現のまま、README.md の是正・取り消し層の列挙から `` `resolveOrphanedContested` ``
を消す変異を当てると、`pnpm exec vitest run scripts/__tests__/runtime-method-doc-correspondence.test.mjs`
は **4 tests とも緑のまま**だった——取りこぼしを実際に再現した。直した正規表現で同じ変異を
当て直すと、本体の `it` が赤くなり、失敗メッセージに逐語で
`README.md         に無い: resolveOrphanedContested` と出た。`cp` で復元後、5 tests
（後述の陽性対照を1本足したため4→5）が全緑に戻ることも確認した。

**恒久的な回帰止め**: 上の変異試験は一過性の手作業であり、`runtime.ts`・3文書のどちらも
書き換えていない。代わりに、実在の `Runtime` を経由しない fixture（`export interface
Sample { required(...); optional?(...); optionalGeneric?<T>(...); }` 相当の文字列）に
対して `extractMethodNamesFromBlock` が3つとも抽出することを固定する陽性対照の `it` を
歯のファイル自体に足した——ADR 0270/0272（`runtime-method-count-not-baked.test.mjs`）が
サンプル文字列で陽性対照を歯の中に残している形に倣った。

**確かめていないこと**:

- 同種の「行頭2スペースのメソッド宣言を正規表現で抽出する」歯が他に無いかを掃いた範囲では、
  [ADR 0278](./0278-architecture-section5-port-interface-correspondence-tooth.md) の歯
  （`scripts/__tests__/architecture-section5-port-interface-correspondence.test.mjs`、
  正規表現は既に `\??` を含む）はこの盲点を持たない。`runtime-method-count-not-baked.test.mjs`
  （ADR 0270/0272）はメソッド名を抽出する構造を持たず対象外。`scripts/public-api-surface-lib.mjs`・
  `scripts/public-api-breaking-diff-lib.mjs`（ADR 0178）は正規表現ではなく TypeScript
  コンパイラ API（`typescript` パッケージ）で解析しており対象外。**ただしこれは
  `scripts/__tests__/` 配下と `scripts/` 直下を中心にした確認であり、リポジトリ全体を
  網羅した grep ではない。**
- `Runtime` 以外の interface（`MemoryStore` 等）に、同じ形（正規表現ベースの抽出漏れ）が
  無いかは調べていない。
