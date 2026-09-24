# ADR 0289: `RecalledMemory` に `speaker`/`subjectId` を任意欄として足す —— Issue #579 案D を、型ではなく runtime の保証で守る（非破壊）

- **状態**: 採用 (2026-09-24)
- **日付**: 2026-09-24

> **⚠ この判定は、自動化された担い手（マネージャーのセッションから切り出された担い手）のものである。**
> **⛔ オーナー本人の決定ではない。**
> **理由**: この担い手・マネージャーの署名は repo 上では `takecchi` になり、オーナー本人と
> 区別が付かない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
> ⟹ **この ADR を「オーナーが決めた」と読まないこと。**方向そのものの変更が要るなら、
> オーナー本人に問い直すこと。

**⚠ 各主張の出所を分ける**（ADR 0246 / ADR 0282 の体裁を踏む）。

- **【現物】** — この repo のコード・文書を、この ADR の書き手が自分の手で読んで確かめた。
- **【実測】** — この書き手が実際に `git` / `vitest` / `tsc` / `pnpm` を走らせて確かめた。
- **【受】** — 報告・Issue コメントとして受け取り、再導出していない（出所を明記する）。

断りの無い【現物】【実測】は `origin/main` = `a04e814`（本作業の分岐点）の木で、2026-09-24 に行った。

---

## 文脈

### Issue #579 が並べた4つの困りごとと4案

[Issue #579](https://github.com/takecchi/mnemora/issues/579)（virchamate からの提案）は、
「1テナント＝1キャラクター、`subjectId`＝相手」という用途で、`consolidate` が subject を
またぐと `Memory.subjectId` が `null` に畳まれ帰属が消える（困りごと1）・subject 指定の
recall に統合済みが出てこない（困りごと2）・recall の場で `speaker` が見えない（困りごと3）
という3つの困りごとを報告し、案A〜D を並べた。**案D**は「`RecalledMemory` に `speaker`/
`subjectId` を平らに出す」——困りごと3への対応である。

### issuecomment-5753773066 — 当初「必須欄」で提案し、opt-in を明示的に退けた

【受】マネージャー経由の調査コメント（[issuecomment-5753773066](https://github.com/takecchi/mnemora/issues/579#issuecomment-5753773066)）は、A は採らず C + D を推す形で、D を次のとおり提案していた（逐語）:

> **(1) D を、opt-in ではなく必ず出す形で。** `RecalledMemory` に `speaker: string | null` と
> `subjectId: string | null` を**必須欄**として足す。
>
> ⭐ **opt-in を採らない理由**: opt-in にすると **「この記憶に `speaker` が無い」と
> 「`speaker` を頼まなかった」が同じ `undefined` になる。**⟹ これは、この repo が
> 2026-09-21 に焼いたばかりの規律（[ADR 0257](./0257-searched-and-found-nothing-versus-did-not-search.md) /
> #571「**探したが無かった**」と「**探していない**」を分ける）を、公開型の側で破る形になる。
>
> ⭐ [ADR 0035](./0035-recalled-memory-provenance-kind.md) 決定3 が optional を却下した理由
> （「書き忘れた経路が**未指定という既定値の顔で**通る」）も、そのままここに当たる。

**この時点の提案は「必須欄」だった**——opt-in（型を optional にして、呼び出し側が
`RecallQuery.include` のような形で明示しない限り出さない）を、上記の理由で積極的に退けている。

### issuecomment-5811791086 — オーナーの委任を受け、「必須欄」を撤回し「任意欄＋runtime 保証」に変えた

【受】後続コメント（[issuecomment-5811791086](https://github.com/takecchi/mnemora/issues/579#issuecomment-5811791086)）が、この必須欄案を自ら覆している（逐語）:

> **案D は進める（別 PR）。** ただし `RecalledMemory` に**必須欄**として足す形は採らない。
> 【現物】`docs/migration-v1.md` の番号付き一覧は「返り値の型に必須フィールドが増えた」形
> （項目7・9・10）を破壊的変更に数えており、v1.0.0 出荷後は major になる。⟹ `speaker` /
> `subjectId` を**型の上では任意欄**にし、**runtime が常に値か `null` を入れる**形にする
> （先例: ADR 0282 の `affinityMeasured?`）。「無い」と「頼まなかった」を実行時に混ぜない
> 保証は、型ではなく runtime の歯で持つ。

**この撤回の出所**（同コメント冒頭、逐語どおり）: オーナー（takecchi）が
2026-09-24T07:02Z に、承認キュー経由（この repo の外）で「あなたの推奨案で良いのであなたが
決められるものはあなたの判断で進めちゃってください」と述べ、それを受けたオーナーのクローン
（価値観の写し。オーナー本人ではない）が上記を決めた。**当初の問1（D を必須欄で足しても
非破壊）は、`docs/migration-v1.md` の数え方（下記）に照らすと破壊的だと分かったため、
形を「任意欄＋runtime の保証」に変えた。**本 ADR はこの変更後の形を実装する。

**⛔ オーナー本人が「型を任意にせよ」と述べたわけではない。**述べたのは「決められるものは
判断で進めてよい」という委任であり、任意欄への変更判断そのものはクローンが行った。

### 🔴 「必須欄＝非破壊」という当初の読みは、`docs/migration-v1.md` の数え方と食い違っていた

【現物】`docs/migration-v1.md` は項目7・9・10 でいずれも「返り値の型に**必須**フィールドが
増えた」形だけを破壊的変更に数えている（項目9・10 は「返り値の型に必須フィールドが増えた」形の
節見出しそのものにその言葉を使っている）。项目7（逐語）も「入力側は省略可能フィールドとして
追加されており、省略すれば0として扱われる（**非破壊**）」と、**任意欄の追加を非破壊の代表例**
としている。

⟹ **必須欄で足す形の D は、この repo 自身の数え方では破壊的変更だった。**
[ADR 0282](./0282-score-breakdown-affinity-measured.md)（`ScoreBreakdown.affinityMeasured?: boolean`）が
既に同じ理屈・同じ根拠（ADR 0178「新しい任意プロパティの追加」＝semver 的に安全）で
非破壊の道を実装しており、本 ADR はその先例をそのまま踏む。

---

## 決定

### 1. `RecalledMemory` に `speaker?: string | null` と `subjectId?: string | null` を**任意欄**として足す

```ts
export interface RecalledMemory {
  memoryId: MemoryId;
  digest: string;
  retrievedVia: "ann" | "lexical" | "mandatory_companion" | "association";
  companionOf?: MemoryId;
  associationOf?: MemoryId;
  provenanceKind: ProvenanceKind;
  score: ScoreBreakdown;
  speaker?: string | null;     // 新設
  subjectId?: string | null;   // 新設
}
```

`RecalledMemorySchema`（zod）にも同じ形で
`speaker: z.string().min(1).nullable().optional()` /
`subjectId: z.string().min(1).nullable().optional()` を足す。**既存の欄の型・名前・必須性は
1バイトも変えていない**（`git diff` で確認——追加行のみ、`packages/core/src/recall.ts`）。

### 2. `speaker` の意味と、値の決め方

- **`provenance.kind === "stated"` のときだけ在りうる**——`speaker` は `StatedProvenance` に
  しか存在しない欄（`packages/core/src/provenance.ts:29`）。
- `stated` で `speaker` が述べられていれば、その値。述べられていなければ `null`。
- `stated` 以外（`inferred`/`consolidated`/`reflected`/`imported`）は**常に `null`**
  （持ちようが無い）。

### 3. `subjectId` の意味と、値の決め方

- **その Memory 自身の `Memory.subjectId` をそのまま引き継ぐ。**`Memory.subjectId?: string | null`
  が `undefined` のときも `null` に揃える（`undefined` を呼び出し側へ渡さない）。
- ⚠ **この欄は Issue #579 の困りごと1（`consolidate` が subject をまたぐと `null` に畳む）を
  直すものではない。**統合後の Memory は `subjectId: null` のままであり、この欄はそれを
  そのまま映す——**困りごと3（recall の場で speaker/subjectId が見えない）にだけ答える。**

### 4. runtime は常に値か `null` を書く。`undefined` にもキー省略にもしない

`packages/core/src/recall-runtime.ts` の `finalMemories` を組む1箇所（段4の後）で:

```ts
speaker:
  member.memory.provenance.kind === "stated"
    ? (member.memory.provenance.speaker ?? null)
    : null,
subjectId: member.memory.subjectId ?? null,
```

**「無い（`null`）」と「頼まなかった・書き忘れた（`undefined`）」を実行時に混ぜない**——
これが下の「ADR 0257 / ADR 0035 決定3 に正面から答える」節の核心である。

### 5. 組み立て箇所を数えたこと（ADR 0035 §1 と同じ形で数えた）【実測】

`grep -rn "provenanceKind:" と "retrievedVia:"` を `packages/`・`examples/` 全体へ当てた
（`.test.ts` を除く）。**`RecalledMemory` を組み立てている本番の箇所は1箇所**
（`recall-runtime.ts` の段4の後、`finalMemories`）だけだった。

| 経路 | 通る箇所 |
|---|---|
| ANN (`retrievedVia: "ann"`, `:838`) | 同じ1箇所（`unit.members` 経由） |
| 語彙 (`"lexical"`, `:838`) | 同上 |
| 同伴取得 (`"mandatory_companion"`, `:994`) | 同上 |
| 連想 (`"association"`, `:1378`) | 同上（`allUnits = [...units, ...associationUnits]` として合流） |

**いずれの経路も `ScoredCandidate.memory: Memory` を丸ごと持つ**（`recall-runtime.ts:108-124`
`type ScoredCandidate`）ので、`provenance`/`subjectId` は必ず在り、**DB への追加往復は無い**
（前任の issuecomment-5753773066 の実測「実装は1箇所で済む」を、本 ADR の作業で当て直し、
確認した）。

`packages/testkit/src/memory-store-conformance.ts` にも `retrievedVia:` の出現があるが、
これは `RecalledMemory` ではなく `RecallRecordMemory`（永続化された `returnedMemories`。
下記「決定6」参照）のテストフィクスチャであり、対象外である。`examples/chat` に
`RecalledMemory` の組み立て箇所は無い（読むだけ）。

### 6. 永続化（`RecallRecordMemory`／`recalls.returned_memories`）には足さない

`RecalledMemory` の欄のうち「後から再現できないもの」だけを持つ `RecallRecordMemory`
（`recall.ts:1698` 前後の doc「`digest`/`provenanceKind` は `MemoryStore.get()` から
再現できるため含めない」）には、**`speaker`/`subjectId` を足さない。**理由は同じ——
`speaker` は `MemoryStore.get(memoryId).provenance.speaker` から、`subjectId` は
`MemoryStore.get(memoryId).subjectId` から、どちらも再現できる。⟹ **`packages/postgres` の
マイグレーションは不要。**`runtime.ts` の `returnedMemories` 組み立て（`createRecall` 呼び出し）
は1バイトも変えていない。

---

## ADR 0257 / ADR 0035 決定3 に正面から答える

**issuecomment-5753773066 が opt-in を退けた理由**（ADR 0257「探したが無かった」と
「探していない」を分ける）と、**ADR 0035 決定3 が optional を却下した理由**（「書き忘れた
経路が未指定という既定値の顔で通る」）は、どちらも**同じ懸念**を指している——
**「`undefined` が意味を持ってしまう」**こと。opt-in にすれば「頼まなかった」が
`undefined` になり、optional（型だけ任意）にすれば「書き忘れた」も同じ `undefined` に
埋もれる。**どちらも、`undefined` という1つの見た目に2つの違う意味（『無い』と『分からない』）
が乗ってしまう。**

**この ADR が採る形は、この懸念に正面から答える**:

1. **opt-in にはしない。**`RecallQuery` に `include: ['speaker']` のような明示指定は
   要らない——`recall()` は常にこの欄を返す。「頼まなかったから `undefined`」という経路が
   構造的に存在しない。
2. **型は任意（`speaker?: string | null`）だが、runtime は常に値か `null` を書く。**
   「書き忘れた」を防ぐのは型の必須性ではなく、**唯一の組み立て箇所（上記「決定5」）に
   置いた実装の規律**であり、**それを固定する歯**（下記「測ったこと」の m1〜m3）である。
   `undefined` を渡す経路・キーを省く経路は、どちらも赤くなる。

**⟹ この形で「無い（`null`）」と「頼まなかった・書き忘れた（`undefined`）」を実行時に
混ぜない、という ADR 0257 / ADR 0035 決定3 の要求を満たす。**

**それでも正直に書く残りの負債**: **型の上では `speaker`/`subjectId` は依然 optional
（`?`）であり、`undefined` はコンパイルエラーにならずに代入できる。**この ADR が
保証しているのは「`recall-runtime.ts` の**唯一の**組み立て箇所が `undefined` を書かない」
ことであって、「`RecalledMemory` 型を持つ値がどこでも `undefined` を持ちえない」ことでは
ない——独自の `RecallResult` を手で組み立てるコード（テストダブル・別の runtime 実装）が
この欄を省略すれば、型検査は通ってしまう。ADR 0035 決定3 は必須化でこの経路自体を
型で塞いだが、**本 ADR は `docs/migration-v1.md` の数え方（必須化＝破壊的）の下で
非破壊を選んだ以上、この経路を完全には塞げない。**下の「引き受けた負債」に明記する。

---

## 採らなかった案

| 案 | 却下の理由 |
|---|---|
| **D を必須欄として足す**（issuecomment-5753773066 の当初案） | `docs/migration-v1.md` 項目7・9・10 の数え方では破壊的変更になる（上の「文脈」節）。issuecomment-5811791086 がこの案を撤回した |
| **opt-in（`RecallQuery.include: ['speaker']` 等）** | issuecomment-5753773066 自身が ADR 0257 を根拠に退けている。この ADR も同じ理由でこの形を採らない——「頼まなかった」を `undefined` にする経路を残すため |
| **案A（`ConsolidatedProvenance.sources` に帰属を持たせる）を一緒に実装する** | 本 ADR の射程外。issuecomment-5753773066 は A も採らないとしており（統合後の `Memory.subjectId` が `null` のままである以上、A だけでは困りごと2 が残る）、issuecomment-5811791086 もこの判断を覆していない |
| **案C（`ConsolidateOptions.subjectPolicy`）を一緒に出す** | issuecomment-5811791086 が「案C は今回は出さない」と明示的に決めている——union を広げる形は破壊的変更（migration-v1.md 項目4・17）、既定を変えない形にしても自動経路（`processConsolidateJob`）に効かないため単独で出す価値が薄いという判断（詳細は同コメント） |
| **`speaker`/`subjectId` を1つの `attribution?: { speaker: string \| null; subjectId: string \| null }` にまとめる** | 検討した。既存の平らな欄（`provenanceKind`・`companionOf`・`associationOf`）と設計を揃えるほうが、`RecalledMemory` 全体の読み方を一貫させる。ADR 0035 決定2 が「`provenance: { kind }` という入れ子にすると欄を足す先が既に在ることになる」として入れ子を避けた理由が、ここにもそのまま当たる |

---

## 引き受けた負債

1. **型の上では `undefined` がまだありうる**（上の「ADR 0257 / ADR 0035 決定3 に正面から
   答える」節の末尾）。`docs/migration-v1.md` の数え方の下で非破壊を選んだ以上、必須化に
   よる完全な型強制はできない。唯一の組み立て箇所（`recall-runtime.ts`）の規律は歯で
   固定したが、**独自の `RecallResult` 実装がこの欄を省略する可能性そのものは型では
   塞がれていない。**
2. **困りごと1（`consolidate` が subject をまたぐと `Memory.subjectId` が `null` に畳まれる）
   は残る。**本 ADR の `subjectId` 欄は `Memory.subjectId` をそのまま映すだけであり、
   統合後の記憶では `null` のままになる——Issue #579 は閉じない（下記「射程」参照）。
3. **`speaker`/`subjectId` を実際にプロンプトへどう使うか（呼び出し側の統合方法）は、
   本 ADR の射程外。**`examples/chat` にこの欄を反映するかどうかは決めていない。
4. **本物の Postgres に対する DB テストを実行していない**（`DATABASE_URL` 未設定。
   AGENTS.md の規律どおり「実行していない」と明記する）。決定6（永続化しない）は
   `packages/postgres` を1バイトも変更していないことと、`mapping.ts` の現物確認
   （`rowToRecallRecord` が `RecallRecordMemory` の形をそのまま読む単純な cast であること、
   ADR 0282 決定4 と同じ確認手順）から導いた設計上の結論であり、本物の DB に対して
   「新しい欄を持たない過去の `RecalledMemory`（本 ADR 以前に構築されたもの）を読み戻しても
   壊れない」ことを実行して確認してはいない——ただし本 ADR は `RecalledMemory` 自体を
   永続化しないため、この確認は他の「任意欄追加」系 ADR（0282 など）よりもそもそも
   射程が狭い。

---

## 射程 —— 確かめていないこと・閉じないもの

- **案C は出さない**（issuecomment-5811791086 の決定をそのまま踏襲。上の「採らなかった案」参照）。
- **困りごと1（統合で `subjectId` が `null` に畳まれる）は残る。**案A・案B のどちらも
  本 PR の射程外であり、実装していない。
- **[Issue #579](https://github.com/takecchi/mnemora/issues/579) は閉じない。**困りごと1
  への対応（案A・案B）が残っている限り、Issue 全体としては未完了である。
- **`examples/chat`/`compare.ts` の出力に `speaker`/`subjectId` を反映するかどうかは
  決めていない。**この PR の範囲に含めていない。
- **書き込み容量への影響を実測していない。**`RecalledMemory` は永続化されない
  （決定6）ため、HTTP payload 側のみに影響するが、実測（ADR 0035 §2.2 のような
  「1件あたり+N文字」測定）はしていない。プロンプトへ積む量（`usage.chars`）が
  動かないことだけは歯で固定した（下記「測ったこと」）。

---

## これが覆るとしたら

1. **案A・案B のどちらかが実装され、困りごと1 が別の形で解決されたとき**——本 ADR の
   `subjectId` 欄の意味（`Memory.subjectId` をそのまま映す）が、そのときの解決策次第で
   拡張される可能性がある（例えば `subjectIds: string[]` になるなら、この欄も追随する
   必要が出るかもしれない）。
2. **オーナーが「必須欄にすべきだった」「v2.0.0 まで待つべきだった」と判断したとき**——
   本 ADR は無効になり、必須化する追加の破壊的変更（別 ADR）を検討することになる。
3. **オーナーが本 ADR の出自の前提**（2026-09-24T07:02Z に承認キュー経由・repo の外で
   受けた委任〔issuecomment-5811791086 はそれを記録しただけ〕、およびそれを受けたクローンの判断）**を「違う」と言ったとき**——その場合、
   任意欄への変更そのものを再検討する必要がある。
4. **独自の `RecallResult` 実装が `speaker`/`subjectId` を省略する事例が実際に見つかった
   とき**（引き受けた負債1）——そのときは必須化（破壊的変更）を検討することになる。

---

## 測ったこと

### 【実測】赤（実装前）

```
$ pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall.test.ts src/__tests__/recall-pipeline.test.ts \
  src/__tests__/recall-association.test.ts
...
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — speaker/subjectId（Issue #579 案D、ADR 0289） > stated かつ speaker が在れば、その値をそのまま名乗る（ANN 経由）
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — speaker/subjectId（Issue #579 案D、ADR 0289） > stated だが speaker が無ければ null（キー自体は在る）
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — speaker/subjectId（Issue #579 案D、ADR 0289） > inferred は speaker を持ちようが無いので null（StatedProvenance にしか speaker が無い）
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — speaker/subjectId（Issue #579 案D、ADR 0289） > consolidated は speaker を持ちようが無いので null
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — speaker/subjectId（Issue #579 案D、ADR 0289） > subjectId が在ればその値、null ならそのまま null、Memory 側で undefined でも null に揃える
 FAIL  src/__tests__/recall-pipeline.test.ts > recall() — speaker/subjectId（Issue #579 案D、ADR 0289） > 同伴取得（mandatory_companion）でも speaker/subjectId は対向の Memory 自身の値を名乗る
 FAIL  src/__tests__/recall.test.ts > RecalledMemorySchema — speaker/subjectId（Issue #579 案D、ADR 0289） > rejects speaker: 空文字列でも rejects ではなく accepts しない——number 等の異型は reject する
 FAIL  src/__tests__/recall.test.ts > RecalledMemorySchema — speaker/subjectId（Issue #579 案D、ADR 0289） > rejects subjectId が number（異型）
 FAIL  src/__tests__/recall-association.test.ts > recall() — 連想枠（association、既定 off） > 連想で拾った候補にも speaker/subjectId が在る（Issue #579 案D、ADR 0289。キーは常に在り、値は null になりうる）

 Test Files  2 failed (2)
      Tests  9 failed | 169 passed (178)
```

（対象を3ファイルまとめて実行すると `recall-association.test.ts` も加わり `2 failed (2)` の
表示は集計の都合で3ファイル中2ファイルに赤が乗ったことを示す。個別実行でも同じ9本が赤い
ことを確認済み。）

### 【実測】緑（実装後）

```
$ pnpm --filter @mnemora/core exec vitest run \
  src/__tests__/recall.test.ts src/__tests__/recall-pipeline.test.ts \
  src/__tests__/recall-association.test.ts src/__tests__/schema-type-equals-parity.test.ts
 Test Files  4 passed (4)
      Tests  183 passed (183)
```

（既存の完全一致スナップショット歯 `recall-channels.test.ts` の「②-a 全体の一致」が、
実装直後に赤くなった——ADR 0282 と同じ形。期待値リテラルへ `speaker: null, subjectId: null`
を足して緑に戻した。増えたのはこの2欄だけであることをリテラルで固定し直した。）

### 【実測】変異試験（`cp` で退避・復元。`git checkout` は使っていない。復元後に同じテストが
緑へ戻ることまで確認した）

| # | 変異 | 検出した歯 |
|---|---|---|
| (m1) | `speaker`/`subjectId` の両方を組み立て箇所から丸ごと省く | vitest 赤 7本 |
| (m2) | `subjectId` だけ省く（`speaker` は残す） | vitest 赤 3本 |
| (m3) | `?? null` を外し、`undefined` をそのまま渡しうる形にする（speaker/subjectId 両方） | vitest 赤 2本（`not.toBeUndefined()` の assert） |
| (m4) | interface と schema の両方を必須（`?` を外す）にする——「やりすぎ」 | vitest 赤 7本（後方互換の歯）／`tsc`（typecheck）赤（`recall-footprint.test.ts` の既存リテラルが型検査で落ちる）／`pnpm api:check` が差分ありとして検出し、破壊的変更かどうかの人間判断を要求した |
| (m5) | interface だけ必須にし、schema は任意のまま残す（型と schema の不一致） | `tsc`（typecheck）赤——`satisfies z.ZodType<RecalledMemory>` の行自体（`recall.ts:1184`）と `RecallResultSchema` の行（`:1715`）で `TS1360` が2件。vitest 自体は esbuild ベースで型を見ないため通ってしまう（型不一致は `tsc` でのみ検出される） |
| (m6) | `kind === "stated"` の判定を外し、`provenance` を kind に関わらず `speaker` という名で読もうとする——「やりすぎ」 | **当初は緑のまま残った**（他の `Provenance` 枝が今日 `speaker` という名の欄を持たないため、挙動が偶然一致していた）。⟹ 歯を1本足した（`kind !== 'stated' の provenance がたまたま speaker という名のプロパティを持っていても無視する`。型を迂回して構築した fixture で「将来どこかの枝が偶然 `speaker` という名を持ってもリークしない」ことを固定）。足した後は vitest 赤 1本で検出 |

**緑のまま残った変異は最終的に無かった**（m6 は歯を足して赤にした）。復元後、
`diff` で各ファイルが変異前と完全に一致することを確認し、同じテストが緑に戻ることも
実測した。

### 【実測】公開 API スナップショット

`pnpm run build` の後、`pnpm api:check` は以下を報告した（`@mnemora/core` のみが変わり、
他5パッケージは差分なし）:

```diff
 export interface RecalledMemory {
     ...
     provenanceKind: ProvenanceKind;
     score: ScoreBreakdown;
+    speaker?: string | null;
+    subjectId?: string | null;
 }
 export declare const RecalledMemorySchema: z.ZodObject<{
     ...
+    speaker: z.ZodOptional<z.ZodNullable<z.ZodString>>;
+    subjectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
 }, z.core.$strip>;
```

（`RecallResultSchema` に埋め込まれた同じ zod スキーマでも同じ2行が追加。）

🔴 **加えて、意図していない1件のリオーダー（追加でも削除でもない）が同じ snapshot 差分に
含まれる**——`NewMemorySchema` の zod shape 型で `tags`/`subjectId` の2行の出力順序が
入れ替わった（`tags` → `subjectId` だったのが `subjectId` → `tags` に）。【実測】
このファイル（`recall.ts`）を変更しない状態（`git stash`）でビルドすると `pnpm api:check`
は完全に緑（差分ゼロ）で、本 ADR の変更を戻すとリオーダーも消える——**この PR の変更に
再現性を持って連動している。**原因は `NewMemorySchema`（`packages/core/src/memory.ts:256`
`MemorySchema.omit({...})`）という `.omit()` チェーンの型で、`schema-type-equals-parity.test.ts`
の `_p50_NewMemory` が既に注記しているとおり、この種の交差型は `Equals`（型としての同一性）
を満たさず `MutualAssignable`（弱い相互代入可能性）でしか固定していない——**プロパティの
順序は元々この型の構造的な同一性の一部として扱われていない。**`tsc` の宣言ファイル出力が
同一コンパイル単位内の無関係な変更（本 PR は `recall.ts`/`recall-runtime.ts` だけを触った）
に応じて、この種の交差型のプロパティ出力順を変えることがある、という `.d.ts` 生成側の
挙動だと考えられる——**field の集合・型・必須性は1つも変わっていない**（`NewMemorySchema`
自体の意味は不変。値としての等価性・実行時の挙動は影響を受けない）。⟹ **これは
`RecalledMemory` への追加とは無関係の、snapshot 生成のノイズと判断した**（本 PR の
意図した差分ではない）。`pnpm run build` を経ての `pnpm api:write` は、この1行の
リオーダーも一緒に書き込む——分離する手段が無かったため、そのまま `git diff --stat` の
「1件の削除」として現れる。**この判断が誤りだと分かった場合（例えば実際に何らかの
意味を持つ変更だった場合）、追って訂正する。**

`pnpm run api:write` で snapshot を更新し、`pnpm run api:check` が緑に戻ることを確認した
（`git diff --stat scripts/__snapshots__/public-api/` = `core.d.ts | 8 ++++++-`、
内訳: 7行追加・1行削除。追加7行のうち6行が意図した `speaker`/`subjectId`。**削除1行は
上記のリオーダーに伴うものであり、実質的な削除ではない**——同じ行が2行上で位置を変えて
残っている）。

### 【実測】6つの門のうち5つ

```
$ pnpm run typecheck      → exit=0（7 workspace すべて Done）
$ pnpm run lint           → exit=0
$ pnpm run format:check   → exit=0
$ pnpm run build          → exit=0
$ pnpm api:check          → 緑（api:write 後）
$ pnpm run test           → exit=0
   （ルート門: 3/3 段が実行、DB テストは「実行していません」と告知——DATABASE_URL 未設定。ADR 0015）
   @mnemora/core: Test Files 68 passed (68) / Tests 1019 passed (1019)
```

---

## 参照

- [Issue #579](https://github.com/takecchi/mnemora/issues/579) — 本 ADR が実装する提案。⛔ close しない（射程節参照）
- [issuecomment-5753773066](https://github.com/takecchi/mnemora/issues/579#issuecomment-5753773066) — A は採らず C+D を推す当初調査。D を必須欄で提案し opt-in を退けた
- [issuecomment-5761322373](https://github.com/takecchi/mnemora/issues/579#issuecomment-5761322373) — 呼び出し側の回避が `{ seedMemoryId }` 経路では塞がらないことの実測
- [issuecomment-5811791086](https://github.com/takecchi/mnemora/issues/579#issuecomment-5811791086) — 案C を出さない決定・D を任意欄＋runtime保証に変えた決定。本 ADR の直接の出自
- [ADR 0035](./0035-recalled-memory-provenance-kind.md) — `provenanceKind` を必須欄で足した先例。決定3（optional 却下）に本 ADR が正面から答えている
- [ADR 0257](./0257-searched-and-found-nothing-versus-did-not-search.md) — 「探したが無かった」と「探していない」を分ける。本 ADR の runtime 保証がこの規律を守る形
- [ADR 0282](./0282-score-breakdown-affinity-measured.md) — `affinityMeasured?: boolean` を任意欄として非破壊に足した直接の先例。本 ADR の決定1〜4・引き受けた負債の形はこれを踏襲した
- [ADR 0178](./0178-public-api-surface-gate.md) — 「新しい任意プロパティの追加」を semver 的に安全と明記した根拠
- [ADR 0155](./0155-recall-score-breakdown-persisted.md) — `RecallRecordMemory` が「後から再現できないもの」だけを持つ設計。決定6 の根拠
- [ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md) — 本 ADR の決定・issuecomment がいずれも自動化された担い手のものであり、オーナー本人の決定ではないことの根拠
- `docs/migration-v1.md` — 破壊的変更の数え方（項目7・9・10）。「文脈」節・issuecomment-5811791086 の判断根拠
