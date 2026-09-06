# ADR 0029: `reextract` が既存 Memory を supersede しなかった理由を `ReextractResult` に出す

- **状態**: 採用 (2026-09)

- **文脈**:

  [ADR 0028](./0028-reextract-superseded-cleanup.md) の「引き受ける負債」が次を記録済みだった。

  > 🔴 `active` 以外を飛ばしたことが、どこにも出ない（2026-09-06 に確認）。
  > `reextract` は `status !== 'active'` の既存 Memory を `continue` で飛ばすが、
  > **飛ばしたことは `ReextractResult` にも `memory_events` にも残らない**……
  > `supersededMemoryIds: []` は、次の3つで同じ顔になる:
  >
  > | 実際に起きたこと | 呼び出し側から見える形 |
  > |---|---|
  > | `contested` だったので飛ばした | `supersededMemoryIds: []` |
  > | `forgotten` だったので飛ばした | `supersededMemoryIds: []` |
  > | そもそも置き換えるものが無かった | `supersededMemoryIds: []` |

  オーナーがこれを負債として引き受けたまま放置せず、直すと決めた。

  加えて、`packages/core/src/runtime.ts` の `reextract` には早期 return が2つある
  （`usedWholeObservationFallback` の場合・`candidates.length === 0` の場合）。この2つは
  **`listBySourceObservation`（既存 Memory の列挙）を呼ぶ前に return する**。⟹ 上の3表に、
  実は次の第4・第5の顔が隠れている。

  | 実際に起きたこと | 呼び出し側から見える形（ADR 0028 時点） |
  |---|---|
  | LLM がまた失敗した（既存を見ていない） | `supersededMemoryIds: []` |
  | 候補が0件だった（既存を見ていない） | `supersededMemoryIds: []` |

  **「見ていない」と「見たが対象外だった」と「見て、変わっていなかった」を、同じ
  空配列という既定値の顔で返していた。** これは north-star の問い3（「この記憶が選ばれた
  理由を、後から説明できるか」——ここでは「選ばれなかった理由」）と、[ADR 0024](./0024-remove-exact-counts-option.md)
  が名指しした義務（足した欄の書き込み経路をすべて実測する）の両方に関わる。

- **決定**:

  1. `packages/core/src/strategies/reextract.ts` を新設し、判定そのものを純関数として
     切り出す。

     ```ts
     export type ReextractSkip =
       | { kind: "status_not_active"; memoryId: MemoryId; status: Exclude<MemoryStatus, "active"> }
       | { kind: "unchanged"; memoryId: MemoryId }
       | { kind: "not_examined"; reason: "llm_failed_whole_observation" | "no_candidates" };

     export function classifyReextractTargets(
       existing: Memory[],
       contentHashes: ReadonlySet<string>,
     ): { toSupersede: Memory[]; skipped: ReextractSkip[] }
     ```

     `packages/core` は PostgreSQL を持たないため、判定を純関数にしておけば手元の値に
     直接変異を撃って検査できる（`./decay.ts`・`./scoring.ts` と同じ「純関数の戦略」）。
     `runtime.ts` の `reextract` 本体はこの関数を呼んで `toSupersede` をループし
     `updateStatus` + `eventStore.append` するだけに変える——**supersede する対象・順序・
     積むイベントの中身は ADR 0028 からミリも変えていない。**

  2. `ReextractResult` に `skipped: ReextractSkip[]` を足す。書き込み経路は3つ:
     - `usedWholeObservationFallback` の早期 return →
       `[{ kind: "not_examined", reason: "llm_failed_whole_observation" }]`
     - `candidates.length === 0` の早期 return →
       `[{ kind: "not_examined", reason: "no_candidates" }]`
     - 本経路 → `classifyReextractTargets` の結果（`status_not_active` は status 付き、
       `unchanged` は content_hash 一致、どちらも無ければ空配列）

  3. **出し先は `ReextractResult` のみ。`memory_events` には書かない。** 件数の欄
     （`count`/`countKind`）は持たせない。理由はいずれも「採らなかった案」を参照。

  4. `ReextractResult` に zod schema は存在しないため（`observationId`/`memoryIds` などと
     同じく型のみ）、schema の追加更新は無い。

- **採らなかった案**:

  - **`memory_events` に「飛ばした」イベントを積む**: 却下。「飛ばした」は非事象であり、
    監査ログに non-event を積むと reextract を回すたびに行が無限に増える。加えて
    `memory_events.kind` は `packages/postgres/migrations/0001_init.sql:149` の CHECK 制約で
    閉じており、新しい `kind` を足すにはマイグレーションが要る——ADR 0028 は「スキーマを
    触っていない」ことを売りにしており、本 ADR もその線を継ぐ（**マイグレーションを一切
    足さない**）。さらに、触らなかった `forgotten` の Memory に「触らなかった」イベントを
    積むこと自体が、監査の意味では「触る」ことになる——`forgotten` は利用者が意図して
    忘れさせた記憶であり、機構がそれに指1本触れずに済ませることにこそ価値がある
    （ADR 0028 の安全弁の理由そのもの）。イベントを積む行為が、触らないという保証を
    かえって弱める。

  - **`count`/`countKind` を持たせる**: 却下。[ADR 0008](./0008-absence-taxonomy.md) の基準
    ——その区別があると次の一手が変わるか——に照らすと、「contested が1件か5件か」で
    次の一手（「対向の解決が先に要る」）は変わらない。加えて件数を正しく出すには
    `listBySourceObservation` の戻り値に完全性の signal を足す必要がある——現在は
    `Promise<Memory[]>` で LIMIT が無く「返ってきた配列の長さ」がそのまま件数になっている
    ため一見問題無さそうに見えるが、将来 LIMIT を足す変更が入ったときに「件数」という
    契約が静かに壊れる余地を今のうちに作らないほうがよい。次の一手を変えない情報のために
    `MemoryStore` の契約を広げる理由が無い。
    **なお [ADR 0011](./0011-no-window-count-in-ann-stage.md) の教訓
    ——`countKind: 'exact'` がリテラルで固定されたまま、出どころが `hnsw.ef_search` を
    返すように変わっても名乗りが変わらなかった——に照らすと、名乗る欄を持たない形は
    「壊れようがない」という点で強い。** `count`/`countKind` を持たないという選択は、
    単に「今は要らない」だけでなく、「将来出どころが変わっても嘘をつきようがない」
    という積極的な理由も持つ。

  - **`not_examined` を足さず、`memoryIds`/`supersededMemoryIds` が空であることから
    呼び出し側に推測させる**: 却下。早期 return で `skipped: []` を返すと「何も飛ばして
    いない」という**既定値の顔で嘘をつく**——実際には「既存 Memory を見てすらいない」。
    これは [ADR 0024](./0024-remove-exact-counts-option.md) の義務が名指ししている失敗の
    形そのものであり、本 ADR が解決しようとしている問題を形を変えて再導入することになる。
    「空配列」を「起きなかった」の既定値として使い回す限り、「見ていない」と「見て何も
    対象が無かった」は区別できない。

  - **`FilteredOmission`/`Omission`（`recall()` の語彙）を `reextract` にも使い回す**: 却下
    （オーナー指示）。`recall()` の `omitted` は「今回の想起で何を外したか」という別の
    文脈の語彙であり、`reextract` の `skipped` は「supersede しなかった理由」という別の
    軸を持つ（`not_examined` は `recall()` 側に対応物が無い）。1つの語彙に混ぜると、
    どちらの文脈で読んでいるかを型だけで区別できなくなる。

- **歯について**:

  `packages/core/src/__tests__/runtime.test.ts` の `describe("runtime.reextract...")` に
  `describe("skipped（ADR 0029: ...）")` を新設し、5本足した（基準線 192 → 197）。

  - **フィクスチャを非対称にした**（contested 1件・forgotten 2件）。同数だと「隣の値への
    入れ替え」変異（例えば `status_not_active` の `status` を実際の値ではなく固定値にする）
    が出力を変えないまま生き残る——`toHaveLength` は通っても中身の対応が壊れているのを
    見逃す。非対称にすることで「件数は合っているが status の対応が崩れている」変異も
    捕まえられる。
  - オーナーの追加要求である「飛ばすものが無かった」「候補0件」「LLM失敗」の3つの顔が
    違うことを1本の歯で並べて assert した。
  - 5本の変異（隣の値への入れ替え2種・push を消す・早期 return を既定値にする・安全弁を
    外す）を1つずつ当て、都度どの歯が赤くなったか、走ったテスト数を記録した
    （報告参照）。**5つとも赤くなり、うち4つは新しい歯だけが固有に捕まえた
    （既存の歯は無傷）。残り1つ（安全弁を外す変異）は新しい歯と既存の歯の両方が
    赤くなった**——既存の安全弁の歯が今回の変更でも生きていることの確認になる。

- **引き受ける負債**:

  - `supersededById` が「今回作られた Memory のうちの1件（先頭）」を指すという ADR 0028
    からの負債はそのまま残る。本 ADR は「飛ばした理由」を出すことにのみ範囲を絞った。
  - `ReextractSkip` の `not_examined` は「既存 Memory を1件も見ていない」ことしか言わず、
    「もし見ていたら何件あったか」は言わない——これは意図的（件数の欄を持たせない、
    という決定の直接の帰結）だが、呼び出し側が「見れば何件あったか」を知りたい場合は
    別途 `listBySourceObservation` を自分で呼ぶ以外に手段が無い。
  - `contested`/`forgotten` を単一の `status_not_active` にまとめている
    （`status: Exclude<MemoryStatus, "active">` で実際の値は残すが、`kind` は1つ）。
    `ReextractSkip.kind` の段階で `contested` と `forgotten` を分けるべきかどうかは
    検討したが、`FilteredOmission.condition` が `superseded`/`forgotten` を分けている
    （ADR 0027）のとは事情が違う——`reextract` の文脈では両方とも「今は対象外」という
    同じ次の一手（「今は何もしない」）に落ち着くため、`kind` を分けるほどの理由が今回は
    無いと判断した。ここは ADR 0027 と一貫していないように見えるかもしれない点として
    記録しておく。

- **確かめていないこと**:

  - **この器に PostgreSQL も Docker も無い。** `packages/postgres`・`examples/chat` は
    CI の `postgres` ジョブが唯一の実行環境であり、`classifyReextractTargets` は
    `packages/core` の fake ストアに対してのみ変異を当てた。本物の Postgres に対して
    `reextract` を呼び、`skipped` が同じ形で返ることは確認していない
    （ただし `classifyReextractTargets` は純関数であり `MemoryStore` の実装に依存しないため、
     `listBySourceObservation` が正しい Memory 一覧を返しさえすれば挙動は変わらない、
     という設計上の期待はある——期待であり実測ではない）。
  - **本物の LLM では試していない。** `OPENAI_API_KEY` を読まない・実 API を叩かないという
    制約の下で、決定的な擬似 provider のみに対して検査した。
  - `ReextractSkip` を呼び出し側（現時点では `reextract` を直接呼ぶコード以外に本番の
    呼び出し元は無い）が実際にどう使うか——`contested` を見たら何をするか等——は運用が
    無いため確かめていない。

- **これが覆るとしたら**:

  - 運用で「`contested` で飛ばした」と「`forgotten` で飛ばした」の間で呼び出し側の
    実際の一手が変わることが分かったら、`ReextractSkip.kind` を `status_not_active` から
    `contested`/`forgotten` の2つに分ける（ADR 0027 と同じ形に揃える）ことを検討する。
  - `listBySourceObservation` に LIMIT や completeness signal が入る変更が将来入ったら、
    「採らなかった案」で述べた「件数を持たせない」判断を再検討する必要が生じる
    ——そのときは新しい ADR を起こすこと。
