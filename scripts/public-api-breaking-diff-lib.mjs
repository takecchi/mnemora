/**
 * `scripts/public-api-breaking-diff.mjs`（Issue #818 / #811 / #813 / #815）が使う純関数群。
 *
 * **これは何をする道具か**: 2つの時点（既定は `v1.0.0` と作業ツリー）の公開 API snapshot
 * （`scripts/__snapshots__/public-api/<pkg>.d.ts`、ADR 0178 の門が既に維持しているもの）を
 * TypeScript の compiler API で構文解析し、**構造的に**次の5つの形を検出する:
 *
 * 1. 既存の interface/型リテラルに必須メンバー（`?` 無し）が足された
 * 2. 既存メンバーが任意から必須になった
 * 3. export が消えた／名前が変わった（消えたものとして出す。同じ形の新規 export が
 *    見つかれば改名の推定を併記する）
 * 4. 関数/メソッド/コンストラクタの必須引数が増えた
 * 5. 出力側の union（文字列/数値リテラルだけからなる）に値が増えた
 *    （入力側で広がるのは非破壊。入力/出力の判定は保守的な到達性ヒューリスティックで行い、
 *    決め切れないものは「要人判断」に落とす）
 *
 * **正規表現では組んでいない**——`typescript`（ルート devDependency）の parser で AST を作り、
 * `ts.forEachChild` で辿る。`scripts/public-api-surface-lib.mjs`（ADR 0178）と同じ道具立てだが、
 * あちらは「変わったか」だけを見る全文 diff であり、こちらは「どう壊れるか」を分類する——
 * 別の関心事なので、あちらの関数は import せず、この対象に要る分だけをここで独立に実装する。
 *
 * ## ⛔ この歯（今回はまだ歯ではないが）が構造的に取りこぼす形（意図した射程外）
 *
 * - **メンバーの削除・改名**（interface/型リテラル単位）。歴史上の実例:
 *   `docs/migration-v1.md` 項目2（`NewRecallRecord.returnedMemoryIds` →
 *   `returnedMemories`）。この形は「消えた」と「増えた」を人が同一視できて初めて
 *   「改名」と読めるものであり、この道具は export（トップレベル宣言）単位の改名推定
 *   （下記3）しか行わない。
 * - **必須引数の「個数」が変わらない、型だけの変更**。歴史上の実例:
 *   `docs/migration-v1.md` 項目8（`setDefaultHalfLifeRecalls` が同じ2引数のまま
 *   `(tenantId: string, recalls: number): void` → `(ctx: Ctx, recalls: number): Promise<void>`
 *   に変わった）。個数が同じなので4番の検出に掛からない。
 * - **クラスに必須ではない新規メンバーが足されたこと自体**（クラスへのメンバー追加は、
 *   `new Foo()` で呼ぶ側もサブクラス化していない側も壊さない——interface の必須メンバー
 *   追加とは壊れ方が違うため、1番はクラスには適用しない。ただしクラスの
 *   コンストラクタ／public メソッドの必須引数増加は4番として検出する）。
 * - **リテラルでない union（`Foo | null` 等）の拡張**。文字列/数値リテラルだけからなる
 *   union だけを5番の対象にする。
 * - **型に現れない、実行時の意味変更**（新しく `throw` するようになった等）。歴史上の実例:
 *   `docs/migration-v1.md` 項目18、および `#811`/`#813`/`#815`（`packages/testkit` の
 *   in-memory Fake が `limit` の負数/NaN/Infinity/非整数や `recalls` の float4 溢れを
 *   新たに拒むようになった）——公開 API の型シグネチャは1バイトも変わっていない
 *   （`git diff --stat <before>..<after> -- scripts/__snapshots__/public-api/` は空）。
 *   ⟹ **この道具の入力（snapshot の `.d.ts` テキスト）そのものにこの種の変更が
 *   現れないので、原理的に検出できない。**
 * - **`bin` エントリ**。snapshot 自体が `exports.*.types` から辿れるものだけを含む
 *   （ADR 0178「決定」）ので、この道具もその範囲を継ぐ。
 *
 * ⚠ **この一覧は判定ではなく候補である**（`docs/decisions/0214-release-candidates-lists-not-judges.md`
 * と同じ形）。**「これで全部」とは名乗らない**——取りこぼす側の実例を上に焼いてある
 * （AGENTS.md「⚠ 名乗れないものを道具に名乗らせない」）。
 */
import ts from "typescript";

/** `.d.ts`（または snapshot の連結テキスト）を TypeScript の parser で `SourceFile` にする。 */
export function parseSnapshotSource(text, virtualFileName = "snapshot.d.ts") {
  return ts.createSourceFile(virtualFileName, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function hasExportModifier(node) {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

function hasPrivateModifier(node) {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return !!modifiers?.some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
}

/**
 * トップレベルの export 宣言を名前→ノードの Map で返す。
 *
 * 拾う形: `export interface` / `export type` / `export declare class` /
 * `export declare function` / `export declare const` / `export declare enum`。
 * `import` 文・`export * from` / `export { x } from` のような再 export 文は拾わない
 * （`scripts/public-api-surface-lib.mjs` の BFS が既に「宣言そのもの」だけを
 * snapshot に集めているため、実際の snapshot にこの形はほぼ現れない）。
 *
 * 同名が複数回宣言されることは想定していない（snapshot はビルド後の実物であり、
 * TypeScript 自身が名前の衝突を許さない）。
 */
export function collectTopLevelExports(sourceFile) {
  /** @type {Map<string, { kind: string, node: ts.Node }>} */
  const result = new Map();
  for (const stmt of sourceFile.statements) {
    if (!hasExportModifier(stmt)) continue;
    if (ts.isInterfaceDeclaration(stmt)) {
      result.set(stmt.name.text, { kind: "interface", node: stmt });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      result.set(stmt.name.text, { kind: "typeAlias", node: stmt });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      result.set(stmt.name.text, { kind: "class", node: stmt });
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      result.set(stmt.name.text, { kind: "function", node: stmt });
    } else if (ts.isEnumDeclaration(stmt)) {
      result.set(stmt.name.text, { kind: "enum", node: stmt });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          result.set(decl.name.text, { kind: "const", node: decl });
        }
      }
    }
  }
  return result;
}

function countRequiredParams(params) {
  let count = 0;
  for (const p of params) {
    if (p.questionToken || p.initializer || p.dotDotDotToken) continue;
    count++;
  }
  return count;
}

/**
 * interface / class / (type-literal を経由した) type alias の「メンバー」を
 * 名前→形（`optional`・呼び出し可能なら `requiredParamCount`）の Map にする。
 *
 * - `interface`: 全メンバー。
 * - `class`: `private` 修飾子を持たないメンバーだけ（公開契約ではないため）。
 *   コンストラクタは特別なキー `"(constructor)"` として扱う。
 * - `typeAlias`: 型が `TypeLiteralNode` ならその members。`IntersectionTypeNode` なら、
 *   構成要素のうち `TypeLiteralNode` である部分のメンバーだけを拾う（`Omit<X, ...>` の
 *   ような utility type 部分は展開しない——ADR 0178 の BFS と同じく、複雑な型演算までは
 *   追わない設計）。それ以外（union・utility type 単体等）は `null` を返す。
 *
 * @returns {Map<string, { optional: boolean, requiredParamCount: number|null }> | null}
 */
export function extractContainerMembers(entry) {
  const { kind, node } = entry;
  /** @type {ts.NodeArray<ts.TypeElement> | ts.NodeArray<ts.ClassElement>} */
  let members;
  if (kind === "interface" || kind === "class") {
    members = node.members;
  } else if (kind === "typeAlias") {
    const t = node.type;
    if (ts.isTypeLiteralNode(t)) {
      members = t.members;
    } else if (ts.isIntersectionTypeNode(t)) {
      const literalParts = t.types.filter((part) => ts.isTypeLiteralNode(part));
      if (literalParts.length === 0) return null;
      members = literalParts.flatMap((part) => [...part.members]);
    } else {
      return null;
    }
  } else {
    return null;
  }

  const map = new Map();
  for (const m of members) {
    if (hasPrivateModifier(m)) continue;
    if (ts.isConstructorDeclaration(m)) {
      map.set("(constructor)", {
        optional: false,
        requiredParamCount: countRequiredParams(m.parameters),
      });
      continue;
    }
    if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
      if (!m.name || !ts.isIdentifier(m.name)) continue;
      map.set(m.name.text, {
        optional: !!m.questionToken,
        requiredParamCount: countRequiredParams(m.parameters),
      });
      continue;
    }
    if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
      if (!m.name || !ts.isIdentifier(m.name)) continue;
      const fnType = m.type && ts.isFunctionTypeNode(m.type) ? m.type : null;
      map.set(m.name.text, {
        optional: !!m.questionToken,
        requiredParamCount: fnType ? countRequiredParams(fnType.parameters) : null,
      });
      continue;
    }
    // get/set アクセサ・index signature 等は、この道具の5形のどれにも直接該当しないため
    // 意図的に読み飛ばす（member map には出さない——つまり増減の対象外になる）。
  }
  return map;
}

/**
 * `export type X = "a" | "b" | ...;` の形（文字列/数値リテラルだけからなる union）なら
 * 値の `Set` を返す。それ以外（union でない・リテラルでないメンバーを含む）は `null`。
 */
export function extractUnionLiteralMembers(entry) {
  if (entry.kind !== "typeAlias") return null;
  const t = entry.node.type;
  if (!ts.isUnionTypeNode(t)) return null;
  const values = new Set();
  for (const member of t.types) {
    if (!ts.isLiteralTypeNode(member)) return null;
    const lit = member.literal;
    if (ts.isStringLiteral(lit)) {
      values.add(lit.text);
    } else if (ts.isNumericLiteral(lit)) {
      values.add(lit.text);
    } else {
      return null;
    }
  }
  return values;
}

/** トップレベルの `export declare function` の必須引数の個数。それ以外は `null`。 */
export function extractFunctionShape(entry) {
  if (entry.kind !== "function") return null;
  return { requiredParamCount: countRequiredParams(entry.node.parameters) };
}

/**
 * ノード配下にある `TypeReferenceNode` の識別子名（`ts.isIdentifier` な `typeName` だけ、
 * `z.ZodEnum` のような qualified name は無視する）を集める。
 */
function collectTypeReferenceNames(node) {
  const names = new Set();
  function visit(n) {
    if (ts.isTypeReferenceNode(n) && ts.isIdentifier(n.typeName)) {
      names.add(n.typeName.text);
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return names;
}

/**
 * 「入力側」「出力側」を、保守的な到達性ヒューリスティックで判定する。
 *
 * 手順:
 * 1. ファイル中のすべての呼び出し可能な形
 *    （トップレベル関数・interface/型リテラルの method signature・class の
 *    メソッド/コンストラクタ・関数型のプロパティ）を探す。
 * 2. その引数の型に直接現れる型参照名を「直接 input」、戻り値の型に直接現れる型参照名を
 *    「直接 output」とする（`Promise<X>`/`Array<X>` 等でラップされていても、内側の型参照は
 *    そのまま拾う——アンラップは行わず、単に「戻り値の型注釈の中に出てくる型参照すべて」を見る）。
 * 3. 各 export 済み型（interface/type alias/class）について、「自分の定義の中で
 *    参照している他の型」への辺を張る（`A の定義の中に B への TypeReference がある` ⟹
 *    `A → B`）。
 * 4. 直接 input/output の集合から、この辺を辿って到達できる型もすべて input/output に
 *    含める（「B がどこかで入力として使われているコンテナ A の一部である」なら、
 *    B 自身も入力の一部として扱う、という意味）。
 *
 * この判定は**保守的**である——同じ型が入力・出力どちらの閉包にも入れば「両方」、
 * どちらの閉包にも入らなければ「不明」として返す。どちらの場合も呼び出し側
 * （`diffPackageModels` の union 比較部分）で「要人判断」に落とす。
 *
 * @returns {{ inputSet: Set<string>, outputSet: Set<string> }}
 */
export function computeIoClosures(sourceFile, exportedEntries) {
  const directInput = new Set();
  const directOutput = new Set();

  function recordCallable(parameters, returnTypeNode) {
    for (const p of parameters) {
      if (!p.type) continue;
      for (const name of collectTypeReferenceNames(p.type)) directInput.add(name);
    }
    if (returnTypeNode) {
      for (const name of collectTypeReferenceNames(returnTypeNode)) directOutput.add(name);
    }
  }

  function visit(node) {
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isFunctionTypeNode(node)
    ) {
      recordCallable(node.parameters, "type" in node ? node.type : undefined);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  // 3: containsEdges — export 済みコンテナの定義本体に出てくる型参照名。
  const containsEdges = new Map();
  for (const [name, entry] of exportedEntries) {
    let bodyNode = entry.node;
    if (entry.kind === "typeAlias") bodyNode = entry.node.type;
    containsEdges.set(name, collectTypeReferenceNames(bodyNode));
  }

  function closureOf(roots) {
    const visited = new Set();
    const queue = [...roots];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      const next = containsEdges.get(current);
      if (next) {
        for (const n of next) if (!visited.has(n)) queue.push(n);
      }
    }
    return visited;
  }

  return {
    inputSet: closureOf(directInput),
    outputSet: closureOf(directOutput),
  };
}

/**
 * 1パッケージぶんの snapshot テキストから、diff に要る形をすべて抜き出す。
 */
export function buildPackageModel(snapshotText, virtualFileName = "snapshot.d.ts") {
  const sourceFile = parseSnapshotSource(snapshotText, virtualFileName);
  const exportedEntries = collectTopLevelExports(sourceFile);
  const containers = new Map();
  const unions = new Map();
  const functions = new Map();
  for (const [name, entry] of exportedEntries) {
    const members = extractContainerMembers(entry);
    if (members) containers.set(name, { kind: entry.kind, members });
    const union = extractUnionLiteralMembers(entry);
    if (union) unions.set(name, union);
    const fn = extractFunctionShape(entry);
    if (fn) functions.set(name, fn);
  }
  const io = computeIoClosures(sourceFile, exportedEntries);
  return { exportedEntries, containers, unions, functions, io };
}

/** 改名推定用の、コンテナの「形の指紋」（メンバー名の集合をソートして連結しただけ）。 */
function containerFingerprint(members) {
  return [...members.keys()].sort().join("|");
}

function unionFingerprint(values) {
  return [...values].sort().join("|");
}

/**
 * 2つのパッケージモデル（base/head）を比較し、5形それぞれの検出結果を返す。
 *
 * @returns {{
 *   requiredMemberAdded: Array<{container: string, member: string}>,
 *   memberBecameRequired: Array<{container: string, member: string}>,
 *   requiredParamIncreased: Array<{container: string|null, member: string, before: number, after: number}>,
 *   exportRemoved: Array<{name: string, kind: string, renamedTo: string|null}>,
 *   outputUnionValueAdded: Array<{name: string, addedValues: string[]}>,
 *   needsHumanJudgment: Array<{name: string, reason: string}>,
 * }}
 */
export function diffPackageModels(base, head) {
  const requiredMemberAdded = [];
  const memberBecameRequired = [];
  const requiredParamIncreased = [];

  for (const [name, baseContainer] of base.containers) {
    const headContainer = head.containers.get(name);
    if (!headContainer) continue; // export 自体が消えたケースは exportRemoved 側で扱う。
    // クラスは「必須メンバー追加」の対象にしない（呼ぶ側を壊さないため。冒頭の doc 参照）。
    const checkRequiredAdd = baseContainer.kind !== "class";
    for (const [memberName, headShape] of headContainer.members) {
      const baseShape = baseContainer.members.get(memberName);
      if (!baseShape) {
        if (checkRequiredAdd && !headShape.optional) {
          requiredMemberAdded.push({ container: name, member: memberName });
        }
        continue;
      }
      if (checkRequiredAdd && baseShape.optional && !headShape.optional) {
        memberBecameRequired.push({ container: name, member: memberName });
      }
      if (
        baseShape.requiredParamCount != null &&
        headShape.requiredParamCount != null &&
        headShape.requiredParamCount > baseShape.requiredParamCount
      ) {
        requiredParamIncreased.push({
          container: name,
          member: memberName,
          before: baseShape.requiredParamCount,
          after: headShape.requiredParamCount,
        });
      }
    }
  }

  for (const [name, baseFn] of base.functions) {
    const headFn = head.functions.get(name);
    if (!headFn) continue;
    if (headFn.requiredParamCount > baseFn.requiredParamCount) {
      requiredParamIncreased.push({
        container: null,
        member: name,
        before: baseFn.requiredParamCount,
        after: headFn.requiredParamCount,
      });
    }
  }

  // export removed / renamed（トップレベルの名前の集合だけを見る）。
  const exportRemoved = [];
  const baseNames = new Set(base.exportedEntries.keys());
  const headNames = new Set(head.exportedEntries.keys());
  const addedNames = [...headNames].filter((n) => !baseNames.has(n));
  for (const name of baseNames) {
    if (headNames.has(name)) continue;
    const baseEntry = base.exportedEntries.get(name);
    let renamedTo = null;
    if (baseEntry.kind === "interface" || baseEntry.kind === "class") {
      const baseMembers = base.containers.get(name)?.members;
      if (baseMembers) {
        const fp = containerFingerprint(baseMembers);
        for (const candidate of addedNames) {
          const candEntry = head.exportedEntries.get(candidate);
          if (candEntry.kind !== baseEntry.kind) continue;
          const candMembers = head.containers.get(candidate)?.members;
          if (candMembers && containerFingerprint(candMembers) === fp && fp !== "") {
            renamedTo = candidate;
            break;
          }
        }
      }
    } else if (baseEntry.kind === "typeAlias") {
      const baseUnion = base.unions.get(name);
      if (baseUnion) {
        const fp = unionFingerprint(baseUnion);
        for (const candidate of addedNames) {
          const candUnion = head.unions.get(candidate);
          if (candUnion && unionFingerprint(candUnion) === fp && fp !== "") {
            renamedTo = candidate;
            break;
          }
        }
      }
    }
    exportRemoved.push({ name, kind: baseEntry.kind, renamedTo });
  }

  // union（文字列/数値リテラル）に増えた値。
  const outputUnionValueAdded = [];
  const needsHumanJudgment = [];
  for (const [name, baseValues] of base.unions) {
    const headValues = head.unions.get(name);
    if (!headValues) continue; // export ごと消えた場合は exportRemoved 側。
    const added = [...headValues].filter((v) => !baseValues.has(v));
    if (added.length === 0) continue;
    const isInput = head.io.inputSet.has(name);
    const isOutput = head.io.outputSet.has(name);
    if (isOutput && !isInput) {
      outputUnionValueAdded.push({ name, addedValues: added });
    } else if (isInput && !isOutput) {
      // 入力側だけで広がっている ⟹ 非破壊。一覧には出さない。
      continue;
    } else if (isInput && isOutput) {
      needsHumanJudgment.push({
        name,
        reason:
          `値が増えた（${added.join(", ")}）が、この union は入力側・出力側の両方の型から` +
          `到達できる（保守的な到達性ヒューリスティックでは区別できない）。人が読んで判断すること。`,
      });
    } else {
      needsHumanJudgment.push({
        name,
        reason:
          `値が増えた（${added.join(", ")}）が、この union がこのパッケージの公開面のどの` +
          `関数/メソッドの引数・戻り値からも直接/間接に参照されているのを見つけられなかった` +
          `（他パッケージ経由・外部利用者の直接使用など、この到達性ヒューリスティックの外側で` +
          `使われている可能性がある）。人が読んで判断すること。`,
      });
    }
  }

  return {
    requiredMemberAdded,
    memberBecameRequired,
    requiredParamIncreased,
    exportRemoved,
    outputUnionValueAdded,
    needsHumanJudgment,
  };
}

const BULLET_ORDER = [
  ["requiredMemberAdded", "① 既存の interface/型リテラルに必須メンバーが足された"],
  ["memberBecameRequired", "② 既存メンバーが任意から必須になった"],
  ["exportRemoved", "③ export が消えた／名前が変わった"],
  ["requiredParamIncreased", "④ 関数/メソッド/コンストラクタの必須引数が増えた"],
  ["outputUnionValueAdded", "⑤ 出力側の union に値が増えた"],
];

function formatFindingLine(category, item) {
  switch (category) {
    case "requiredMemberAdded":
    case "memberBecameRequired":
      return `- \`${item.container}.${item.member}\``;
    case "exportRemoved":
      return item.renamedTo
        ? `- \`${item.name}\`（${item.kind}）—— 改名の推定候補: \`${item.renamedTo}\`（同じ形のメンバー集合を持つ新規 export。確定ではない）`
        : `- \`${item.name}\`（${item.kind}）`;
    case "requiredParamIncreased": {
      const label = !item.container
        ? `\`${item.member}\`（トップレベル関数）`
        : item.member === "(constructor)"
          ? `\`new ${item.container}(...)\`（コンストラクタ）`
          : `\`${item.container}.${item.member}\``;
      return `- ${label}: 必須引数 ${item.before} → ${item.after}`;
    }
    case "outputUnionValueAdded":
      return `- \`${item.name}\`: ${item.addedValues.map((v) => `\`"${v}"\``).join(", ")} が増えた`;
    default:
      return `- ${JSON.stringify(item)}`;
  }
}

/**
 * 1パッケージぶんの diff 結果を Markdown へ組み立てる。差分が1件も無ければ null。
 */
export function buildPackageMarkdownSection(pkgName, diff) {
  const hasAny =
    BULLET_ORDER.some(([key]) => diff[key].length > 0) || diff.needsHumanJudgment.length > 0;
  if (!hasAny) return null;
  const lines = [`### ${pkgName}`, ""];
  for (const [key, label] of BULLET_ORDER) {
    const items = diff[key];
    if (items.length === 0) continue;
    lines.push(`**${label}**（${items.length}件）`, "");
    for (const item of items) lines.push(formatFindingLine(key, item));
    lines.push("");
  }
  if (diff.needsHumanJudgment.length > 0) {
    lines.push(
      `**⚠ 要人判断**（${diff.needsHumanJudgment.length}件、機械では入力/出力を決め切れなかった union）`,
      "",
    );
    for (const item of diff.needsHumanJudgment) {
      lines.push(`- \`${item.name}\`: ${item.reason}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * 全パッケージぶんをまとめて Markdown レポートにする。
 *
 * @param {{ base: string, head: string, perPackage: Array<{ pkgName: string, diff: object, error: string|null }> }} args
 */
export function buildFullMarkdownReport({ base, head, perPackage, generatedAt }) {
  const lines = [
    "## 公開 API の破壊的変更候補（v1.0.0 以降、⛔ 門ではない・常に exit 0）",
    "",
    `- 基準（base）: \`${base}\``,
    `- 対象（head）: \`${head}\``,
    `- 生成時刻: ${generatedAt}`,
    "",
    "⚠ **これは判定ではなく候補の一覧である。** 検出する5形・検出しない形（メンバーの削除/改名、" +
      "引数の個数が変わらない型変更、クラスへの必須でないメンバー追加、非リテラル union の拡張、" +
      "型に現れない実行時の意味変更）は `scripts/public-api-breaking-diff-lib.mjs` 冒頭のコメントに" +
      "書いてある。確定と `docs/migration-v1.md`/`CHANGELOG.md` への計上は人が行う。",
    "",
  ];

  const sections = [];
  const errored = [];
  for (const { pkgName, diff, error } of perPackage) {
    if (error) {
      errored.push(`- \`${pkgName}\`: ${error}`);
      continue;
    }
    const section = buildPackageMarkdownSection(pkgName, diff);
    if (section) sections.push(section);
  }

  if (errored.length > 0) {
    lines.push("### 読み取りに失敗したパッケージ", "", ...errored, "");
  }

  if (sections.length === 0 && errored.length === perPackage.length) {
    lines.push("（全パッケージの読み取りに失敗した。上を見ること。）");
  } else if (sections.length === 0) {
    lines.push("候補は見つからなかった。");
  } else {
    lines.push(...sections);
  }

  return lines.join("\n").trimEnd() + "\n";
}

/** 想定外の失敗（import 解決そのものが壊れる等）のときの、常に exit 0 な最終防波堤。 */
export function buildFatalFallbackMarkdown(error) {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  return [
    "## 公開 API の破壊的変更候補 —— 印字に失敗した",
    "",
    "⛔ この道具は門ではない。想定外の失敗があっても exit 0 を返し、失敗の内容をここに出す。",
    "",
    "```",
    message,
    "```",
    "",
  ].join("\n");
}
