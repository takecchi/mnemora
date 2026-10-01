# ADR 0472: 穴探し43巡目 — subjectId が `Object.prototype` のキー名（`constructor`・`valueOf`・`__proto__` など）のとき、subject 別の活動カウンタの読みが壊れるのを直す

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-01

クローン miku の委譲先（担い手。マネージャー mgr-0d3098f9 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・前例のある同種の穴は直す。新しく断る入力・既定値や公開の型の変更は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 43巡目は、今日の ADR 0441〜0470 が見ていない面を選ぶところから始めた。選んだのは、`TenantSettingsStore.getSubjectActivitySeqs?` の戻り値（`Record<string, number>`）を、利用者が決める文字列の `subjectId` で引く口。前例は outbox の `kind`（[ADR 0082](./0082-tick-names-unsupported-job-kinds.md)、`runtime.test.ts` の `constructor`・`toString`・`__proto__`・`hasOwnProperty` の歯）と、openai の応答の `__proto__`（ADR 0468、open PR）。`subjectId` 側を名指しした Issue・PR・ADR は見つからなかった【実測。`gh search -R takecchi/mnemora` で `getSubjectActivitySeqs`（open 0、closed issue 1・PR 4。いずれも活動時計の実装・NUL・テナント境界の話）、`readSubjectActivitySeqs`（closed PR 2）、`subjectId constructor`（全 0）】。

- **穴（直す前）**【実測】:
  - `readSubjectActivitySeqs`（`packages/core/src/interfaces/tenant-settings-store.ts`）は、store の結果を `result[id] ?? 0` で引き、組み立てる側もプレーンな `{}`（`filled[id] = …`）だった。subjectId が `constructor`・`toString`・`valueOf`・`hasOwnProperty` で、その subject の行が無い（adapter はキーを省略する）と、`result[id]` は `Object.prototype` 側の関数を返し、`?? 0` が効かない。`__proto__` は `Object.prototype` を返し、`filled["__proto__"] = …` は代入が黙って捨てられる。
  - 消費側（`recall-runtime.ts` の `ensureSubjectSeqs`、`runtime.ts` の `readActivitySeqForSubjects`）は `T + S_x`（テナントの通し番号 + その subject の番号）を作る。`S_x` が関数だと文字列連結になる。
  - adapter 側も同じ形だった: `PostgresTenantSettingsStore.getSubjectActivitySeqs`・`InMemoryTenantSettingsStore.getSubjectActivitySeqs`・core のテスト用 `FakeTenantSettingsStore` は、プレーンな `{}` に `out[subject_id] = n` で書く。subject `__proto__` の行があっても、値が黙って落ちる。
  - 実測（activity 時計のテナント、T=10。subject `anchor` に行があり、`hasSubjectActivityCounters` が真）:

    | 入力 | 直す前 | 直した後 |
    |---|---|---|
    | core の `readSubjectActivitySeqs`（store は `{}` を返す）、`constructor`・`toString`・`valueOf`・`hasOwnProperty` | `seqs[key]` が関数 | `0`（自前のキー） |
    | 同 `__proto__` | `Object.prototype` | `0` |
    | `observe`（fake の store）、ctx.subjectId が `valueOf`・行なし | 作られた記憶の `decayBaseSeq` が `"10function valueOf() { [native code] }"`（文字列） | `10` |
    | 同 `constructor`／`toString`／`hasOwnProperty` | `"10function Object() …"` など | `10` |
    | 同 `__proto__`（行なし） | `"10[object Object]"` | `10` |
    | 同 `__proto__`（行あり S=4） | `"10[object Object]"`（S=4 の行も効いていない） | `14` |
    | 実 Postgres で `observe`、同じ5つ（行なし／行あり） | 5つとも赤（`decay_base_seq` へ文字列を渡す、または値が落ちる） | `10`／`14` |
    | 実 Postgres・InMemory の `getSubjectActivitySeqs([ "__proto__", … ])`（行あり） | `__proto__` の値が返らない | `4` |
    | 陽性対照: `plain` | 行なし `10`、行あり `14` | 同じ |

- **決定**（線の内側。公開の型・既定値は変えていない）:
  1. **`readSubjectActivitySeqs` は、store の結果を自前のキーだけ・有限の数だけ読む**（`Object.hasOwn` と `Number.isFinite`）。組み立てる側は `Object.create(null)`（prototype の無いオブジェクト。`__proto__` も普通のキーになる）。戻り型 `SubjectActivitySeqs` は同じ。消費側の `seqs[id] ?? 0` は、そのまま正しく動く。
  2. **3つの adapter（Postgres・InMemory・core のテスト用 fake）の `getSubjectActivitySeqs` も、`out` を `Object.create(null)` にした。** `__proto__` の行が落ちない。（呼び出し側が `toEqual({ alice: 7 })` で比べる既存の歯は、prototype の違いを見ないので変わらない。）
  3. **横展開で 1 件直した: `intersectAttributes`**（`strategies/consolidate.ts`。consolidate・reflect が使う）。`attributes` のキーの文字種（`ATTRIBUTE_KEY_PATTERN` = `[A-Za-z0-9_.:-]+`）は `__proto__`・`constructor` を通す。`result[key] = value` は key が `__proto__` のとき黙って捨てられるので、全件が持つ `__proto__` の属性が統合先の記憶から消えた。`Object.fromEntries`（自前のキーとして作る）に替えた。ただし、`__proto__` の属性を持つ記憶を `observe` で作る経路は無い（下の材料1）ので、届くのは別の経路（JSON から読んだ値・adapter への直接の書き込み）だけ。

- **歯**（直す前の実装で赤を見せ、直した後に緑、変異で赤に戻ることを確かめた）:
  - `packages/core/src/__tests__/subject-activity-seqs-prototype-keys.test.ts`（20本）: 純関数。陽性対照 `plain`、5つのキー名、`getSubjectActivitySeqs` を持たない store、行がある store の値、prototype 側の継承値を行と読まない、NaN・文字列・Infinity を 0 に倒す、`intersectAttributes` の2本。
  - `packages/core/src/__tests__/subject-activity-seq-prototype-keys-runtime.test.ts`（11本）: Runtime の出口（`observe` が書く `decayBaseSeq`）。
  - `packages/testkit/src/__tests__/in-memory-subject-activity-seqs-prototype-keys.test.ts`（6本）、`packages/postgres/src/__tests__/subject-activity-seq-prototype-keys.postgres.test.ts`（11本。実 Postgres）。
  - 数・変異の結果は PR の本文に書いた。

- **探した形の一覧**（ユーザー由来のキーをプレーンな `{}` に入れて読む形）:
  - 直した: `readSubjectActivitySeqs`（core）、`getSubjectActivitySeqs` の3実装、`intersectAttributes`。
  - 同じ形ではない（読んだ範囲で確認）: `runtime.ts` の `guarded`（キーは `Runtime` のメソッド名で固定）、`postgres/src/claim-key-index-limit.ts` の `copied`（キーは固定の4語）、`jobHandlerLookup`（`Map`。ADR 0082）、`extraction.ts` の `relativeDates`（`Object.fromEntries`・固定のキー）。`survivesAttributesFilter`（`recall-runtime.ts`）と testkit の2つの `attributes` 絞り込みは、`memoryAttributes[key] === value` の形で、継承された関数と文字列は等しくならないので壊れない（`__proto__` のキーが絞り込みに載らない件は材料1）。`Memory.tags`・`labels` は配列・`Set`・`Map` で読んでいる。
  - 【未確認】`packages/postgres` の SQL に渡す側（`attributes` を `jsonb` にする `JSON.stringify`）は、`__proto__` を自前のキーとして持つ値を正しく書く（JSON.parse が作る値）。走らせていない。

- **検討した代替案**:
  1. **`getSubjectActivitySeqs?` の戻り型を `Map<string, number>` にする。** 採らなかった。公開の型の変更で、依頼主の線の外側。材料に回した。
  2. **`subjectId` が `Object.prototype` のキー名のときは断る。** 採らなかった。新しく断る入力を増やす。どの subjectId も同じ計算に乗るほうが約束に近い。
  3. **消費側の `?? 0` を `Number.isFinite` で包むだけにする。** 採らなかった。`__proto__` の代入が捨てられる問題（adapter の `out`）は、読む側では直せない。

- **引き受けた負債（材料）**:

  | # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
  |---|---|---|---|---|---|
  | 1 | `attributes` のキーが `__proto__` だと、zod の record が**黙って落とす** | `RecallQuerySchema.parse({ text: "q", attributes: { "__proto__": "x" } })`（JSON.parse で作る）【実測】 | `attributes` が `{}` になり、recall の絞り込みが**効かない**（`recall-runtime.ts` は空の絞り込みを絞り込み無しとして扱う）。`observe` の `attributes` も同様に落ちる。`constructor` などは落ちない | 低（キー名として使う利用者は少ない）。ただし絞り込みが外れるのは、狭めたつもりが狭まらない向き | 断る（キーの文字種から `__proto__` を外す）か、zod を通さず保つと決まったとき。どちらも新しく断る／仕様を変える側 |
  | 2 | `getSubjectActivitySeqs?` が `Record<string, number>` を返す型のまま | 他の adapter（利用者が書く）が `{}` で組み立てると、同じ穴が adapter 側に残る | `readSubjectActivitySeqs` が自前のキーだけを読むので、`constructor` などは `0` に倒れる。`__proto__` の行は adapter 側で落ちる | 低 | 戻り型を `Map` にしてよいと決まったとき |
  | 3 | testkit の適合テスト（conformance）に、`Object.prototype` のキー名の subjectId の歯が無い | — | 新しい adapter が同じ穴を持っても、適合テストは赤くならない | 低 | suite に約束を足してよいと決まったとき（依頼主の線の外側） |

- **これが覆るとしたら**: `getSubjectActivitySeqs?` の戻り型を `Map` にすると決まったとき（決定1・2は型に吸収される）。

- **測っていないこと**: 活動時計の忘却ゲート（段1 SQL）の比較が、文字列の `decayBaseSeq` で実際にどう誤るか（Postgres は文字列を bigint に渡せず落ちるので、実 Postgres では誤った忘却の前に `observe` が落ちる。fake では文字列のまま書かれる）。`reinforce`・`restoreArchived` など、`observe` 以外の書く側の経路（同じ `readSubjectActivitySeq` を通る）の個別の走行。`@mnemora/bullmq` の経路。
