# ADR 0400: 外部キーの索引は、固定表ではなく `pg_constraint` から数え上げる歯で縛る——`memory_labels.label_id` の漏れを足す

- **状態**: 採用 (2026-09)

- **文脈**:

  [ADR 0383](./0383-erase-tenant.md)（`0027_erase_tenant_fk_indexes.sql`）は、親の行を消すときの
  参照整合性（RI）検査 `WHERE <fk列> = $1` が子表を全走査しないよう、外部キーの列に索引を足した。
  その歯（`erase-tenant-fk-indexes.postgres.test.ts`）は**索引名の固定表**を持つ。
  固定表は「書いた索引が在る」ことしか言えず、**次に外部キーを足したときに気づけない**。
  実際、`memory_labels.label_id REFERENCES labels(id)`（`0020_taxonomy_labels.sql`）は 0027 の
  数え損ねで、既存の `idx_memory_labels_by_label` は `(tenant_id, label_id)` と `label_id` が
  2列目のため RI 検査に効かなかった。`eraseTenant` が `labels` を消すとき、調査担当の実測で
  `memory_labels` 20万行につき 46ms（索引なし）→ 6.5ms（索引あり）。手元の再測（PostgreSQL 17、
  20万行、参照されない `labels` 50行を1トランザクションで DELETE、3回）は約 12〜16ms → 約 2ms。

- **決めたこと**:

  1. **`0031_memory_labels_label_id_index.sql` で `idx_memory_labels_label_id ON memory_labels (label_id)` を足す。**
     `CONCURRENTLY` は使えない（`migrate.ts` が各ファイルを1トランザクションで包む）。0027・0028 と同じく
     構築中は書き込みが止まる。
  2. **一般形の歯 `foreign-key-indexes-general.postgres.test.ts` を足す。** `pg_constraint`（`contype='f'`）から
     public スキーマの全外部キーを数え上げ、子表に「先頭 n 列（n = FK の列数）の集合が FK 列の集合と
     一致する」索引が無いものを赤にする。複数列 FK は順序を問わない（RI 検査は等値条件の AND なので、
     先頭 n 列が同じ集合なら効く）。動的に作られる埋め込み空間の表も public に在れば数える。
     migration の本数にも索引名にも触れない。
  3. **部分索引は「在る」と見なす。** `memories.contested_with_id` の `idx_memories_contested_with`
     （`WHERE contested_with_id IS NOT NULL`）が該当する。RI 検査の `= $1` は NULL と等しくならず、
     述語 `IS NOT NULL` を含意するので、プランナは部分索引を使える。「部分索引は使えないかもしれない」
     という理由で既存の設計を赤にすると、0004 の判断を覆すことになる。
  4. **式索引の列（`indkey = 0`）と、無効な索引（`indisvalid = false`）は数えない。** 式は FK 列そのものでは
     ないので `= $1` の検査に使えない。無効な索引（`CREATE INDEX CONCURRENTLY` の失敗の残骸など）は
     プランナが使わない。どちらも「在る」と数えると偽の緑になる。
  5. **例外は `EXEMPT` に `"<子表>.<制約名>"` → 理由で名指しで書く。黙って除外しない。** 加えて、
     `EXEMPT` の各項目が**実在する外部キーを指し、理由が空でない**ことも検査する（外部キーが
     消えたり改名されたりしたあとに死んだ例外が残ると、次に同名の FK が現れたとき黙って免除される）。
     今回は例外なし（`EXEMPT` は空）。
  6. **0027 の歯は残す。** 役割が違う。一般形の歯は「先頭列が合う索引が在るか」だけを見る。0027 の歯は
     0027 が約束した**個々の索引（名前付き）と、`memories.contested_with_id` には新しい索引を足さない
     こと、埋め込み空間の表への `registerEmbeddingSpace` 経由の索引**という、名指しの約束を縛る。
     一般形に置き換えると、索引が別名・別形に変わっても緑のまま通るが、0027 の意図（この名前の索引が
     在ること）を縛る手段が失われる。
  7. **0027 の固定表には `label_id` の索引を足さない。** 固定表は「0027 が作った索引」の表であり、
     `idx_memory_labels_label_id` は 0031 の索引である。足すと「0027 が作った」という歯の説明が
     偽になる。0031 の索引の存在は一般形の歯が縛る。

- **引き受けた負債**:

  - 一般形の歯は「先頭列が合う索引が在る」ことしか言わない。その索引が実際にプランに使われるか
    （統計・行数による Seq Scan の選択）は見ていない。
  - 複数列 FK の判定は、先頭 n 列の集合の一致であり、索引の演算子クラスや照合順序（`= $1` に使えるか）
    までは見ていない。今の public スキーマに複数列 FK は無い。

- **これが覆るとしたら**:

  - 部分索引を「在る」とする扱いは、述語が `IS NOT NULL` 以外（RI 検査の `= $1` を含意しない述語）の
    部分索引が FK 列に付いたとき見直す。その場合、歯は述語の中身まで見る必要がある。
  - 外部キーを持つスキーマが public 以外に増えたら、`nspname` の絞り込みを広げる。

- **検討した代替案**:

  - **0027 の固定表に行を足すだけ**: 今回の漏れは直るが、次の外部キーで同じ漏れが起きる。棄却。
  - **0027 の歯を一般形に置き換える**: 決定6のとおり、名指しの約束を縛る手段が失われる。棄却。
  - **部分索引を「無い」と見なす**: 既存の `idx_memories_contested_with` を赤にするため、
    例外の登録か再設計が要る。RI 検査は部分索引を使えるので、棄却。

- **確かめたこと（赤の証拠）**: 歯だけを入れた commit `2e38d0f`（0031 なし）で、
  `foreign-key-indexes-general.postgres.test.ts` は `memory_labels.memory_labels_label_id_fkey` の
  1件だけが赤になった（他の外部キーは赤にならず、例外も要らなかった）。0031 を足すと緑になる。
