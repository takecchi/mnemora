# ADR 0550: 文書とコードのずれを横に掃く（第7弾）— ADR 0515・0516 からの分の文書を、今の main の実装に照らす

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-03

クローン miku の指示で、マネージャー mgr-b9b6a409 とその委譲先（担い手）が書いた。

**照合の基準は main `8c2519ca`。** ADR 0545（#1653）の続きで、0545 を締めたあとに main へ入った 0515（#1648、`575042a2`）と 0516（#1649、`8c2519ca`）から掃く。**このあとマージされるものは、マージされた順に追い足す。**1時間ほどマージが入らなかったら、そこまでで締める。

出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

決まり（前回と同じ）: CHANGELOG の `[1.2.0]` と migration-v1 の v1.2.0 の節には触らない。既存の ADR 本文は対象外。コードの振る舞いは変えない。ずれがあれば文書をコードに合わせ、コードの側が約束を破っていそうなら直さずに材料として残す。

## 0515（`575042a2`、差は `git diff 0cfe277c 575042a2`）

- **文脈**: 0515 は、ADR 0503 の負債2つを返す。(1) `resolveContestedPair` が、対の外の `forgotten` な記憶を指す `supersededById` を断る（群版は 0503 から断っていた）。(2) `updateStatus`・`updateStatusWithEvent` が、`superseded` 以外の status（`active`・`archived`・`forgotten`）に付けた `supersededById` を断る。どちらも書く前に素の `RangeError`。
- **差の中身**【現物】: コードは `packages/postgres/src/memory-store.ts`（`forbidWhenNotSuperseded` を2か所 `false` → `true`、`resolveContestedPair` のトランザクション内に `SELECT 1 … status = 'forgotten'` の先取りを追加）と `packages/testkit/src/__fixtures__/in-memory-memory-store.ts`（同じ2か所と、`rawGet(...)?.status === "forgotten"` の判定）。TSDoc は `packages/core/src/interfaces/memory-store.ts` の `updateStatus`・`updateStatusWithEvent`・`resolveContestedPair` に各1か所。文書は CHANGELOG `[1.3.0]` の Breaking に1項目、migration-v1 の項目61（🔴「v1.2.0 → 次の版」）。歯は Postgres の `store-superseded-by-checks.postgres.test.ts`（InMemory と Postgres に同じ入力）と testkit の `in-memory-superseded-by-checks.test.ts`。
- **3実装**【現物】:
  - Postgres: `assertSupersededByShape` の呼び出しは5か所（`updateStatus`・`updateStatusWithEvent`・`resolveContestedPair` の first/second・`resolveContestedGroup`）で、`forbidWhenNotSuperseded` は全部 `true` になった。message は `<口>: opts.supersededById must not be set unless status is "superseded"`（TSDoc・CHANGELOG と一字一致）。位置は `contested` の検査のあと、存在確認・テナント照合・CAS より前（TSDoc の「同じ位置」と一致）。`resolveContestedPair` の先取りは、両側が `contested` と確かめたあと（CAS のあと）・書く前で、`ref === first.id || ref === second.id` は読み飛ばす。SELECT に `tenant_id` が入っているので、別テナントの id は当たらず、UPDATE の切り分け（ADR 0439）の「memory not found」に落ちる。TSDoc の「テナントの照合のあと」は結果として成り立つ。
  - testkit の InMemory: 上と同じ2か所の `true` と、`assertOwnMemoryRef`（ADR 0439）のあと・書く前の判定。message は Postgres と同じ。
  - core の Fake（`runtime-fakes.ts`）: **0515 の約束と食い違う**。`updateStatus`（1335 行目付近）・`updateStatusWithEvent`（1374 行目付近）・`resolveContestedPair`（2509 行目付近）に `assertSupersededByShape` 相当は無く、`supersededById` を渡されれば `assertOwnMemoryRef` のあとそのまま書く。ADR 0503 の `superseded` に `supersededById` が無い・自己置換・循環の断りも、Fake にはまだ無い。ADR 0515 の「引き受けた負債」・CHANGELOG の【確かめていないこと】が自分で書いているとおり（PR #1643 が触っているため）で、新しい発見ではない。読んだだけで、Fake に対して走らせてはいない【判断】。
- **突き合わせの結果**【現物】:
  - TSDoc 3か所の新しい文は、実装と一致した。ただし周りの既存の文が2か所、0515 のあとで読みにくくなっていた。(a) `updateStatus` の「`superseded` 以外の status は、`supersededById` が無くてよい」（ADR 0503 の文。付けてよいとも読める）。(b) `resolveContestedPair` の「対の外の記憶を指す `superseded` は断らない」（直後の (5) が `forgotten` を断る）。
  - CHANGELOG `[1.3.0]` の項（2口の message、`COALESCE` で `superseded_by_id` が残っていたこと、`Runtime` 経由は変わらない、対の相手・対の外の `active`・`archived` は断らない）は、実装と ADR と一致した。`Runtime` の `updateStatusWithEvent` の呼び出し4か所（`runtime.ts` の 5628・6601・6911・8563 行目付近）のうち `supersededById` を渡すのは `superseded` を書く2か所、という文は、`grep` で呼び出しが4か所であることまで確かめた（渡す引数の中身は ADR 0515 の記述を信じた【未確認】）。
  - CHANGELOG の 0503 の項（79〜84 行目）は ADR 0503 の時点の記述で、「断らないもの」に「`superseded` 以外の status（`supersededById` 無し）」と書いてあるのは今も成り立つ（無しなら通る）。触っていない。
  - migration-v1 の項目61: 「(a) `resolveContestedPair` で、書く時点で既に `forgotten` な記憶を置き換えた側に指している」「(b) `updateStatus*` で `active`・`archived`・`forgotten` に付けている」「`superseded_by_id` を外したいなら `restoreSuperseded`」は、実装と一致した（`restoreSuperseded` は `restoreSupersededBy` の別の口で `NULL` へ戻す。interface の TSDoc の「`NULL` へ戻す経路が無い」は `updateStatus*` の話で、矛盾しない）。項目59（0503）は `updateStatus*` の `superseded` 以外を断るとは書いていない。
  - 適合スイート `packages/testkit/src/memory-store-conformance.ts`: `updateStatus*` に `supersededById` を渡す呼び出し（4422・4491・4511・4578・4624・4653・4690・4722・4752 行目付近）は全部 `"superseded"` で、`resolveContestedPair` の下ごしらえ（8121 行目付近）も `superseded` のときだけ渡す。0515 の断りで赤になる項目は無い。断りの歯はスイートに無く、第三者の adapter は検査されない（ADR 0434 決定5。CHANGELOG の「第三者の adapter は断りを持たない」と一致）。
  - `docs/memory-model.md` 427 行目の ADR 0503 の追記（`supersededById` の約束を壊す入力を列挙する）: 0515 の2つが列挙に無かった。**古くなっていた**。
  - ルートと各パッケージの README、`docs/architecture.md`（`updateStatus` の型だけ）、`docs/conformance.md`: `supersededById` を断る・断らないと述べた所は無い（grep）。`[1.2.0]` と migration-v1 の v1.2.0 の節には触っていない。公開 API の snapshot は TSDoc を含まず、型は変わっていない。
- **直したもの**:
  - `docs/memory-model.md`（ADR 0503 の追記の直後）に、「ADR 0515 から、`resolveContestedPair` の対の外の `forgotten`、`updateStatus*` の `superseded` 以外への `supersededById` も断る（上の列挙は ADR 0503 の時点）」の1段落を足した。
  - `packages/core/src/interfaces/memory-store.ts` の TSDoc を2語句だけ直した。(a) 「`supersededById` が無くてよい」→「無いこと（付けると断る。次の ADR 0515）」。(b) 「対の外の記憶を指す `superseded` は断らない」→「対の外の（`forgotten` でない）記憶を指す…（`forgotten` は下の (5)）」。型・実装は変えていない。
- **コードの側を直すべき食い違い（材料）**【判断】: core の Fake（`packages/core/src/__tests__/runtime-fakes.ts`）が、(1) `superseded` 以外の status への `supersededById`、(2) `resolveContestedPair` の対の外の `forgotten`、(3) ADR 0503 の `superseded` の形の検査（無い・自己置換・循環）を断らない。Postgres・InMemory と同じ入力を流すと挙動が割れる。直すなら、InMemory の `assertSupersededByShape`・`assertNoSupersededCycle` と同じ検査を足す。直す前に、Fake を使う core の歯が、これらの入力に依っていないか見る必要がある。ここでは直さない。
  - 別の PR で直す（担当はクローンが配る）。
- **【未確認】**: 歯 `store-superseded-by-checks.postgres.test.ts`（DB が要る）・`in-memory-superseded-by-checks.test.ts` と、ADR 0515 の変異試験を走らせていない。ADR 0515 の負債（`updateStatus*` は `superseded` のとき `forgotten` な記憶を指す `supersededById` を断らない、検査のあとに指す先が `forgotten` になる並行は Postgres で断れない）は、そのまま残る。Fake の振る舞いを実際に呼んでいない（読んだだけ）。
