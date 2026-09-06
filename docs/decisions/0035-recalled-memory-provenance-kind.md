# ADR 0035: `recall()` の返り値に `provenanceKind` を載せる — 「区別して返す」を、返り値の側で満たす

- **状態**: 採用 (2026-09)
- **日付**: 2026-09-06

**⚠ この文書の各主張には出所を付ける。**「私が実行して確かめた」と「読んだだけ」を分ける
（[AGENTS.md](../../AGENTS.md)「確かめていないことは『確かめていない』と書く」）。

---

## 文脈

**これは新しい設計判断ではなく、正典と実装の食い違いを実装側で直したものである。**

[docs/memory-model.md](../memory-model.md) §2 は、`provenance_kind` を jsonb ではなく**列**に
上げた理由を、こう書いていた（逐語）:

> 列にする理由は二つしかない。**フィルタと索引。** recall がデフォルトで `stated` と `inferred` を
> **区別して返す**、あるいは呼び出し側が推論を除外するオプションを使う、といった操作は SQL の
> `WHERE provenance_kind = ...` で済ませたい。

**⟹ 「区別して返す」は最初から設計に書かれていた。列も最初から在った。**
**だが `RecalledMemory`（`packages/core/src/recall.ts`）には `provenance` が無く、
`recall()` の返り値だけでは `stated` と `inferred` を区別できなかった。**
[docs/recall.md](../recall.md) §7 のほうは「Memory 本体（内容・provenance・状態）の詳細な型は
`memory-model.md` に譲る」と書いており、**2つの docs が食い違っていた。**

**そして 2026-09-06、オーナーが [roadmap.md](../roadmap.md) §5.5 に条件付きで答えた**
（マネージャー経由で伝達された。**私が直接受け取ったものではない**）:

> **含める。ただし `provenance.kind` で区別して返す**

**⟹ 「ただし」が付いている。前半（既定で含める）は満たされていたが、後半は満たされていなかった。**

---

## 決定

1. **`RecalledMemory` に `provenanceKind: ProvenanceKind` を足す。**
2. **🔴 `kind` だけを、平らな欄として持つ。`provenance` 全体は返さない。**
   オーナーが求めたのは**区別**であって中身の追加ではない。`provenance: Provenance` という形に
   すると、`model` / `promptVersion` / `basis` / `confidence` が毎回の返り値に載り、
   **北極星の問い1（毎回渡す量を減らす方向に働くか）に逆行する。**
   欄名を `provenanceKind` と平らにしてあるのは、**「そのうち `basis` も足そう」という圧力が
   構造的に掛からない形にするため**でもある（`provenance: { kind }` という入れ子にすると、
   欄を足す先が既に在ることになる）。既にある `RecallQuery.excludeProvenanceKinds` と
   語彙も揃う。
3. **🔴 必須の欄にする。省略可能にしない。**
   省略可能にすると、**書き忘れた経路が「未指定」という既定値の顔で通る。**
   必須にすれば型検査が組み立て箇所を全部指す（実際に指した。§1）。
   **zod schema（`RecalledMemorySchema`）でも必須にする**——型は HTTP・JSON の境界の外では
   効かないので、片方だけでは欄が抜けたまま通る経路が残る。
4. **値はリテラルで書かず、その Memory 自身の `provenance.kind` から引き継ぐ。**
   `recall-runtime.ts` は `provenanceKind: member.memory.provenance.kind` と書く。
   出どころが将来変わったら名乗りも一緒に変わる——**`countKind: 'exact'` がリテラル固定のまま
   出どころだけ `hnsw.ef_search` 依存に変わって嘘になった件（[ADR 0011](./0011-no-window-count-in-ann-stage.md)）
   の裏返しである。**
5. **`ProvenanceKind` の綴りを `provenance.ts` の `ProvenanceKindSchema` に1本化する。**
   同じ5値の列挙が `RecallQuerySchema.excludeProvenanceKinds` に手で複製されていた。

---

## 1. 数えたこと（実測。**私が実行した**）

**組み立てている経路を全部数えてから足した**（欄を1つ足すと、埋め忘れた経路が
「既定値の顔で嘘をつく」ため）。

| 何 | 件数 | どこ |
|---|---|---|
| **`RecalledMemory` を組み立てている本番の箇所** | **1** | `recall-runtime.ts` の段4の後（`finalMemories`） |
| その1箇所へ入る `ScoredCandidate` の生成箇所 | **2** | ANN 経由（`:220`）と `mandatory_companion`（`:291`）。**どちらも `memory: Memory` を丸ごと持つ**ので `provenance` は必ず在る |
| `RecalledMemory` 形のリテラルを作っているテスト | **2** | `examples/chat/src/__tests__/{mnemora-path,retrieval-quality-score}.test.ts` |

**⟹ 欄を必須にしたことで、型検査がこの2件のテストを正確に指した**（`error TS2741:
Property 'provenanceKind' is missing`）。**数え漏らしが在れば型検査が落ちる、という形にしてある。**

**⚠ `retrievedVia` は `'ann' | 'tag_match' | 'recency' | 'mandatory_companion'` の4値を
型で許すが、実装が作るのは2値だけである**（上の表のとおり）。これは本 ADR の対象外だが、
**数えた結果として記録しておく。**

---

## 2. 北極星への影響（実測。**私が実行した**）

**欄が1つ増えると、想起1件あたりの文字数が増えるのではないか**——という問いに、数字で答える。

### 2.1 「毎回プロンプトへ積む量」は**1文字も動かない**

`compare`（擬似 provider・本物の PostgreSQL 17.9 + pgvector 0.8.2）を、
**同じ DB に対して足す前と足した後で1回ずつ**走らせ、出力表を `diff` した。

```
$ diff /tmp/compare-before.txt /tmp/compare-after.txt
（差分なし）
```

**12行すべて（会話2〜642ターン）で `mnemora chars` も `mnemora tokens` も同一。**

理由は `recall-runtime.ts` の usage 計算にある——`chars = Σ memories[].digest.length +
JSON.stringify(indexBand).length` であり、**`RecalledMemory` を丸ごとシリアライズしてはいない。**
`provenanceKind` は `score` / `retrievedVia` / `companionOf` と同じ**付加情報**の側であり、
digest tier には入らない。**この不変条件には歯を置いた**（`recall-pipeline.test.ts`
「usage は provenanceKind を数に入れない」）。

### 2.2 「返り値の JSON」は **1件あたり +26文字**増える（実測）

正直に両方書く。擬似 provider・80往復の会話・既定 `limit`（10件）で測った:

|  | 文字数 |
|---|---|
| `JSON.stringify(result.memories)`（足す前） | 2,568 |
| 同（足した後） | 2,828 |
| **差** | **+260（1件あたり +26）** |
| `usage.chars` | **301（`byTier.digest` 190 + `indexChars` 111）。足す前後で同じ** |

`+26` は `"provenanceKind":"stated",` の長さである（`"inferred"` なら +28、
`"consolidated"` なら +32）。

**⟹ 線として: プロンプトへ積む量は動かない。HTTP の payload は 1件あたり26文字ほど太る。**
**この2つを混同しないこと。**Phase 4 の `packages/server` で効くのは後者である。

---

## 3. 検討して採らなかった案

- **`provenance: Provenance` を丸ごと返す。** 却下。オーナーが求めたのは**区別**であり、
  中身の追加ではない。`inferred` の provenance は `model` / `promptVersion` /
  `basis.{memoryIds,observationIds}` / `confidence` を持ち、**1件あたり100文字を超える。**
  10件返せば1KBを超え、問い1に逆行する。
- **`provenance: { kind }` と入れ子にする。** 却下。**欄を足す先が既に在る形になる。**
  平らな `provenanceKind` なら、中身を足すには型の形そのものを変えることになり、
  そのときに改めて判断が要る。
- **省略可能（`provenanceKind?`）にする。** 却下。決定3のとおり。
- **`confidence` も一緒に返す**（`inferred` をどれだけ信じるかは呼び出し側が決めたい）。
  **却下（今回は）。**オーナーの条件は `kind` までである。**必要だと分かってから足す。
  「そのうち要る」で型を広げない**（[ADR 0024](./0024-remove-exact-counts-option.md)）。
- **`Memory` 本体を返す。** 却下。`docs/recall.md` §1 の「digest 帯」という設計そのものを壊す。

---

## 4. 引き受ける負債・覆えていない範囲

- **マイグレーションは要らなかった**（`memories.provenance` jsonb と `provenance_kind` 列は
  どちらも `0001_init.sql` から在る）。**確認した。**
- **`provenance_kind` 列と `provenance` jsonb の `kind` が食い違ったとき、`recall()` は
  jsonb 側を名乗る。**`PostgresMemoryStore` は両方を同じ式（`input.provenance.kind`）から
  書いているので、いまは食い違わない。**食い違いを検出する仕組みは無い。塞いでいない。**
- **`retrievedVia` が型で4値・実装で2値である非対称**（§1）。本 ADR では直していない。
- **`compare` の実測は擬似 provider で取った。**本物の provider では走らせていない
  （量の比較には擬似で足り、本物では費用が掛かるため）。**usage の計算式は provider に
  依らないので、この測り方で足りると判断した。⚠ これは判断であって、本物での実測ではない。**

## 5. これが覆るとしたら

- **オーナーが `confidence` まで返せと言ったとき。**そのときは §3 の却下を見直す。
- **Phase 2 で `consolidated` / `reflected` が実際に作られるようになったとき。**
  いまリポジトリが作る provenance は `stated` / `inferred` / `imported` の3種類だけであり、
  残る2値は型と CHECK 制約にしか存在しない。
- **`docs/recall.md` §7 の「Memory 本体の詳細は memory-model.md に譲る」という線を
  もう一度動かしたくなったとき。**本 ADR はその線を `kind` の1歩だけ動かした。
  **次に動かしたくなったら、それは「digest 帯」という設計そのものへの問いである。**
