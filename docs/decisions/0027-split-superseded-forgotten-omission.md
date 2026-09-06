# ADR 0027: `filtered` omission の `condition: 'status'` を `'superseded'` と `'forgotten'` に分ける

- **状態**: 採用 (2026-09)

- **文脈**:

  `FilteredOmission.condition` は `"tenant" | "status" | "archived" | "taxonomy" | "period"` であり、
  `ScopeAggregate.filteredStatus` は `status IN ('superseded', 'forgotten')` を**1本の `count(*) FILTER`
  に束ねて**数えていた（`packages/postgres/src/memory-store.ts:429`）。`recall-runtime.ts` はこの1つの
  数値をそのまま `{ kind: "filtered", condition: "status", count, countKind }` という1枚の札にして
  `omitted` へ積んでいた（同ファイル 410-416 行）。

  **⟹ 「より良い抽出に置き換えられた（`superseded`）」と「利用者が意図して忘れた
  （`forgotten`）」が、`omitted` の上で同じ顔をしていた。**

  マネージャーが現物のコード（上記の行番号）を確認して発見した。実は `docs/recall.md` §2
  「スコープの外延」の記述（2026-09 追記分）は既にこの区別の理由を書いていた——
  「`superseded`/`forgotten` は……次の一手が異なる。この2つを両方とも単純に `'status'` へ丸めると、
  この区別が消える」。**つまり docs は正しい理由を既に述べていたのに、型と実装がそれに追いついて
  いなかった。**

  オーナーの判断（要約）: この2つは違う種類である。`forgotten` は**製品の振る舞い**
  （利用者が意図して忘れた）、`superseded` は**機構の都合**（より良い抽出に置き換えられた）。
  同じ札にすると、「利用者が忘れてほしいと言ったのか、こちらが作り直しただけなのか」を
  誰も判定できなくなる。次の一手が変わるのに、である。`superseded_by_id` が指す先を持てる
  （`forgotten` には指す先が無い）のも効く。

- **決定**:

  1. `FilteredOmission.condition` から `"status"` を削り、`"superseded"` と `"forgotten"` を足す
     （`packages/core/src/recall.ts`。interface と zod スキーマの両方）。`"archived"` が既に
     独立した condition になっている先例に倣い、status 由来の3つ（`archived` / `superseded` /
     `forgotten`）を横並びにする。
  2. `ScopeAggregate.filteredStatus` を `filteredSuperseded` と `filteredForgotten` の2つに分ける
     （同ファイル）。
  3. `packages/postgres/src/memory-store.ts` の集約 SQL を、`status IN ('superseded','forgotten')`
     の1本の `FILTER` から `status = 'superseded'` / `status = 'forgotten'` の2本の `FILTER` に分ける。
     引き続き**単一の集約クエリ**の中で計算する（ADR 0011 が段1から締め出した
     `count(*) OVER ()` と同じ理由——別々のクエリに分けると書き込みと競合して総和が崩れる——を
     ここでも守る。列を2本に増やしただけで、クエリの本数は増えていない）。
  4. `packages/testkit/src/__fixtures__/in-memory-memory-store.ts` と
     `packages/core/src/__tests__/runtime-fakes.ts` の同等ロジックも同様に分岐を2つにする。
  5. `packages/core/src/recall-runtime.ts` は `filteredSuperseded`/`filteredForgotten` それぞれについて
     `count > 0` のときだけ別々に `omitted.push()` する。

  **`"status"` を「予約」として残さない。** [ADR 0024](./0024-remove-exact-counts-option.md) の線
  ——実装の無い欄・誤解を招く欄は残さず消す——に従う。`"status"` という値は削除し、
  参照は `tsc` が型検査で検出する形にする。

- **検討した代替案**:

  - **`"status"` を残しつつ、`superseded`/`forgotten` を副次フィールド（例えば
    `FilteredOmission` に `subCondition?: 'superseded' | 'forgotten'` を足す）として持たせる**:
    却下。理由は3つ。第一に、`"archived"` が既に独立した condition として存在する以上、
    同じ「status ゲートで落ちた」という性質を持つ `superseded`/`forgotten` だけを
    副次フィールドに格下げすると、3つの間で扱いが不揃いになる——`archived` を見るときは
    `condition` を見ればよいのに、`superseded`/`forgotten` を見るときは `condition === 'status'`
    かつ `subCondition` を見る、という非対称な読み方を呼び出し側に強いる。第二に、
    `subCondition` を持つ・持たないという分岐自体が型として弱い（`condition === 'status'` の
    ときだけ存在が保証される、という制約を判別可能ユニオンなしで表現しづらい）。第三に、
    `docs/recall.md` §2 が既に「この2つを単純に `'status'` へ丸めるとこの区別が消える」と
    明言しており、`condition` の値そのものとして分けるほうが docs の記述と型が一致する。
  - **`CountKind` や `Omission.kind` の側で区別する**: 検討の対象外。`superseded`/`forgotten` は
    「件数の精度」（`countKind` が扱う軸）でも「omission の種類」（`stage_skipped` 等、`kind` が
    扱う軸）でもなく、`filtered` という1つの `kind` の中の「どの条件で落ちたか」という軸に
    属する。`FilteredOmission.condition` を増やすのが素直な置き場所である。

- **引き受ける負債**:

  - `FilteredOmission.condition` の分岐が増えるたびに、`packages/postgres`・
    `packages/testkit`・`packages/core` の3箇所（実装が3通りある: 本物の Postgres 集約 SQL、
    in-memory fixture、core のテスト用 fake）で同じ分岐を保守する必要がある。今回のように
    分割を増やす変更のたびに、3箇所すべてに同じ形の変更を入れ忘れるリスクがある
    （実際、`packages/postgres/src/bench/scale-bench.ts` は `aggregateScope` の戻り値を分割代入
    していないため今回は無傷だったが、次に `ScopeAggregate` の形が変わったときも無傷とは
    限らない——呼び出し側が分割代入をし始めたら同じ穴が開く）。
  - `docs/decisions/0011-no-window-count-in-ann-stage.md`・
    `docs/decisions/0025-ann-underfill-is-not-reported-in-omitted.md`・
    `docs/decisions/0026-ann-unreached-omission.md` は、いずれも `condition: 'status'` /
    `filteredStatus` という**当時は正しかった**語彙で実測結果を記録している。ADR は
    「決定を記録する場であり、やり直す場ではない」（`docs/decisions/README.md`）という方針に
    従い、**これらの過去の ADR 本文は書き換えていない。** 読者が ADR 0011/0025/0026 を読むときは
    「その時点の型」を読んでいることを踏まえる必要がある——本 ADR がその橋渡しの記録になる。

- **確かめていないこと**:

  - **`countKind: 'exact'` が実際に正確であることは、擬似の MemoryStore（in-memory fixture・
    core の fake）と型検査でしか確かめていない。** 本物の Postgres に対する実測は、
    `packages/testkit/src/memory-store-conformance.ts` に足した歯
    （`aggregateScope は status='superseded' と status='forgotten' を別々に計上する`、
    superseded 3件・forgotten 5件・active 1件・archived 1件を非対称に混ぜ、
    `filteredSuperseded.count === 3` かつ `filteredForgotten.count === 5` かつ両方の
    `countKind === 'exact'` を assert する）が `packages/postgres` の CI ジョブで
    `describeMemoryStoreConformance` 経由で本物の Postgres に対しても走ることで担保される
    **はず**だが、**この PR の作業環境には手元に PostgreSQL が無く、この歯を本物の Postgres
    に対して実行して確認してはいない。** 型検査（`tsc`）とロジックの目視、および同じロジックを
    in-memory 実装で走らせて緑になることまでは確認した。CI で実際に走らせて確認するのは
    次の一手として残る。
  - **件数を非対称（3 と 5）にしたのは束ね・取り違えの両方を検出するためだが、
    3 と 5 という具体的な数自体に他の意味はない。** どちらも 0 でも 1 でもない、互いに異なる、
    という以上の要件は無い。
  - `examples/chat` 側の表示（`compare.ts` の `filtered(${o.condition}):${o.count}`）は
    `condition` の値をそのまま埋め込む汎用実装であり、`"superseded"`/`"forgotten"` が来ても
    そのまま表示されることをコードリーディングで確認したが、実際に `compare` を実行して
    出力を目視してはいない（`OPENAI_API_KEY` を読まない・実 API を叩かない制約の下で作業した
    ため）。

- **これが覆るとしたら**:

  - `superseded` と `forgotten` の間でも、呼び出し側の実際の一手が変わらないと運用で分かったら
    （例えば両方とも「何もしない」で扱われることが分かったら）、再び1つの condition に戻す
    ことを検討する。ただしその判断は実装の裁量ではなく運用の実測に基づくべきである。
  - `superseded_by_id` を辿った先の Memory 自体が既に無い（二重に superseded されている等）
    ケースが実運用で頻出すると分かったら、`superseded` をさらに「置き換え先が生きている」
    「置き換え先も無い」に分ける必要が生じるかもしれない。今回はそこまでは踏み込まない。
