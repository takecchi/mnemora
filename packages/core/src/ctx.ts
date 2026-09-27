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
 */
export interface Ctx {
  tenantId: string;
  subjectId?: string;
}

export const CtxSchema = z.object({
  tenantId: z.string().min(1),
  subjectId: z.string().min(1).optional(),
}) satisfies z.ZodType<Ctx>;
