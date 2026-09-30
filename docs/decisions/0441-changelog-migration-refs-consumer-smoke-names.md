# ADR 0441: CHANGELOG と migration-v1 の参照の食い違いを直す・postgres の例外は `name` だけと訂正する・README に ES2022 を書く・consumer-install の実行検査に値の名前を足す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローンの委譲先（担い手。マネージャーの指示による）が書いた。決めたのはクローン miku で、オーナーの判断ではない（[ADR 0220](./0220-issue-comment-decisions-are-not-owner-decisions.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は上の2者の判断。

- **文脈**:

  リリース前の点検で見つかった、互いに独立な5件の小さな食い違い。いずれも利用者の書くコードを変えない（文書の訂正と、リリース前に人が打つ検査の強化）。

  **BE-1。** 【現物】`docs/migration-v1.md` の項目29 は、本文で「2026-10-01 に非破壊に数え直した」と書いているのに、(a) 案内の文が「CHANGELOG `[1.2.0]` 節 `### Breaking` を見ること」のまま（実際の記載は `### Added` に移してある）、(b) 置き場所が「🔴 破壊的変更（v1.1.0 → 次の版）」の節のまま、だった。

  **BE-2。** 【現物】CHANGELOG `[1.2.0]` の `### Added` の2項目で、migration-v1 の項目番号が入れ違っていた。`reinforce`/`reinforceMany?` が `memory_events` を書かないことを検査する `it` の項目が「項目38」を、`aggregateScope` の `scopeAggregate: "skip"` の項目が「項目37」を指していた。migration-v1 の現物では、項目37 が reinforce、項目38 が `aggregateScope` の `"skip"`（見出しで確かめた）。

  **BF-1。** 【現物】[ADR 0418](./0418-store-error-kind-guards.md) の 2026-09-30 の追記（「列挙」）の括弧書きは「core 以外のパッケージの例外——`AnthropicLLMProviderError` など——は…既に `kind` と判定関数を持つ」と書いた。`@mnemora/postgres` の公開の例外クラス9つについては事実と違う（`scripts/__snapshots__/public-api/postgres.d.ts` と `packages/postgres/src` で確かめた。9つとも `kind` も `is*` も無く、`name` だけ）。

  **BD-1。** 【現物】公開の `.d.ts` が `ErrorOptions`（ES2022 の lib の型）を使う。core の `memory-store`・`vector-store` の例外クラスと、postgres の `trigram-lexical-store` の `TrigramLexicalStoreUnavailableError`（`local-embedding` の `LocalEmbeddingProviderError` も同じ）。`lib`/`target` が ES2021 以下の利用者は、`skipLibCheck: false` なら `TS2304`、`skipLibCheck: true` なら `cause` の型が失われる。README のどこにも書いていなかった。

  **BD-2。** 【現物】`scripts/check-consumer-install-lib.mjs` の実行検査（`buildSmokeMjs`・`buildSmokeCjs`）は `Object.keys(mod).length === 0` しか見ていなかった。入口の再 export が1つ外れても、ほかの名前が1つでも出ていれば緑のまま通る。

- **決めたこと**:

  1. **BE-1: 案内の文を `### Added` に直し、置き場所は 🔴 の節に残す。項目は動かさない。** 見出しの直下に「非破壊に数え直した（番号の参照を崩さないため、ここに残す）」と注記した。
     - 根拠（【現物】migration-v1 の数え方の規律）: 「数え方の規律への追記（2026-09-28）」規律1は「この規律より前に数えた項目は…遡って数え直さない」「項目を一覧から外さない」形で書かれており、数え直した項目を別の節へ動かす手順を**決めていない**。項目29 自身の本文は既に「番号は、CHANGELOG と上の節の欠番の注記から指されているので残す」と書いている。項目の移動を決めた規律が無いので、注記で足りる形にした。番号は CHANGELOG・上の節の欠番の注記・ADR から指されており、動かせば参照が崩れる。
  2. **BE-2: CHANGELOG の2か所を入れ替えて直した**（reinforce の項目 → 37、`aggregateScope` の `"skip"` の項目 → 38）。出荷済みの節ではないので書き換えてよい（`[1.2.0]` は未リリース）。
  3. **BF-1(a): ADR 0418 の末尾に追記を足した。** 本文と既存の追記は書き換えていない。追記は、postgres の9クラスが `name` だけであること、揃えるかは [Issue #1184](https://github.com/takecchi/mnemora/issues/1184) の判断（v1 の中では揃えない）に従うことを書く。**9クラスのコードは変えない。**
  4. **BD-1: 3つの README（ルート・core・postgres）に「`lib`・`target` は ES2022 以上」を足した。** 各 README の既存の「インストール」「前提」の流儀に合わせた（ルートは「インストール」節の Node の一文の直後、core・postgres は「前提」の箇条書き）。理由も短く添えた。`check:doc-snippets`（コード片の型検査）の対象は ts のコードブロックで、足したのは散文だけなので触れない。
  5. **BD-2: 実行検査に「snapshot の値の名前が、全入口で実行時に undefined でないこと」を足した。**
     - **名前の出所**: `scripts/__snapshots__/public-api/*.d.ts`（公開 API の門 ADR 0178 の出力の写し）。**平らに全部の名前を集めない**——snapshot は入口から辿れる内部のファイルも連結しているので、入口が再 export していない宣言まで数えると、実行時に無いのが正しい名前で赤になる。入口のファイルから `export *`・`export { a as b } from`・`export { X }`（自分の import の再 export）を辿り、その入口から見える名前だけを集める（`collectEntryValueNames`）。TypeScript の parser だけを使う（`public-api-surface-lib.mjs` の `parseDeclarationFile` と、宣言ファイルの拡張子の対応表を再利用した。`.cjs` → `.d.cts` も同じ表で辿る）。
     - **入口ごとの対応**: 入口の指定子 → 起点の `.d.ts` は、作業ツリーの `packages/<名>/package.json` の `exports.*.types` から取る。testkit の `.`（`dist/index.d.ts`）と `./fixtures`（`dist/fixtures.d.ts`）は別々に引く（`InMemoryMemoryStore` は `./fixtures` にだけ在る）。入口の**一覧**は従来どおり `EXPECTED_ENTRY_POINTS` が独立に持つ（`exports` から導かない）。
     - **値と型の区別**（宣言の構文だけで決める）: 値は `export declare const/let/var`・`function`・`class`・`enum`（`const enum` を除く）。型は `interface`・`type`・`export type { … }`・`export { type X }`・`const enum`。
     - **限界**: (i) `const enum` は実行時に実体が無い前提で値に数えない（今の snapshot には無い）。(ii) `namespace`・`export =`・`export default`・`export import`・`export * as ns` は扱わず、**出たら例外で止まる**（黙って読み飛ばさない）。(iii) 見るのは「`undefined` でない」だけで、値の中身（引数・戻り値・クラスの形）は見ない。実行時に `undefined` が正しい `export declare const X: undefined` があれば偽陽性になる（今は無い）。(iv) snapshot は build の出力の写しで、tarball の `.d.ts` そのものではない。写しが古ければ先に `check:public-api` が赤になる。(v) 型だけの名前（interface など）が実行時に在る必要は無いので見ない。型が抜けた再 export は、従来どおり 4段目の `tsc` が見る。
     - **一覧が空なら赤**: `collectEntryValueNames` は値が1つも引けなければ例外を投げる（道具が赤になる）。生成した smoke も、`valueNames[spec]` が無い・空なら赤にする。抜き出しが壊れて何も見ていないのに緑、を作らない。
     - **歯**: `scripts/__tests__/check-consumer-install-lib.test.mjs`（CI の単体テスト）に、名前が1つ欠けた mod で赤・揃った mod で緑・一覧が空（または入口の分が無い）で赤を足した（ESM・CJS の両方で、生成した smoke を一時ディレクトリの偽のパッケージに対して実際に走らせる）。あわせて、抜き出しの単体（値・型・const enum・再 export されない宣言・扱えない形）と、実際の snapshot で全入口が空でないこと・testkit の入口の対応が正しいことを測る。
     - **`check:consumer-install` は CI に入れない。** この道具は既定の CI に無く、リリース前に人が打つ運用のまま。ジョブの名前・本数・required status check は変えていない。
     - **CI の既存ジョブ `cjs-require-smoke`（`scripts/check-cjs-require-smoke.mjs`、ADR 0387）にも同じ検査が掛かる。** このジョブは同じ `buildSmokeCjs` を使うので、`collectValueNamesForEntries` で同じ表を引いて渡した（渡さないと `valueNames` が無く、生成した smoke が全入口で落ちる——【実測】最初の push でこのジョブだけが赤になった）。registry に出ない設計（ADR 0387）は変わらない。snapshot は作業ツリーのファイルを読むだけ。ジョブの名前・本数・required は変えていない。
  6. **CHANGELOG**: `[1.2.0]` の `### Changed` に、README の前提の追記を1項目足した（npm に載る README が変わるため。publish 対象の変更だけを載せる規律 ADR 0243 に沿う）。BE-2・BF-1・BD-2 は文書・内部の道具なので載せない（「何を載せるか」の規律）。いずれも非破壊。**migration-v1 に項目は要らない**——型・実行時の振る舞い・conformance の判定のどれも変えておらず、数え方の規律（破壊的変更の定義）に当たらない。

- **陽性対照（【実測】手元で `check:consumer-install` を実際に走らせた）**:

  (i) そのままで緑（全7段 ✔、入口8個）。(ii) `packages/core/src/index.ts` から `export * from "./heuristic-token-counter.js";` を1行外して build → **赤**。ESM・CommonJS の両方の段が `@mnemora/core: 実行時に undefined の値の名前がある（1 個）: heuristicTokenCounter` で落ちた。**同じ変更で、2つの型検査の段（node16・bundler）は緑のままだった**——smoke.ts は入口を namespace で import するだけで個々の名前を使わないので、値の再 export が1つ外れても型検査は落ちない。これが今回足した検査の穴の実証でもある。(iii) 戻して緑。外した1行は戻し、commit に入れていない。

  `cjs-require-smoke`（【実測】手元で `pnpm run check:cjs-require-smoke`）: そのままで緑、同じ1行を外して build → **赤**（`@mnemora/core: 実行時に undefined の値の名前がある（1 個）: heuristicTokenCounter`）、戻して build → 緑。

- **採らなかった案**:

  - **BF-1(b): postgres の9クラスに `kind` と `is*` を足して揃える。** 採らない。#1184 の線（v1 の中では揃えない）に従う。足せば公開の値が増え、値は公開 API になる（ADR 0418 の作法）。本 ADR は事実の訂正だけを行う。
  - **BE-1: 項目29 を 🟡 の節（後方互換だが挙動が変わりうるもの）か「非破壊と数えたもの」の一覧へ動かす。** 採らない。番号を他から指されており、規律も動かす手順を決めていない。
  - **BD-1: `ErrorOptions` を自前の型に置き換えて ES2021 以下でも通るようにする。** 採らない。`cause` を標準の形で受けるのが目的で、置き換えると利用者の `Error` との互換が崩れる。ES2022 を前提として README に書くだけにした。
  - **BD-2: snapshot の全名前を平らに集める。** 採らない（上。偽陽性になる）。**`tsc` の型検査器で実際の解決をさせる。** 採らない——tarball を入れた後の `tsc` は型の側を既に見ており、値の名前は宣言の構文で足りる。

- **引き受けた負債**:

  - `@mnemora/local-embedding` の `LocalEmbeddingProviderError`（`ErrorOptions` を使う）の README には、ES2022 の一文を足していない（本 PR が指示された3つの README だけに足した）。`packages/local-embedding/README.md` にも同じ一文が要る。
  - 値の名前の検査は「`undefined` でない」だけを見る。値の形の変化は見ない（公開 API の門が型の側で見る）。
  - `const enum` や namespace が公開面に入ったら、この抽出の対応表を直す必要がある（扱えない形は例外で赤になるので、気づけはする）。
  - この道具はリリース前に人が打つ運用のまま。registry に依存し（約 550MB）、既定の CI では走らない。
