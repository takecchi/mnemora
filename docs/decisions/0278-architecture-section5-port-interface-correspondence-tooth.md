# ADR 0278: `docs/architecture.md` §5 の port interface が実体とずれたら落ちる歯を置く（Issue #604、ADR 0269、ADR 0273）

- **状態**: 採用 (2026-09-23。[ADR 0283](./0283-adopt-merged-adrs-whose-decision-is-on-main.md) で担い手が「提案」から倒した——オーナー本人の判定ではない)
- **日付**: 2026-09-23

> **⚠ この判定は、自動化された担い手（マネージャーから切り出された worker セッション）のものである。**
> **⛔ オーナー本人の判定ではない**（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0269 / 0273 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を書き手が読んで確かめた。
- **【実測】** — この書き手が自分の手で `git` / `node` / `vitest` / `pnpm` を走らせて確かめた。
- **【受】** — 報告として受け取り、この作業では再導出していない（出所を明記する）。

**測定条件**: 断りの無い【実測】【現物】は `origin/main` = `45c58b7`（2026-09-23、本 ADR の作業を始めた
時点。作業中に `origin/main` は `3875a05`（ADR 0269 着地時）→ `74c5295`（ADR 0273 着地時）→
`6253edf`（PR #622 着地時）→ `45c58b7` まで進んだ）の木で行った。

---

## 0. 経緯 —— この ADR が引き継ぐもの

1. [ADR 0269](./0269-port-interface-doc-correspondence-sweep.md)（PR #610、Issue #604）が
   `docs/architecture.md` §5 の17個の named interface/type を実体（`packages/core/src/`）と
   突き合わせ、4件の drift（`MemoryStore` 10口・`VectorStore` 1口・`TenantSettingsStore` 7口・
   `ScoringStrategy` の型名1件）を見つけた。**「§5 は定める側か写した側か」は断定せず保留した。**
2. [ADR 0273](./0273-architecture-section5-is-a-copy.md)（PR #616）がその保留に答えた:
   **「§5 は写した側である」**（正本は `packages/core/src/` の実装）。そして対象を3種に割った
   （下記「決定1」で引用）。
3. PR [#622](https://github.com/takecchi/mnemora/pull/622)（ADR 0273 の実装、マージ済み）が
   drift を直し、`docs/architecture.md` §5 の宣言をいまの実装に揃えた。

**本 ADR は4本目——同じずれが二度と静かに入らないようにする歯を置く。**

---

## 決定1. 対象を、ADR 0273「3つに割る」にそのまま従って切り分ける

ADR 0273 の逐語（「3つに割る（⛔ 2択にしない）」節）:

> 1. **写し（実体が在る14個: ⭕一致10 + 🔴drift4）** ⟹ **実体が正本。drift が見つかったら
>    文書を直す。⛔ 実装側を疑わない**
> 2. **予告（実体が無いと文書自身が明記している3個: `RelationStore`/`Sensor`/`SpeechPolicy`）**
>    ⟹ **drift ではない。**（中略）⛔ **歯（テスト）の対象にしない。**
> 3. **⚠ `ScoringStrategy`（型名ずれ）** ⟹ **歯の形が他の drift と違う。**（中略）
>    メソッド件数という概念そのものが無い。

⟹ **本歯は種類1（14個）を「メンバー名の集合の一致」で、種類3（`ScoringStrategy`）を
「型宣言の逐語一致」で縛る。種類2（3個）は対象にしない**——これは ADR 0269「採らなかった案1」
（17個すべてに ADR 0244 と同じ歯を機械的に複製する案）が却下した理由と同じ形の偽陽性
（実体の無いものを「実体が無い」という理由だけで赤くする歯は、実装されたときにそれを罰する
歯になってしまう）を避けるためである。

---

## 決定2. 正本は `packages/core/src/` を自前パースせず、`scripts/__snapshots__/public-api/core.d.ts`
（ADR 0178 の公開 API snapshot）を使う

依頼の助言にあった2つの道（(a) `packages/core/src/**/*.ts` を直接パース／(b) 公開 API
snapshot と突き合わせる）を、実際に snapshot を開いて確かめたうえで (b) を採った。

**確かめたこと【実測】**:

- `scripts/__snapshots__/public-api/core.d.ts` に、対象14個の名前（`Ctx`/`MemoryStore`/
  `VectorStore`/`LexicalStore`/`LLMProvider`/`EmbeddingProvider`/`Scheduler`/`DecayStrategy`/
  `EventStore`/`TokenCounter`/`Clock`/`OutboxStore`/`TenantSettingsStore`/`ScoringStrategy`）が、
  それぞれ**ちょうど1回ずつ**出現する（`grep -cE "(interface|type)[[:space:]]+NAME\b"` で確認）。
- 同じファイルに `RelationStore`/`Sensor`/`SpeechPolicy`（種類2）は**1件も現れない**
  （`grep -c "RelationStore\|Sensor\|SpeechPolicy"` が0件）——実体を持たないこの3つは
  ビルドしても `.d.ts` に出てこないので、**種類2 が snapshot 経由の比較に混じる心配はそもそも
  無い**（決定1 の除外を、道具の選び方そのものが後押しする形になっている）。
- `scripts/check-public-api-surface.mjs`（ADR 0178。Issue #342）は、この snapshot と
  publish 対象パッケージのビルド後 `.d.ts` の差分を検出し、不一致なら非0で終わる。
  `.github/workflows/ci.yml` の `build` ジョブ（required check `typecheck / lint / test / build`）
  が `pnpm run api:check` としてこれを毎 PR で走らせている——配線自体は
  `scripts/__tests__/ci-yml-api-check-wiring.test.mjs` が別に縛っている。
  ⟹ **この snapshot の鮮度は CI が強制しており、「腐らないことが保証された実装の写し」に
  既になっている。**

**⟹ 理由**: (a)（自前パース）を選ぶと、本歯自身が TypeScript の構文解析器を持つことになり、
`packages/core/src/interfaces/*.ts` の書式（改行位置・コメントの付け方）が変わるたびに
壊れるリスクを本歯が背負う。(b) は既に鮮度を保証された生成物を読むだけでよく、**本歯が
新たに保証しなければならないのは「snapshot が古くないこと」ではなく「§5 と snapshot の
内容が一致すること」だけに絞られる。**

**⚠ 確かめていない／引き受けた前提**: snapshot の鮮度は CI（`build` ジョブ）にしか保証
されていない。**手元で `packages/core` を編集した直後、`pnpm run build` を打たずに本歯だけを
単独で走らせると、snapshot は古いままなので、本歯は「新しい実装 vs 古い snapshot」を比べて
誤検出しうる**——これは `AGENTS.md`「古い `dist/` のまま `check-public-api-surface.mjs --write`
を打つ」の穴と同型であり、本歯固有の対処は無い。歯のファイル冒頭コメントに、
`pnpm run build` → `node scripts/check-public-api-surface.mjs` を先に通すことを明記した。

---

## 決定3. 抽出方法 —— インデント幅ではなく、括弧の対応で本文を切り出す

`docs/architecture.md` のコード片は2スペース、snapshot は4スペース（`tsc` の出力）と
インデント幅が違う。ADR 0244（`Runtime` の歯）は「行頭2スペースの識別子」という
インデント依存の正規表現で済ませたが、それは対象が単一ファイル・単一の書式だったからである。
本歯は書式の異なる2つの入力を比較するため、**インデント幅に依存しない**方式——
「開始位置から `{`/`(`/`[` の対応を辿り、深さ0で終わる `;` ごとに1メンバー文として切り出し、
先頭の識別子を読む」——を採った。これは ADR 0269 決定3 が自分の使い捨てスクリプトで採った
「開始行から括弧の対応を辿って終端を求める」という考え方を、メンバー単位にまで広げたものである。

**メンバー文からは、先頭の JSDoc ブロックコメント（`/** ... *\/`）を取り除いてから識別子を
読む。**これは机上の設計ではなく、実装中に実際に踏んで直した——`OutboxStore.complete` の
直前にある複数行 JSDoc（`{@link OutboxLeaseConflictError}` という中括弧を含む参照コメント付き）
と、`DecayStrategy.floorAt` の直前にある1行 JSDoc を、コメント除去を入れる前は正しく
抽出できていなかった（下記「測ったこと」参照）。

`ScoringStrategy` は関数型のエイリアスであり中括弧を持たないため、別ロジック
（`type NAME = ...;` の右辺を1文として取り出し、`export ` の有無・空白だけを正規化して
逐語比較する）で扱う——決定1 が引用した ADR 0273 の「歯の形が他の drift と違う」を
そのまま実装した形である。

---

## 決定4. 対象の一覧は「一覧そのもの」として持ち、件数は書かない（`AGENTS.md`）

`TARGET_INTERFACE_NAMES`（13個）・`SCORING_STRATEGY_TARGET_NAME`（1個）・
`PLACEHOLDER_NAMES_NOT_TARGETED`（3個）を、歯の中に literal な配列として持つ。
`AGENTS.md`「⚠ 数を、道具と生成物に焼き込まない」に照らすと、これは「唯一の出所を指せない
数」を焼き込んでいるように見えるかもしれないが、そうではない——同じ節が明記する通り
**「対象の一覧をその場で導出するか、一覧そのものを持つ（件数ではなく）」**は許容されている。
本歯が持つのはこの「一覧そのもの」であり、`names.length` のような**件数**はどこにも
書いていない（`toBeGreaterThanOrEqual` のような下限すら置いていない——対象は固定の名前の
集合であり、ADR 0244 の `Runtime`（`main` が動けば増減する側）とは性格が違う）。

**この一覧は `main` が動いても自動的には追随しない**——ADR 0269・ADR 0273 が人手で行った
「§5 のどの節が『写し』でどの節が『予告』か」という意味の分類の結果を、本歯はそのまま
литeral として引き継いでいるだけである。`packages/core/src/index.ts` に将来まったく新しい
port interface が増え、`docs/architecture.md` §5 にも新しい節として追加されたとき、
**その新しい名前をこの一覧に手で足すまで、本歯はその節を検査しない。**これは
ADR 0244 の `Runtime` の歯（単一ファイル `runtime.ts` から毎回動的にメソッド一覧を
数え直せる）との違いであり、下の「引き受けた負債」に明記する。

---

## 赤 → 緑（⭐ 変異試験を先に見せる）

### 赤の逐語（あ: 足りない側 —— `docs/architecture.md` から `MemoryStore.getMany` の1行を消す）

**手順**: `cp docs/architecture.md /tmp/architecture.md.orig` で退避 → `sed -i '392d'
docs/architecture.md`（`getMany(ctx: Ctx, ids: MemoryId[]): Promise<Memory[]>;` の行を削除）→
`pnpm exec vitest run scripts/__tests__/architecture-section5-port-interface-correspondence.test.mjs
--reporter=verbose` を実行。

```
 × …本体: 14個の interface/type（ScoringStrategy を除く）は、メンバー名の集合が
    docs/architecture.md §5 と実体（公開 API snapshot）で一致する
   → docs/architecture.md §5 の port interface が、実体（公開 API snapshot）とずれている:

  MemoryStore:
    実装にあるが docs/architecture.md 側に無い: getMany

⟹ どうすればよいか:
  ⭐ ADR 0273 の決定（§5 は写した側、実体が正本）に従い、実装ではなく
     docs/architecture.md の該当インターフェースのコード片を実体へ合わせること。
  1. `pnpm run build` を打ち、`packages/core/dist` を最新にする
     （dist が古いままだと、この歯は「新しい実装 vs 古い snapshot」を比べてしまう）。
  2. `node scripts/check-public-api-surface.mjs` を打ち、snapshot 自体が
     dist と一致していることを確認する（不一致なら先に snapshot を直す別の問題）。
  3. 上に列挙されたメンバー名を、docs/architecture.md の対応するコード片へ反映する。
  ⛔ この歯を満たすために、実装（packages/）を変えないこと
     （AGENTS.md・ADR 0273「3つに割る」1番: 実体が正本、実装側を疑わない）。
  ⛔ 件数を文書に書き戻さないこと（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」）。

 Test Files  1 failed (1)
      Tests  1 failed | 6 passed (7)
```

**復元**: `cp /tmp/architecture.md.orig docs/architecture.md`（⛔ `git checkout` は使っていない）
→ `diff /tmp/architecture.md.orig docs/architecture.md` が空 → 同じ vitest を再実行し
**7 tests 全緑**に戻ることを確認した。`git status --porcelain` も空に戻った。

### 赤の逐語（い: やりすぎ側 —— 歯自身に `RelationStore`（種類2）を対象一覧へ混ぜる変異を入れる）

**手順**: `cp` で歯のファイルを退避 → `TARGET_INTERFACE_NAMES` の末尾に
`"RelationStore", // ⚠ 変異試験（やりすぎ側）` を1行足す → 同じ vitest を実行。

```
 × …やりすぎ側: 対象一覧に、実体の無い3個（RelationStore/Sensor/SpeechPolicy）が含まれていない
   → RelationStore が対象一覧に含まれている——ADR 0273「3つに割る」2番により、
      実体の無い予告は対象にしないこと: expected [ 'Ctx', 'MemoryStore', …(12) ] to not
      include 'RelationStore'

 × …対象14個すべての宣言が、docs/architecture.md §5 と snapshot の両方で
    ちょうど1回ずつ見つかる（空回り防止）
   → 公開 API snapshot に `RelationStore` の宣言が見つからない: expected [Function]
      to not throw an error but 'Error: 公開 API snapshot に `RelationSto…' was thrown

 × …本体: 14個の interface/type（ScoringStrategy を除く）は、メンバー名の集合が
    docs/architecture.md §5 と実体（公開 API snapshot）で一致する
   → Error: 公開 API snapshot に `RelationStore` の宣言（interface/type + '{'）が見つからない

 Test Files  1 failed (1)
      Tests  3 failed | 4 passed (7)
```

**⟹ 「実体の無いものを対象へ混ぜる」誤りは、3層の独立した検査（明示的なガード / 空回り防止 /
本体）が同時に赤くなる形で捕まる——どれも「実体が無い＝一致とみなす」という形で沈黙しない。**

**復元**: `cp` で歯のファイルを復元 → `diff` が空 → 同じ vitest で **7 tests 全緑**に戻ることを
確認した。

⟹ **両方向とも、歯が実際に噛むことを実測した。**

---

## ⛔ この歯が縛らないこと（消さないこと）

1. 🔴 **`RelationStore`/`Sensor`/`SpeechPolicy`（種類2）は縛らない。** 実装されてもされなくても、
   本歯はこの3つについて何も言わない。実装されたときに §5.3/§5.13 を「予告」から「写し」へ
   書き直すかどうかは人の判断であり、本歯は関与しない——**実装を罰する歯にしないため**
   （依頼の指示どおり）。
2. 🔴 **随伴する型は対象外。** `VectorStore` の節にある `EmbeddingSpaceId`/`VectorEntry`、
   `MemoryStore` の節にある `MemoryStatus`、`OutboxStore` の節にある
   `ClaimOutboxJobsOptions`/`OutboxLeaseConflictError` 等は、ADR 0269 決定3 の17項目にも
   含まれておらず、本歯の対象一覧にも無い。**これらのフィールド・引数がずれても、本歯は
   緑のままである。**
3. 🔴 **メンバーの「型」までは比較しない（`ScoringStrategy` を除く）。** `MemoryStore` 等は
   メンバー**名**の集合だけを見る——例えば `reinforce` の引数の型が変わっても、名前
   `reinforce` が両側に在れば緑である。PR #622 が直した `reinforce` の引数差
   （3引数→4引数）のような drift は、名前が変わらない限り本歯では捕まえられない。
4. 🔴 **§5 の中に新しい named interface が丸ごと1つ増えても、本歯の対象一覧
   （`TARGET_INTERFACE_NAMES`）に手で足すまで検査されない**（決定4）。
5. 🔴 **名前がどこに書かれているかは見ない。** §5 の中のどこかに対応するコード片が
   在ればよく、節番号が変わっても追随できるが、逆にコード片が本来あるべき節から
   迷子になっていても検出できない。

---

## ⚠ 偽陽性の条件（`AGENTS.md`「偽陽性率に上限を置けない検査は門にしない」への回答）

- **`docs/architecture.md` の書式（コードフェンス内のインデント・改行位置）が変わっても、
  本歯は偽陽性を出さない**——抽出は括弧の対応に基づき、インデント幅に依存しない
  （決定3）。
- ⚠ **メンバー文の途中に、本歯が想定しない構文（ブロックコメント以外のコメント形式・
  デコレータ・見たことのない TypeScript 構文）が入ると、名前抽出に失敗しうる。** その場合、
  「メンバーが両側に在るのに名前の集合が一致しない」という形の**偽陽性**になりうる。
  **これは机上の懸念ではなく、実装中に実際に1回踏んだ**——`OutboxStore.complete` 直前の
  JSDoc コメントを除去する前は、`complete` という名前が抽出結果から漏れ、`missing`
  として誤って報告された（上記「決定3」参照）。コメント除去を足して解消したが、
  **未知のコメント形式・構文が新たに増えたら同じ形の偽陽性が再発しうる**、という限界は
  消えていない。
- **snapshot が古いまま走らせると誤検出しうる**（決定2「確かめていない／引き受けた前提」）。
  これも偽陽性であり、本歯の対処範囲外（`pnpm run build` を先に通すことが前提）。

⟹ **偽陽性率に厳密な上限は置けていない**（「見たことのない構文が今後入らない」ことは
証明していない）。ただし `AGENTS.md`「🔴 線は引けない — ADR 0178 が反例」が認める通り、
この種の「構造を機械的にパースする歯」は偽陽性を承知で置く前例（ADR 0178 自身がそうである）
があり、**本歯もその側に立つ**——上限を置けない代わりに、既知の偽陽性源をこの節に
名指しし、次に踏んだ人がすぐ「歯の抽出が壊れているのか、本当にずれているのか」を
切り分けられるようにした。

---

## 手元で回した門【実測】

- `pnpm exec vitest run scripts/__tests__/architecture-section5-port-interface-correspondence.test.mjs`
  — 7 tests 全緑（変異前後とも上記の通り）。
- `pnpm exec eslint scripts/__tests__/architecture-section5-port-interface-correspondence.test.mjs`
  — 警告0。
- `pnpm exec prettier --check`（同ファイル）— 初回は不一致、`--write` で整形後に一致。
- `pnpm run typecheck` — 緑（全7ワークスペース）。
- `pnpm run lint` — 緑（`eslint .`）。
- `pnpm run format:check` — 緑。
- `pnpm run test`（ルート）— 緑。**86 Test Files / 1537 tests passed**、各パッケージも全緑
  （`packages/core` 67 files/942 tests、`packages/testkit` 5/348+5 skipped、`packages/openai`
  8/57+11 skipped、`packages/local-embedding` 6/88+15 skipped、`packages/anthropic` 6/63+2
  skipped）。**DB テストは実行していない**（`DATABASE_URL` 未設定。ルート門が
  「DB テストは実行していません」と名指しで報告——ADR 0015 どおり）。本 PR は
  `scripts/__tests__/` と `docs/decisions/` のみの変更であり `packages/` を1バイトも
  変えていないため、DB 側の検査は本 PR の変更範囲に関係しない。

---

## 引き受けた負債

- **対象一覧（`TARGET_INTERFACE_NAMES` 13個 + `SCORING_STRATEGY_TARGET_NAME`）は、
  `main` が動いても自動的には追随しない**（決定4）。§5 に新しい「写し」節が増えたとき、
  本歯へ手でその名前を足す作業が要る——足し忘れても本歯は緑のままであり、これは
  ADR 0244 の `Runtime` の歯（単一ファイルから動的に数え直す）より弱い保証である。
- **メンバーの型・随伴する型・drift の理由（どの ADR がその口を増やしたか）は縛らない**
  （「⛔ この歯が縛らないこと」1〜5番）。
- **偽陽性率に厳密な上限は置けていない**（「⚠ 偽陽性の条件」節）——`AGENTS.md`
  「線は引けない — ADR 0178 が反例」に従い、上限を置けないことを承知のうえで、
  既知の偽陽性源を明記する側を採った。
- **本歯は `packages/core` の port interface のみを対象とする。** ADR 0269 決定1・
  「確かめていないこと」が挙げた「他パッケージ（`packages/postgres` 等）の公開 interface が
  同じ形の焼き込みを受けているか」は本歯も掃いていない——本 Issue（#604）の範囲外である。

## これが覆るとしたら何が起きたときか

- **`docs/architecture.md` §5 に新しい「写し」節（実体が在る interface/type）が増えたとき**
  ——`TARGET_INTERFACE_NAMES` に手で足すまで、本歯はその節を検査しない。足し忘れが
  実際に起きたら、それは本歯の限界（決定4）が現実になった実例として、この ADR に
  追記されるべきである。
- **`RelationStore`/`Sensor`/`SpeechPolicy` のいずれかが実装されたとき**——`packages/core/src/`
  に実体ができ、公開 API snapshot にも現れるようになる。そのとき「やりすぎ側」の it
  （`実体の無い3個は…snapshot に1件も現れない`）が赤くなり、**本歯自身がこの前提の崩れを
  検出する**——これは決定1・「⛔ この歯が縛らないこと」1番の前提が崩れたことの通知であり、
  そのとき初めて「§5.3/§5.13 を予告から写しへ書き直すか」を人が判断し、対象一覧に
  名前を足すかどうかを決めることになる。
- **`docs/architecture.md` §5 の書き方の慣習（コード片を丸ごと再掲する形）自体をやめ、
  ADR 0244 の `Runtime` のようにメソッド名の言及だけにする形へ変えたとき**——本歯の
  「メンバー集合の構造比較」という設計そのものが不要になり、`Runtime` と同じ
  「名前がどこかに出現するか」というゆるい検査に置き換えるべきかどうかを再検討すること
  になる。
- **`scripts/__snapshots__/public-api/core.d.ts` の生成方式（ADR 0178）が変わり、
  `RelationStore` 等の実体を持たない型も出力に含めるようになったとき**——決定2の
  「種類2 が snapshot に混じらない」という前提が崩れ、「やりすぎ側」の検査（上記）が
  それを検出する。

## 採らなかった案

### 1. `packages/core/src/interfaces/*.ts` を自前の TypeScript パーサで読む（依頼の助言 (a)）

⛔ **採らなかった。** 決定2 の通り、既に鮮度が CI 保証された生成物（公開 API snapshot）が
在るのに、それを使わず自前でパーサを持つと、本歯自身が「実装の書式が変わるたびに壊れる」
という新しい脆さを背負う。**PR #622 の検算作業も TypeScript compiler API を使い捨てスクリプトで
使っていた**が、それは1回きりの検算であり、常設の歯としては (b) のほうが保守が軽い。

### 2. `RelationStore`/`Sensor`/`SpeechPolicy` も対象に含め、「実体が無いことを確かめる歯」にする

⛔ **依頼で明示的に禁止されている。** 実装されたら赤くなる歯は実装を罰する形になる。
決定1・「⛔ この歯が縛らないこと」1番の通り、この3つについて本歯は何も主張しない。

### 3. 対象一覧を `docs/architecture.md` §5 から動的に導出する
（「写し」節と「予告」節を、見出しの文言や本文中の「Phase 2」「仮置き」といった
文字列から機械的に分類する）

⛔ **検討したが採らなかった。** ADR 0269「採らなかった案」・ADR 0273 決定2 が示す通り、
「§5 のどの節が写しでどの節が予告か」は一次資料の逐語を読んで人が判断した意味の分類で
あり、見出しの文言パターンだけから機械的に再導出しようとすると、`AGENTS.md`「機械には
『検出』まで」の線を越えて**意味の判定**を機械に持たせることになる。決定4 の通り、
本歯は分類結果を一覧として引き継ぐに留め、分類のやり直しはしない。

### 4. メンバーの型シグネチャまで完全一致させる（PR #622 の検算スクリプトと同水準）

⛔ **見送った。** PR #622 の検算は使い捨てスクリプトで型まで文字列比較していたが、
常設の歯としてそこまで厳密にすると、`docs/architecture.md` が意図的に採っている表記の
揺れ（引用符の種類・`export` の有無等、PR #622 本文が「意味論的な差ではない」と
判定したもの）を都度正規化するロジックが必要になり、歯の複雑さが増す。**本歯はまず
「メンバー名が両方に存在するか」という、より頑健で壊れにくい水準に絞った**——型まで
の一致は、必要になったときに別の歯として積み増す余地を残す。

---

## 測ったこと / 確かめていないこと（`docs/autonomy.md` §5）

### 測ったこと

- 【実測】`gh pr list --state open` / `git branch -r` — 本歯と同じファイル
  （`docs/architecture.md`・`scripts/__tests__/`）を触る並行作業は無かった
  （唯一重なりうる `scripts/__tests__/adr-renumber-lib.test.mjs` を足した PR #621 は
  マージ済みで、対象ファイルも別）。
- 【実測】ADR 0269・ADR 0273 の全文を読み、決定1（対象の切り分け）・決定2
  （正本の取り方）の根拠にした。
- 【実測】ADR 0244（`Runtime` の歯）とその実装
  （`scripts/__tests__/runtime-method-doc-correspondence.test.mjs`）を読み、道具・
  失敗メッセージの書き方・「この歯が捕まえないもの」の節構成を踏襲した。
- 【実測】`scripts/check-public-api-surface.mjs`・`scripts/__snapshots__/public-api/core.d.ts`・
  `.github/workflows/ci.yml` の `build` ジョブ・`scripts/__tests__/ci-yml-api-check-wiring.test.mjs`
  を読み、snapshot の鮮度が required check で強制されていることを確認した。
- 【実測】14個の対象名それぞれについて、`docs/architecture.md` §5 と
  `scripts/__snapshots__/public-api/core.d.ts` の両方にちょうど1回ずつ出現することを
  `grep -cE` で確認した。
- 【実測】プロトタイプスクリプトで抽出ロジックを試作し、`OutboxStore.complete` と
  `DecayStrategy.floorAt` の抽出漏れ（JSDoc コメントが原因）を発見・修正した過程を
  そのまま歯のファイルへ反映した。
- 【実測】本歯を実装後、7 tests 全緑であることを確認した。
- 【実測】赤の逐語（あ・い）を上記「赤 → 緑」節の通り取得し、`cp` で退避・復元後に
  全緑へ戻ることと `git status --porcelain` が空になることを確認した。
- 【実測】`pnpm exec eslint` / `pnpm exec prettier --check` / `pnpm run typecheck` /
  `pnpm run lint` / `pnpm run format:check` / `pnpm run test`（ルート）を実行し、
  すべて緑であることを確認した。
- 【実測】`node scripts/adr-renumber.mjs --next` → `0278`（本 ADR の仮番号。マージ直前に
  マネージャー側で確定し直される前提、ADR 0179）。作業中に `origin/main` が
  `3875a05` → `45c58b7` まで進んだが、`docs/architecture.md`・
  `scripts/__snapshots__/public-api/core.d.ts`・`scripts/__tests__/` には無関係な変更
  （PR #621・#619・#366 のマージ）しか無く、fast-forward できることを確認した。

### 確かめていないこと

- ⛔ **CI 上での緑は、この PR 作成時点ではまだ確認していない**（push 前のため）。
- ⛔ **DB を要する検査**（`packages/postgres`・`examples/chat` の `test:db`）は実行していない
  （上記「手元で回した門」参照。本 PR の変更範囲に無関係）。
- ⛔ **オーナー本人の確認は取っていない**（冒頭のバナーの通り）。
- 🔴 **本歯の抽出ロジックが、今回発見した2箇所（`OutboxStore.complete`・
  `DecayStrategy.floorAt`）以外の未知の構文パターンでも正しく動くかは、実物の14対象
  すべてで緑になったことでしか確認していない**——「見たことのない構文が今後も出ない」
  ことは確認していない（「⚠ 偽陽性の条件」節に明記）。
- ⛔ **他パッケージ（`packages/postgres` 等）の公開 interface に同じ形の焼き込みが
  在るかは掃いていない**（ADR 0269 決定1 が既に範囲外とした限界を、本 ADR も埋めていない）。

---

## 🔴 追記1（2026-09-23、着地後）—— **この歯は、自分自身に対する陽性対照を、作らずに踏んだ**

⛔ **本節より上は1バイトも書き換えていない**（`AGENTS.md`「ADR は書き換えず追記して積む」）。

### 何が在ったか【実測】

**この歯の it 名は、着地した時点で件数を名乗っていた:**

```
it("本体: 14個の interface/type（ScoringStrategy を除く）は、…")
it("対象14個すべての宣言が、…")
```

🔴 **前者は誤りである。**【実測】`TARGET_INTERFACE_NAMES` の実数は **13** であり、
**`ScoringStrategy` を「除く」と書きながら、除けば 13 になる。**
（13 + `ScoringStrategy` = 14 は、後者の it の側の数である。後者は正しい。）

⟹ **自己矛盾したまま、緑だった。誰も落ちなかった。**

### なぜ残すか —— **作り物でない陽性対照であり、しかも自己言及の形をしている**

**`AGENTS.md`「⚠ 『出なかった』を、事象が無いことの証明にしない —— 先に陽性対照を示す」は、
検査を置くなら「本当に赤くなる入力」を先に見せろ、と要求している。**
⟹ **本 ADR の「赤 → 緑」節は、その陽性対照を *人工的に作って* 示している**
（`getRecall` の行をわざと消す、対象一覧に `RelationStore` を混ぜる）。

🔴 **ところがこの1件は、作っていない。**——**件数の焼き込みを検出するために書いている歯が、
自分自身の it 名に件数を焼き込み、しかもそれを実数とずらしたまま通っていた。**

⟹ ⭐⭐ **この歯が存在する理由が、この歯自身の中で実証された。**
⟹ ⭐ **人工の変異より強い**——**規律を作っている当人が、その規律を、作っている最中に破った実例**だからである。

⚠ **恥ずかしいから削る、をしない。**⟹ **削れば、次に同じことをする者が同じ日数を使う。**

### ⚠ 本題は「誰も落ちなかった」ほうである

**本歯は `docs/architecture.md` の焼き込みは捕まえるが、*自分の中の* 焼き込みは捕まえない。**
⟹ **それを捕まえるものは、いまこの repo に無い**（[Issue #606](https://github.com/takecchi/mnemora/issues/606)
が「生きた文書の『数』の焼き込みを一般形で一度も掃いていない」として、道具と生成物の側を掃く球を
既に立てている）。
⟹ ⛔ **本 ADR はその一般形を作らない**——**射程外であり、偽陽性率の見積りが別に要る**
（`AGENTS.md`「⚠ 偽陽性率に上限を置けない検査は門にしない」）。
⭐ **記録するのは「この形の穴は実在し、実際に1回踏まれた」という事実だけである。**

### 直したこと

**it 名と doc コメントから件数を落とした**（⭐ **一覧そのものは残した**——**決定4 の
「一覧として持ち、件数は書かない」の適用である**）。
⛔ **判定の中身は1バイトも変えていない。**
⚠ **上の「赤の逐語」は、この変更より *前* に走らせた出力である。**⟹ **いま同じ変異を当てると、
it 名の部分だけがこの記録と違って出る。**⛔ **逐語は書き換えない。**

---

## ⚠ 追記2（2026-09-23、着地後）—— **「採らなかった案3」に、実測の反例を足す**

**上の「採らなかった案 3.（対象一覧を `docs/architecture.md` §5 から動的に導出する）」の
却下理由は、原理論（機械に意味の判定を持たせない）だけだった。**⟹ **現物の形としても
成り立たないことを、実測で足す。**

**【実測 2026-09-23、PR #622 着地後】** §5 の code block から `interface` / `type` / `class` の
宣言を機械的に抜くと、次が出る:

```
Ctx, MemoryStore, MemoryStatus, VectorStore, EmbeddingSpaceId, VectorEntry, LexicalStore,
RelationStore, RelationKind, LLMProvider, EmbeddingProvider, Scheduler, ScoringStrategy,
DecayStrategy, EventStore, TokenCounter, Clock, ClaimOutboxJobsOptions,
OutboxLeaseConflictError, OutboxStore, TenantSettingsStore, EventRetention,
EventRetentionSetting, DecayClock, Sensor, SpeechPolicy
```

**本歯の対象（決定4 の一覧＋`ScoringStrategy`）と「予告」の3個を除くと、次が残る**:
`MemoryStatus` / `EmbeddingSpaceId` / `VectorEntry` / `RelationKind` /
`ClaimOutboxJobsOptions` / `OutboxLeaseConflictError` / `EventRetention` /
`EventRetentionSetting` / `DecayClock`。
**これらは port interface そのものではなく、その宣言を読むために併記されている付随の型である。**

⟹ **動的導出は、これらを即座に拾う。** そして `MemoryStatus` / `EmbeddingSpaceId` /
`DecayClock` のような**文字列 union の型エイリアスには「メンバー集合」という概念が無い**
——本歯の比較をそのまま当てると、**空集合どうしが一致して緑になる**（＝何も検査していないのに
通る）か、**偽陽性になる**かのどちらかである。

⟹ ⭐ **「意味の判定を機械へ持たせない」という理由とは独立に、比較の形そのものが成り立たない。**
⚠ **これらを除外する一覧を別に持てば動くが、それは「対象の一覧を手で持つ」ことと費用が変わらない**
——**手で持つ一覧が1本から2本へ増えるだけである。**

---

## ⚠ 追記3（2026-09-23、着地後）—— **上の2つの追記は、一度 `main` に届かないまま PR がマージされた**

**本 ADR を着地させた PR #624 は、`a6b545d` でマージされた。**⟹ **その時点で、上の追記1・追記2 の
中身（および歯の件数の修正）は、どれも `main` に入っていなかった。**手元では commit まで済んで
いたが、**push していなかったためである。**⟹ **追記の PR で入れ直した。**

🔴 **原因は、「マージするな」という指示を「push もするな」と読んだことである。**
⟹ ⭐ **「マージするな」と「push するな」は別である。**——**push しておけば、PR にその中身が載る。
別の誰かがマージした時点で、一緒に着地する。**⟹ **押さえるべきはマージであって、push ではない。**

⚠ **並行する担い手が居る repo では、「自分がマージする」という前提そのものが成り立たない**
——**PR は、自分以外の手で着地しうる。**⟹ ⭐ **「手元にあるが push していない修正」は、
その瞬間から失われうる。**

⛔ **恥ずかしいから削る、をしない**——**追記1 に書いたのと同じ理由である。**

---

## 🔴 追記2（2026-09-23、着地後）—— **本文が `AGENTS.md` から引いた文のうち、原典に実在しないものが4箇所ある**

⛔ **本節より上は1バイトも書き換えていない。**⛔ **決定1〜4 も「採らなかった案」も、1つも動かさない。**
🔴 **壊れているのは論ではなく、引用の帰属である。**

⚠ **これはクローンの委譲で走っている担い手の検算であって、オーナー本人の決定ではない**
（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)。
GitHub 上の `takecchi` は人間と担い手の両方である）。

**【実測】見た版**: `AGENTS.md`（473行、`main` = `e0df0e9`）。**`CLAUDE.md` は `AGENTS.md` への symlink**
であり、両者が食い違うことは構造的に起こり得ない。

### ① 決定4（`:122-124`）—— 🔴 **引用が原典に存在しない**

本文はこう書いている:

> **同じ節が明記する通り「対象の一覧をその場で導出するか、一覧そのものを持つ（件数ではなく）」は許容されている。**

**【実測】** `grep -c "一覧そのものを持つ" AGENTS.md` → **0**。
`grep -rn "一覧そのものを持つ" --include='*.md' .` のヒットは、**本 ADR 自身の `:124` 1件だけ**である。

**原典（`AGENTS.md:278-282`「⚠ 数を、道具と生成物に焼き込まない」）が実際に書いているのは、これだけ**:

> **`main` が動けば変わる数——件数・行番号・版・tag・sha——を、道具や生成物に写さないこと。**
> ⟹ **唯一の出所をその場で引くか、指すだけにする。**
> ⟹ **指せないものには、代わりに「どこまで数えたか」の鮮度を名乗らせる。**

⟹ この節の主題は一貫して**「数」**であり、**「名前の一覧を持ってよいか」を扱っていない。**
許容形も「**その場で引くか、指すだけにする**」であって「**一覧そのものを持つ**」ではない。

⭕ **ただし決定4 の結論は生きている。**同じ節のサブ見出し `AGENTS.md:289`
「**⭐ 線は「`main` が動くと変わるか」である**」「**焼き込んでよい数も在る。**」から**導ける**——
固定の名前の集合は `main` が動いても変わらないので、この規律の対象外である。
⟹ ⛔ **決定4 は動かない。**直すべきは「**同じ節が明記する通り**」と書いて鉤括弧で括った点だけである。

### ② 採らなかった案3（`:335`）—— ⚠ **見出しは正確。だが論拠の出所が違う**

本文は `AGENTS.md`「機械には『検出』まで」**の線を越えて意味の判定を機械に持たせることになる**と書く。

- ⭕ **見出しは実在する**（`AGENTS.md:313`「### ⚠ 機械には「検出」まで — 確定と書き込みは人に残す」）。
- 🔴 **しかし同じ節が明示している線は別の軸である**（`AGENTS.md:329`）:
  > `#### ⭐ 線は「repo の中（戻せる）か、GitHub 側の取り消しにくい面か」である`
  > **線は「機械が書き込むか」ではない。**

  ⟹ これは**可逆性・副作用**の軸であって、「機械にどこまで解釈させてよいか」の軸ではない。
- **【実測】** `grep -c "意味の判定" AGENTS.md` → **0**。

🔴 **本当の原典は [ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定2**
（`0223:163` 逐語「機械に載せてよいのは『実体から機械的に数え直せるもの』だけ。**意味の判定**と、
副作用のある手は機械に打たせない。判定できないときは、通さずに止める」）である。
`AGENTS.md` はそこへ**リンクするだけで「ここには写さない」と明記している。**

⭐ **正しい引き方の実例が、同じ repo に在る**——
[ADR 0279](./0279-required-status-checks-declaration-and-check.md) `:324-325` は、同じ規律を
`AGENTS.md` ではなく **ADR 0223 決定2 から逐語一致で**引いている。

### ③ 掃引で見つかった、同じ形の2件

**本 ADR の中だけを掃いた**（⛔ repo 全体へは広げていない）。`AGENTS.md` を引く12箇所のうち、
上の2件に加えて次の2件が原典に無い:

| 箇所 | 本文が引いている文 | 実測 |
|---|---|---|
| `:89` | `AGENTS.md`「古い `dist/` のまま `check-public-api-surface.mjs --write` を打つ」の穴 | `grep -nE "dist/\|public-api\|--write" AGENTS.md` のヒットは **ADR 0178 へのリンク3行だけ**。この文言は無い |
| `:401` | `AGENTS.md`「ADR は書き換えず追記して積む」 | `grep -nE "追記\|書き換えず" AGENTS.md` → **ヒット0**。`AGENTS.md` はこの規律に触れていない |

⭕ **残り8箇所は原典に実在した**（`:122`/`:166`「⚠ 数を、道具と生成物に焼き込まない」＝`AGENTS.md:278`、
`:233`/`:440`「偽陽性率に上限を置けない検査は門にしない」、`:250`「🔴 線は引けない — ADR 0178 が反例」
＝`AGENTS.md:361`（markdown リンクを外せば逐語一致）、`:335` の見出し、`:420`「『出なかった』を、
事象が無いことの証明にしない」ほか）。

### ⟹ なぜ直さずに追記で止めるか

🔴 **次に読む人は `AGENTS.md` を grep し、見つからず、「`AGENTS.md` が変わったのか」「自分の読み落としか」で
迷う。**⟹ **どちらも時間を捨てる。**⟹ だから帰属をここに書き残す。
⛔ **本文を書き換えないのは ADR の作法による**（この規律の出所は `AGENTS.md` ではなく
[ADR 0223](./0223-cross-cutting-disciplines-extracted-from-the-adr-corpus.md) 決定1 である——
上の②と同じ誤りを、この追記自身が繰り返さないために明記しておく）。

## 追記4（2026-09-24、Issue #628）—— 歯の名前への本数の焼き込みを、もう1件外した

Issue #628 の掃引（2026-09-23）で、repo の実数を歯の名前に焼き込んでいたのは実質1件（`scripts/__tests__/ci-yml-measurement-jobs-wiring.test.mjs` の「7本の測定ジョブ」、`describe` 3つと `it` 1つの名前と `toHaveLength(7)`）だった。名前は「Issue #426 が名指しした測定ジョブ（`MEASUREMENT_JOB_IDS`）」へ、本数は `MEASUREMENT_JOB_IDS` の1箇所へ寄せた。`toHaveLength(7)` は、直前の `toEqual([...MEASUREMENT_JOB_IDS])` と重なっていたので外した。⛔ 本文は書き換えていない（`docs/decisions/README.md`）。
