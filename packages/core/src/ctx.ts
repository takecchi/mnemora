import { z } from "zod";

/**
 * すべての interface のメソッドが第一引数に取る呼び出しコンテキスト。
 *
 * `tenantId` は隔離境界（安全性の単位）、`subjectId` はテナント内の整理の単位。
 * この非対称性を混同しない（docs/vision.md 「Tenant と Subject を混同しない」）。
 *
 * mnemora はテナントの台帳を持たない。`tenantId` は呼び出し側が渡す不透明な文字列であり、
 * 存在確認・認証は行わない（docs/architecture.md §3.7）。
 *
 * ⚠ **識別子の長さに上限は約束しない**（[Issue #1074](https://github.com/takecchi/mnemora/issues/1074)）。
 * `tenantId`・`subjectId`（ここと `observe` の入力、Memory）・`observe` の `externalId`・Memory の
 * `tags` の要素は、schema が長さを検査しない。ただし `@mnemora/postgres` はこれらを btree / GIN の
 * 索引に入れるので、索引の1行（複合索引では同じ行のほかの欄との合計）が**圧縮後に**上限
 * （btree 2704 バイト、GIN 2712 バイト）を超えると、書き込みが例外になる
 * （`index row size … exceeds …`）。圧縮後の大きさで決まるので、上限は文字数でもバイト数でも
 * 一意に言えない——同じ文字の繰り返しは1万字でも通り、ランダムな値は約2.7KBで落ちる。
 * `@mnemora/testkit` の fixture はどの長さも受け入れる。**保証するのは、索引の1行が上の上限に
 * 収まる長さのときだけである。**長い外部の ID（URL の連結など）は、呼び出し側でハッシュなどに
 * 縮めてから渡すこと。
 *
 * ⚠ **識別子は正規化せず、完全一致で比べる**（今の振る舞い。2026-09-27 に `@mnemora/postgres` と
 * testkit の fixture の両方で実測し、結果は一致した）。`tenantId`・`subjectId`・`observe` の `externalId`・
 * `claimKey` の主語と述語・ラベル名・`tags` の要素は、大文字小文字（`Tenant` と `tenant`）、Unicode の
 * 正規化形（NFC の `café` と NFD の `café`）、全角半角、前後の空白（`a` と `a `）が違えば**別の値**として扱う。
 * `%`・`_`・`/`・`:` も普通の文字であり、`LIKE` や前方一致で別の識別子が混ざることは無い（`a%` は `ab` と、
 * `a:b` は `a` と一致しない）。同じものとして扱いたい表記の揺れは、呼び出し側で揃えてから渡すこと。
 *
 * ⚠ **空文字・空白だけの値も受け付ける**（今の振る舞い）。{@link CtxSchema} は `min(1)` を書いているが、
 * `Runtime` も同梱の store もこの schema で `ctx` を検査しないので、`tenantId: ""` や `subjectId: "   "` は
 * そのまま1つのテナント・主題として動く（`claimKey` の主語と述語・ラベル名・`tags` の要素も同じ）。
 * 例外は `observe` の `externalId` で、入力の schema が空文字を拒む（空白だけは受け付ける）。
 */
export interface Ctx {
  tenantId: string;
  subjectId?: string;
}

export const CtxSchema = z.object({
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).optional(),
}) satisfies z.ZodType<Ctx>;
