# ADR 0476: 穴探し47巡目 — 同じ語彙を逆の並びで `tags` に持つ記憶を同時に作ると、`labels` の行ロックが循環待ちになる（40P01）のを直す。taxonomy の経路で当てた形の記録

- **状態**: 採用 (2026-10)
- **日付**: 2026-10-02

クローン miku の委譲先（担い手。マネージャー mgr-3a4ae979 の指示による）が書いた。直す線（約束に実装を戻す・落ちる入力を減らす・前例のある同種の穴は直す。新しく断る入力・既定値や公開の型の変更は材料に回す）は依頼主が決めた。オーナーの判断ではない（[ADR 0220](./0220-issue-comment-author-does-not-distinguish-owner-from-agent.md)）。
出所の区別: 【現物】は読んだコード・文書、【実測】は手元で走らせた結果、【判断】は担い手の判定、【未確認】は確かめていないこと。

- **文脈**: 47巡目の面は taxonomy の経路（`TenantSettingsStore` の taxonomy のモード、`registerLabel`・`upsertProposedLabels`、抽出が記憶にラベルを付ける経路、`listLabels` の並び、`recall` の `labels` の絞り）。ADR 0318・0323・0375・0443 と `docs/memory-model.md` §8 の追記が、名前の完全一致・空白・長い名前・NUL・一方向の状態・purge を既に書いている。それを先に読み、書いていない形（書き込みの並行）を当てた。

- **穴（直す前）**【実測】:
  - `PostgresMemoryStore.upsertProposedLabels`（`createMemory`・`createMemoryWithOutbox`・`supersedeWithNewMemories` が、新しい行を作ったトランザクションの中で呼ぶ）は、`tags` の重複を `Set` で潰したあと、**`tags` の並びのまま**`labels` を1行ずつ `INSERT … ON CONFLICT DO UPDATE` する。この文は既存の行に行ロックを取る。
  - `tags` は LLM が返した並びのまま保存される（並べ替えない。ADR 0318・`dropBlankTags`）。別々の `observe()` が同じ語彙を違う順で返すと、片方が `a`→`b`、もう片方が `b`→`a` の順でロックを取り合い、Postgres が `deadlock detected`（40P01）で片方を落とす。本文が正しくても、生の例外で `createMemory` が失敗する。
  - 実測（同じ接続プール、新しいテナント、`tags: ["a","b","c","d"]` と `["d","c","b","a"]` を交互に持つ6件を `Promise.all` で作る。6ラウンド = 36件）:

    | 実装 | 落ちた件数 | 例外 |
    |---|---|---|
    | 直す前 | 25 / 36 | `deadlock detected`（`INSERT INTO labels …` の `Failed query`） |
    | 直した後 | 0 / 36（3回の実行） | — |

  - InMemory（testkit）は同期区間で完結するので、この穴を持たない【現物】。

- **決定**（線の内側。公開の型・既定値・保存済みのデータは変えていない）:
  1. **`upsertProposedLabels` は、`labels` を触る順を名前の順（`Array.prototype.sort()` の既定）に固定する。** ロックを取る順がどの呼び出しでも同じになるので、1回の作成どうしの循環待ちが構造的に起きない（`markContestedPair` が行ロックを id 昇順で取るのと同じ形）。`Memory.tags` の並び・重複、`proposedCount` の数え方、`memory_labels` の中身は変えない。落ちる入力は減るだけで、新しく断る入力は無い。DB のマイグレーションは無い。

- **歯**:
  - `packages/postgres/src/__tests__/label-upsert-lock-order.postgres.test.ts`（2本）。1本目が上の実測（36件が全部成功し、`proposedCount` が4語とも6に揃う）、2本目は `Memory.tags` が `["d","a","d","b"]` のまま保存され、`listLabels` が `a`・`b`・`d` を1ずつ返すこと。
  - 変異: 直す前の1行（`.sort()` なし）を `cp` で戻すと1本目が赤（deadlock）、直した版に戻すと緑。

- **当てた形の一覧**（見つからなかった形は、陽性対照と一緒に書く）:

  | 形 | 入力・コマンド | 結果 |
  |---|---|---|
  | 長い名前（ラベル・tag） | 圧縮の効かない 100・2000・2700・3000・10000 文字を `createMemory` の tag と `registerLabel` の名前に（Postgres・InMemory） | InMemory は全部通る。Postgres は 2000 まで通り、2700 以上は `createMemory`・`registerLabel` とも例外（索引の1行の上限）。繰り返しの `x` は 10000 でも通る（圧縮）。**既知**（ADR 0443・`registerLabel?` の doc） |
  | 空・空白・大文字小文字・前後の空白の名前 | `registerLabel` に `""`・`" "`・`" a "`・`"A"`・`"a"` | 両実装とも別々の `registered` の行になる（doc の「検査しない」のとおり） |
  | recall の `labels` と記号を含む名前 | 26個の名前（`a,b`・`{x}`・`q"r`・`back\slash`・`NULL`・`null`・`%`・`_`・`it's`・NFC/NFD の `é`・`İ`・`ß`・`SS`・ゼロ幅空白・絵文字・`:*`・`a & b`・`{}`・`{"}`・空白1つ など）を1つずつ `tags` に持つ記憶を作り、`labels: [その名前]`・`taxonomyGroups: true` で ann + lexical の recall（Postgres、open と strict〔全部 `registerLabel` 済み〕） | 52本全部、その名前の記憶だけが1件返り、`axis: 'taxonomy'` の群は1件・`count: 1`。陽性対照はこの形そのもの（名前を取り違えれば `got` が1件でなくなる）。探り棒は commit していない |
  | モードの切り替え・strict の絞り | 既存の歯（`recall-taxonomy-strict.postgres.test.ts` ほか）を読んだ範囲 | 走らせた既存の歯は PR の本文に書いた |

- **検討した代替案**:
  1. **`labels` の行を先に `SELECT … FOR UPDATE` で名前順に取る。** 採らなかった。新しい行は `FOR UPDATE` で取れず、結局 `INSERT … ON CONFLICT` の順の話に戻る。並べ替えは1行で足りる。
  2. **`upsertProposedLabels` を、1文の `INSERT … SELECT unnest(…) ORDER BY name … ON CONFLICT` にする。** 採らなかった。1文でもロックを取る順は `ORDER BY` に依存し、文の形を大きく変える。保存済みの `memory_labels` の作り方まで触る。
  3. **deadlock を捕まえて再試行する。** 採らなかった。再試行の方針（回数・待ち）は、`MemoryStore` 全体の方針になる。原因が並びだけなので、原因を消すほうを採った。

- **引き受けた負債（材料）**:

  | # | 負債 | 再現 | 結果 | 緊急度 | 覆る条件 |
  |---|---|---|---|---|---|
  | 1 | `supersedeWithNewMemories` の `news` が複数あると、トランザクションの中で記憶ごとに `upsertProposedLabels` を呼ぶ。記憶ごとの中では名前順になるが、記憶をまたぐと呼び出しをまたいだ順は揃わない | 例: 呼び出し1が `news: [{tags:["a"]},{tags:["b"]}]`、呼び出し2が `[{tags:["b"]},{tags:["a"]}]`。**走らせていない**【未確認】 | 同じ形の循環待ちが残りうる | 低（1つの訂正で複数の新しい記憶を作る呼び出しが、同時に同じ語彙を逆順で使う必要がある） | 全部の記憶の語彙を集めて名前順に先に取る形にするとき（文の形が変わる） |
  | 2 | `purgeMemory`・`scrubPurged` の `UPDATE labels … FROM counted` は、複数行を更新する順が決まっていない。作成と同時に走ると別の順になりうる | **走らせていない**【未確認】 | deadlock の可能性 | 低〜中（purge と作成が同じ語彙を同時に触る必要がある） | 実測で再現したとき |
  | 3 | 長い `tags`・ラベル名で、Postgres だけが例外になり InMemory は通る（`registerLabel` も同じ） | 上の表 | testkit と Postgres の食い違い。**文書は既にある**（ADR 0443・`registerLabel?` の doc） | 低 | 長さの上限を決めるとき（新しく断る入力。オーナーの領分） |

- **これが覆るとしたら**: 並行して作る側の語彙を、呼び手が1回の呼び出しにまとめる設計（バッチの作成口）になったとき。

- **測っていないこと**: 上の負債1・2。`labels` 以外の表（`memory_labels`・`tenant_activity`・`tenant_subject_activity`）の行ロックの順。接続数がプールの上限を超えるときの待ち。`registerLabel` どうし・`registerLabel` と作成の同時実行（1行だけを触るので循環は起きないと読んだが、走らせていない）。
