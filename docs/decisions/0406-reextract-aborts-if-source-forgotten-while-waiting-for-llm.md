# ADR 0406: `reextract` は、LLM を待つ間に元の記憶が forget されたら、何も書かずに打ち切る

- **状態**: 採用 (2026-09)

- **文脈**:

  [Issue #1226](https://github.com/takecchi/mnemora/issues/1226)（[ADR 0375](./0375-purge-scope-widened.md)
  決定7）は、`consolidate`・`reflect` が LLM を待つ間に、元の記憶が `forget`（さらに `purge`）される
  と、消したはずの本文から作った記憶が `active` で書かれる、という穴を塞いだ。直し方は2段——
  (1) LLM が返った直後に元の記憶を `getMany` で読み直し、1件でも `forgotten` なら書かずに打ち切る
  （`abortIfForgotten` を実装しない adapter でも効く）、(2) 書き込み自身に
  `opts.abortIfForgotten` を渡し、実装する adapter（`@mnemora/postgres`）は書き込みと同一
  トランザクションの `SELECT … FOR UPDATE` でもう一度見直す。

  **`Runtime.reextract` は同じ穴を残していた。** `reextract` は LLM を呼ぶ前に「退けた記憶」
  （#1079・#1149・ADR 0380）を確かめるが、LLM を待つ間に `forget` された分は見ていない。
  さらに supersede 対象（`existingBefore`）は LLM の**後**に読むため、待つ間に forget された記憶は
  `active` でなくなって対象から消え、言い換えが何にも当たらず新しい `active` として書かれる。
  実測（Postgres）: `forget` は `forgotten` を返し、LLM が返った後に新しい記憶が `active` で書かれ、
  イベントは `created` → `forgotten` → `created` と積まれた。書き込みの2経路——
  `supersedeWithNewMemories` を呼ぶ経路と、口が無い adapter 向けの `createMemoryWithOutbox`
  ループ——のどちらにも `abortIfForgotten` が渡っていなかった。

- **決めたこと**:

  1. **見直しの対象 id は、LLM を呼ぶ前に読んだ、その Observation から出た全ての記憶**
     （`listBySourceObservationAllVersions` の結果。`extractorVersion`・`status` を問わない）。
     `consolidate`/`reflect` が「LLM に渡した eligible」を見直すのと同じ規則——**LLM の入力に
     関わった（あるいは、これから supersede・上書きする根拠になる）記憶**である。既に読んでいる
     一覧なので、追加の問い合わせは増やさない（`listWithdrawnBySourceObservation` を
     一覧を受け取る形に改めた）。supersede される対象に限らないのは、待つ間に forget された記憶が
     もう supersede 対象ではなくなっている（上の文脈）ため。

  2. **LLM が返った直後・書く前に、上の id を `getMany` で読み直す。** 1件でも `forgotten`
     （`purge` 済みを含む）なら、何も書かずに打ち切る。

  3. **書き込み2箇所（`supersedeWithNewMemories`・`createMemoryWithOutbox`）に
     `opts.abortIfForgotten: <上の id>` を渡す。** `SourceMemoryForgottenError` を捕まえ、同じ打ち切りの
     戻り値にする。`abortIfForgotten` を実装しない adapter（testkit の `InMemoryMemoryStore`・core の
     fake）では無視され、2 の読み直しだけが保護になる（`consolidate`/`reflect` と同じ）。

  4. **打ち切ったときの戻り値は、既存の語彙をそのまま使う——公開の型を増やさない。**
     「退けた記憶を持つ Observation」の早期 return（#1079）と同じ形:
     `memoryIds: []`・`supersededMemoryIds: []`・`extraction: "skipped"`・
     `atomicity: "not_attempted"`・`extractionFailure: null`・`skipped` に forgotten だった記憶ごとの
     `status_not_active`（`status: "forgotten"`）。`consolidate`/`reflect` は `outcome:
     'aborted_source_forgotten'` を足したが、`ReextractResult` には `outcome` 欄が無く、
     足すと公開型の変更になる（`ReextractResult` の doc が既に「`not_found` 相当の outcome を足す案」を
     同じ理由で採らなかった）。#1079 と同じ形なら、呼び出し側は今の分岐（`skipped` に
     `status_not_active` が在る）のまま、「LLM を呼ぶ前に打ち切った」場合と区別なく扱える。
     **例外は投げない**（`SourceMemoryForgottenError` は runtime が握る）。

  5. **口が無い adapter のループで、2件目以降で打ち切られたとき**（1件目はコミット済み）は、
     書いた分の `memoryIds` を隠さずに返し、`atomicity: "store_unsupported"`・`extraction: "ok"`、
     supersede には進まない。（実測していない。下の「確かめていないこと」。）

- **検討した代替案**:

  1. **`ReextractResult` に `outcome: 'aborted_source_forgotten'` を足す案。** ⛔ 採らなかった——
     公開の型の変更になり、exhaustive な分岐を持つ第三者を壊しうる。既存の `skipped`＋
     `status_not_active` で意味が足りる（呼び出し側が知りたいのは「forgotten の記憶が理由で
     書かなかった」ことで、それは `status_not_active` が既に言う）。
  2. **`SourceMemoryForgottenError` を呼び出し側へ投げる案。** ⛔ 採らなかった——`reextract` の既存の
     打ち切り（#1079）は投げない。投げる種類が変わる変更になる。
  3. **対象を supersede 対象（`toSupersede`）だけにする案。** ⛔ 採らなかった——待つ間に forget
     された記憶は、LLM の後に読む `existingBefore` から既に消えており、見直しの対象にならない。
     穴そのものが塞がらない（歯の1本目がこの形）。
  4. **LLM を呼ぶ前後で「退けた記憶」の判定を丸ごとやり直す案**（`contested` の追加も拾う）。
     ⛔ 採らなかった——今回の穴は `forget` であり、`abortIfForgotten`（`forgotten` だけを見る）と
     範囲が揃わない。範囲を広げるかどうかは別の判断（下の「引き受けた負債」）。

- **引き受けた負債**:

  1. **待つ間に `contested` になった記憶は、まだ見直していない。** 抽出をやり直さない規律（#1079）は
     `contested`・訂正の解決で負けた `superseded` にも及ぶが、LLM の後の見直しは `forgotten` だけ。
     `abortIfForgotten` が `forgotten` だけを見る契約であること、Issue #1226 が `forgotten` の穴で
     あることに揃えた。`consolidate`/`reflect` も同じ範囲である。
  2. **読み直しと書き込みの間の窓**は、`abortIfForgotten` を実装しない adapter では残る
     （`consolidate`/`reflect` と同じ。ADR 0375 決定7）。
  3. **Observation に、LLM を待つ間に新しく増えた記憶**（別の呼び出しが同じ Observation から書いた）は
     見ていない——見直しの対象は LLM の前に読んだ一覧である。これは observe と tick の二重
     extract の論点（別 PR）であり、ここでは扱わない。

- **これが覆るとしたら**:

  - `ReextractResult` に `outcome` 欄を足す（公開型の変更）ことが別の理由で決まったとき——
    打ち切りをその語彙へ移すか検討する。
  - `abortIfForgotten` の範囲を `contested` などへ広げる判断が入ったとき（`consolidate`/`reflect`
    と一緒に）。

- **確かめたこと（赤の証拠・変異試験）**:

  歯は `packages/postgres/src/__tests__/reextract-forget-race.postgres.test.ts`（LLM の provider stub が
  Promise を保留し、その間に `forget`／`forget`＋`purge` する。testkit の `InMemoryMemoryStore` と
  `PostgresMemoryStore` を、`supersedeWithNewMemories` の口の有無の2経路ずつ、計4通り）と
  `packages/postgres/src/__tests__/reextract-source-forgotten-for-update-race.postgres.test.ts`
  （runtime の読み直しの後・書き込みの入口で障壁を張り、割り込ませる——`SELECT … FOR UPDATE` の
  陽性対照）。歯だけを先に commit し、`origin/main` の実装で18本赤、直して緑、を確かめた。
  変異試験: (a) 読み直しを無効化 → InMemory の2経路だけが赤（Postgres は `FOR UPDATE` が守って緑）、
  (b) `abortIfForgotten` を渡さない → 障壁の歯（Postgres の2経路）だけが赤。
  数字と手順の詳細は PR 本文。

- **確かめていないこと**:

  - 決定5（口が無い adapter のループの2件目以降で打ち切られる場合）は、コードで読んだだけで、
    歯を書いていない（1件目と2件目の間に割り込ませる障壁を、まだ作っていない）。
  - `contested` を待つ間に起こす競合（負債1）。
