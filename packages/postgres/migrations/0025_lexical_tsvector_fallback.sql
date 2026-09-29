-- 0025_lexical_tsvector_fallback.sql
--
-- ADR 0364（Issue #1222）: 語の多い大きな本文で `to_tsvector('simple',
-- mnemora_lexical_normalize(content))` が `string is too long for tsvector`
-- （SQLSTATE 54000 `program_limit_exceeded`。tsvector の語彙バイト総和は
-- 1,048,575 バイトを超えられない、PostgreSQL の固定上限）で例外になり、
-- `idx_memories_lexical`（migrations/0008）への書き込みが失敗する。
-- observe() の LLM 失敗時の全文フォールバック（`@mnemora/core` の
-- `fallbackWholeObservationCandidate`）が「本文は1文字も落ちずに1件の
-- Memory として残る」と約束しているのに、`@mnemora/postgres` だけがこれを
-- 破る（docs/memory-model.md §4 の 2026-09-27 追記、`extraction.ts` の同日追記、
-- Issue #1222 が本 PR の作業者が本物の PostgreSQL 17.11 で実測）。
--
-- ## 何を変えるか
--
-- `mnemora_lexical_normalize`（0008）・`mnemora_lexical_query_terms`（0008）・
-- 0009/0023 の3関数は**一切変えない**。新しく足すのは `mnemora_lexical_tsvector(text)`
-- という plpgsql の IMMUTABLE 関数1つと、それを式に使うよう作り直す
-- `idx_memories_lexical` の1本だけである。
--
-- `mnemora_lexical_tsvector(content)` は、まず今までどおり
-- `to_tsvector('simple', mnemora_lexical_normalize(content))` を試す。これが
-- `program_limit_exceeded` で落ちたときだけ、本文の**先頭 150,000 文字**
-- （`left(content, 150000)`、文字数——バイト数ではない）で作り直して返す。
-- ⟹ ほとんどの本文（tsvector が1MBに収まる本文）は今と1バイトも違わない
-- tsvector を返す（下の「歯」節、実測で完全一致を縛っている）。1MBを超える
-- 本文だけが、先頭150,000文字だけを語彙検索の対象にする形へ縮退する
-- （全文は `memories.content` にそのまま残る——縮退するのは語彙**索引**だけ）。
--
-- ## なぜ「先頭 N 文字」か（切り詰め方式を選んだ理由、ADR 0364「検討した代替案」）
--
-- ADR 0364 に、採らなかった案（文字数で切る素朴な関数・strip()・切り詰め版を
-- 別関数として使い分ける案・入力そのものを拒む案）とその理由をまとめてある。
-- ここでは選んだ案の要点だけ書く: **150,000 は「実測で決めた安全な定数」**であり、
-- 「main が動けば変わる数」ではない（AGENTS.md「⚠ 数を、道具と生成物に焼き込まない」
-- の「⭐ 線は main が動くと変わるか」——この定数は動かない。ADR 0364「N の実測」に
-- 導出の全過程を残してある）。
--
-- ## なぜ150,000文字が安全か（要点。全過程は ADR 0364）
--
-- 本 PR の作業者が、この Postgres（17.11、`C.UTF-8`/UTF8、非 ICU）上で
-- コードポイント全域（`chr(1)`〜`chr(65535)`、サロゲートを除く BMP 全域と、
-- `chr(65536)`〜`chr(1114111)` の補助面全域）を尽くし、`to_tsvector('simple', ...)`
-- の大文字小文字畳み込みが1文字あたり何バイトへ膨らみうるかを実測した。
-- 膨らむ例外は2つだけ（`U+023A` Ⱥ → ⱥ、`U+023E` Ⱦ → ⱦ、どちらも2→3バイト、
-- 1.5倍）で、それ以外の全コードポイント（補助面の4バイト文字を含む）は比1以下
-- （膨らまない）。⟹ **1文字が tsvector の語彙バイトへ寄与する量は、どんな
-- コードポイントでも高々4バイトを超えない**（1バイト起源は1倍のまま1バイト、
-- 2バイト起源は最大1.5倍で3バイト、3・4バイト起源は1倍のまま3・4バイト——
-- いずれも4バイト以下）。`mnemora_lexical_normalize` は ASCII の連なりの前後に
-- 空白を足すだけで、非空白文字を増減も複製もしない。トークナイザの重複除去・
-- 2047バイトを超える語の破棄は、どちらも語彙バイト総和を**減らす方向にしか**
-- 働かない。⟹ `LEFT(content, N)` を通した tsvector の語彙バイト総和は、
-- **常に `4 × N` 以下**になる（測定不要の理論上限）。
--
-- `N = 150,000` なら理論上限は `600,000` バイトで、1,048,575 バイトの上限の
-- 57.2%（余裕 42.8%、448,575 バイト）に収まる。実測でも確かめてある——
-- 大文字小文字畳み込みで膨らむ文字（Ⱥ/Ⱦ）と補助面4バイト文字（CJK拡張B、
-- U+20000台）と ASCII 数字を混ぜた、重複の無い語からなる150,003文字の本文で
-- `to_tsvector` を実行し、例外なく成功し、実際の語彙バイト総和は257,148バイト
-- だった（理論上限の中に収まり、なお実際の上限より遥かに小さい——ADR 0364
-- 「N の実測」に生成方法とクエリを残してある）。
--
-- ## 二段目が失敗したら空の tsvector を返さない理由
--
-- 上の理論上限が示すとおり、`LEFT(content, 150000)` が `program_limit_exceeded`
-- を再び投げることは無い（`main` の実装が正しい限り）。**それでも二段目を
-- 更に `EXCEPTION` で包み、空の tsvector を返す形にはしていない**——起こらないと
-- 証明した経路を握り潰すと、その証明が将来のどこかで崩れたとき（Postgres の
-- 大文字小文字畳み込みの変更・別ロケールでの新しい膨張文字の発見等）に、
-- 静かに「検索に一切引っかからない Memory」を作ってしまい、気づく手段が
-- 無くなる。AGENTS.md「⚠ 機械には検出まで」の精神どおり、想定外はここでも
-- 例外として表に出す（＝ INSERT が失敗する、Issue #1222 の今の振る舞いへ戻る）
-- ほうを選んだ。ADR 0364「決定」に理由を残す。
--
-- ## SQLERRM を見る理由（`program_limit_exceeded` は tsvector 専用ではない）
--
-- SQLSTATE 54000（`program_limit_exceeded`）は「文字列が tsvector に長すぎる」
-- 以外の状況（別の内部上限）にも使われうる、粒度の粗いクラスである。この
-- 関数の役目は「tsvector が長すぎるときだけ」縮退することなので、メッセージに
-- 'too long for tsvector' が含まれないときは `RAISE`（再送出）して素通しする
-- ——見覚えの無い `program_limit_exceeded` まで飲み込んで縮退させない。
--
-- ## `SET search_path` を関数につける理由（plpgsql は式索引の中で inline されない）
--
-- 0008/0009 の `mnemora_lexical_normalize` 等は `LANGUAGE sql` の単文関数であり、
-- プランナが呼び出し元へ本体をインライン展開できる（展開後の式は `CREATE
-- FUNCTION` 時点で既に個々の名前を OID へ解決済みであり、以後の呼び出しの
-- search_path に依存しない）。この関数は例外処理を持つため `LANGUAGE plpgsql`
-- であり、plpgsql はインライン展開の対象にならない——呼び出しのたびに
-- 本体内の未修飾の名前（`mnemora_lexical_normalize`）を、そのときの search_path
-- で解決し直す。
--
-- **本 PR の作業者が実測**: `CREATE INDEX` が対象テーブルの既存行に対して
-- 式（この関数）を評価する経路は、session の search_path ではなく
-- `pg_catalog, pg_temp` という制限された search_path で実行される
-- （PostgreSQL が DDL 実行中の関数解決を制限する既知の安全策——search_path
-- 経由の関数差し替え攻撃を防ぐもので、CVE-2018-1058 の系譜。`RAISE NOTICE
-- current_setting('search_path')` を plpgsql 関数の中に仕込んで直接確認した）。
-- ⟹ 未修飾のまま `mnemora_lexical_normalize` を呼ぶ plpgsql 関数は、この索引を
-- `CREATE INDEX` する時点で「関数が無い」という例外になる（`--schema` 未指定・
-- `public` 1本の最小構成でも再現した）。
--
-- **関数の `SET search_path` config オプション**（session の search_path とは別に、
-- その関数の呼び出し中だけ有効になる、関数ごとの上書き）は、この制限された
-- search_path をも上書きする（実測）。⟹ この関数の呼び出し中は常に
-- `mnemora_lexical_normalize` を見つけられるスキーマを search_path に入れる。
--
-- **スキーマ名を migration ファイルに書き込めない**（`--schema` で任意の名前を
-- 選べる、ADR 0057）ため、`CREATE FUNCTION` 自体はスキーマ名を持たない静的な
-- 文のまま書き（`scripts/readme-postgres-objects-lib.mjs` が正規表現でこの文を
-- 拾えるようにするため——動的 DDL の文字列リテラルの中に埋めると拾えなくなる、
-- 同スクリプトの doc「動的 DDL に対する誤検出を防ぐ」節と同じ理由）、
-- `SET search_path` の値だけを別の `DO` ブロックで `current_schema()`
-- （`0022_embedding_zero_norm_index.sql` と同じ、`SET LOCAL search_path` 適用後の
-- 対象スキーマ）から動的に組み立てて `ALTER FUNCTION ... SET search_path = ...`
-- で後付けする。

CREATE FUNCTION mnemora_lexical_tsvector(content text) RETURNS tsvector AS $$
BEGIN
  RETURN to_tsvector('simple', mnemora_lexical_normalize(content));
EXCEPTION WHEN program_limit_exceeded THEN
  IF SQLERRM NOT LIKE '%too long for tsvector%' THEN
    RAISE;
  END IF;
  RETURN to_tsvector('simple', mnemora_lexical_normalize(left(content, 150000)));
END;
$$ LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE;

DO $$
BEGIN
  EXECUTE format(
    'ALTER FUNCTION mnemora_lexical_tsvector(text) SET search_path = %I',
    current_schema()
  );
END $$;

-- `idx_memories_lexical` を作り直す。列構成・`WHERE` は 0008 と1バイトも変えて
-- いない——式（左辺の第2要素）だけを `mnemora_lexical_tsvector(content)` に
-- 差し替える。`recall` 側（`lexical-store.ts`/`trigram-lexical-store.ts`）の
-- 全呼び出し箇所も、この commit で同じ式に揃えてある——索引式とクエリ述語の
-- 左辺がずれると索引が選ばれなくなる（0008「なぜ SQL 関数として切り出すか」
-- と同じ理由）。
--
-- ⚠ 素の `DROP INDEX` + 素の `CREATE INDEX`（`CONCURRENTLY` 無し）。0008 と同じ
-- 理由（`migrate.ts` の `runMigrations` が1ファイル=1トランザクションで包むため
-- `CONCURRENTLY` は使えない）。`DROP INDEX` は一瞬で終わるが、続く `CREATE INDEX`
-- は対象テーブル全体を読み直すため、`memories` への読み書きを止める
-- `ACCESS EXCLUSIVE` ロックを、索引の再構築が終わるまで持ち続ける。行数と
-- 掛かる時間の実測は ADR 0364「実測」節（10万行で約X秒）。行数が多い本番へ
-- 適用するときはこの停止時間を見込むこと（0008 と同じ留保）。
DROP INDEX idx_memories_lexical;

CREATE INDEX idx_memories_lexical
  ON memories USING gin (tenant_id, mnemora_lexical_tsvector(content))
  WHERE status IN ('active', 'contested');
