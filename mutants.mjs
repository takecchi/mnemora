const V = "packages/postgres/src/vector-store.ts";
const L = "packages/postgres/src/lexical-store.ts";
const T = "packages/postgres/src/trigram-lexical-store.ts";
const searchMap = "      return { memoryId: r.memory_id, distance: r.distance };\n    });";
const manyPush = "        ?.push({ memoryId: r.memory_id, distance: r.distance });";
const manyEnd = "    return resultMap;\n  }\n\n  async delete(";
const getVecWhere = "        FROM ${sql.identifier(table)}\n        WHERE tenant_id = ${ctx.tenantId} AND memory_id = ANY(${sql.param(validIds)}::uuid[])";
const lexStatus = "    conditions.push(sql`status = ANY(${sql.param(opts.filter.status)}::text[])`);\n  }";
const lexStatusMut = lexStatus + " else {\n    conditions.push(sql`status IN ('active', 'contested')`);\n  }";
const lexProv = "  if (\n    opts.filter.excludeProvenanceKinds !== undefined &&\n    opts.filter.excludeProvenanceKinds.length > 0\n  ) {";
const lexProvMut = "  if (opts.filter.excludeProvenanceKinds?.length === 0) {\n    conditions.push(sql`false`);\n  }\n" + lexProv;
export const mutants = [
  { id: "V1", file: V, edits: [["      return { memoryId: r.memory_id, vector: parseVectorLiteral(r.embedding) };",
    "      const v = parseVectorLiteral(r.embedding);\n      const n = Math.hypot(...v);\n      return { memoryId: r.memory_id, vector: n > 0 ? v.map((x) => x / n) : v };"]] },
  { id: "V2", file: V, edits: [[getVecWhere, getVecWhere + " AND vector_norm(embedding) > 0"]] },
  { id: "V3", file: V, edits: [[getVecWhere, getVecWhere + "\n        ORDER BY array_position(${sql.param(validIds)}::uuid[], memory_id)"]] },
  { id: "V4", file: V, edits: [["${toVectorLiteral(vector)}::vector, ${space.model}",
    "${toVectorLiteral(((n) => (n > 0 ? vector.map((x) => x / n) : vector))(Math.hypot(...vector)))}::vector, ${space.model}"]] },
  { id: "V5", file: V, edits: [["SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id}",
    "SELECT 1 FROM memories WHERE tenant_id = ${ctx.tenantId} AND id = ${id} AND status IN ('active', 'contested')"]] },
  { id: "V6", file: V, edits: [["    await maybeAnalyzeAfterUpsert(this.db, space);",
    "    await maybeAnalyzeAfterUpsert(this.db, space);\n    await this.db.execute(sql.raw(`ANALYZE \"${table}\"`));"]] },
  { id: "V7", file: V, edits: [["    conditions.push(sql`m.status = ANY(${sql.param(filter.status)}::text[])`);\n  }",
    "    conditions.push(sql`m.status = ANY(${sql.param(filter.status)}::text[])`);\n  } else {\n    conditions.push(sql`m.status IN ('active', 'contested')`);\n  }"]] },
  { id: "V8", file: V, edits: [["  if (filter.excludeProvenanceKinds !== undefined && filter.excludeProvenanceKinds.length > 0) {",
    "  if (filter.excludeProvenanceKinds?.length === 0) {\n    conditions.push(sql`false`);\n  }\n  if (filter.excludeProvenanceKinds !== undefined && filter.excludeProvenanceKinds.length > 0) {"]] },
  { id: "V9", file: V, edits: [["    conditions.push(sql`m.attributes @> ${JSON.stringify(filter.attributes)}::jsonb`);",
    "    conditions.push(sql`m.attributes @> ${JSON.stringify(filter.attributes)}::jsonb`);\n    if (Object.keys(filter.attributes).length === 0) {\n      conditions.push(sql`m.attributes <> '{}'::jsonb`);\n    }"]] },
  { id: "V10", file: V, edits: [
    ["vector_norm(e.embedding) > 0 AND ${memoryConditions}", "vector_norm(e.embedding) > 0 AND ${memoryConditions} AND m.status <> 'archived'"],
    ["vector_norm(e.embedding) = 0 AND ${memoryConditions}", "vector_norm(e.embedding) = 0 AND ${memoryConditions} AND m.status <> 'archived'"]] },
  { id: "V11", file: V, edits: [[searchMap, searchMap.slice(0, -1) + ".filter((h) => !(h.distance > 1));"],
    [manyPush, "        ?.push(...(r.distance > 1 ? [] : [{ memoryId: r.memory_id, distance: r.distance }]));"]] },
  { id: "V12", file: V, edits: [[searchMap, "      return { memoryId: r.memory_id, distance: Math.min(1, Math.max(0, r.distance)) };\n    });"],
    [manyPush, "        ?.push({ memoryId: r.memory_id, distance: Math.min(1, Math.max(0, r.distance)) });"]] },
  { id: "V13", file: V, edits: [[manyEnd, "    return new Map([...resultMap].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));\n  }\n\n  async delete("]] },
  { id: "V14", file: V, edits: [[manyEnd, "    for (const [k, v] of resultMap) {\n      if (v.length === 0) resultMap.delete(k);\n    }\n" + manyEnd]] },
  { id: "V15", file: V, edits: [["    for (const row of rows) {\n      const r = row as { query_idx: number; memory_id: string; distance: number };\n",
    "    const seenIds = new Set<string>();\n    const sortedRows = [...rows].sort(\n      (a, b) => (a as { query_idx: number }).query_idx - (b as { query_idx: number }).query_idx,\n    );\n    for (const row of sortedRows) {\n      const r = row as { query_idx: number; memory_id: string; distance: number };\n      if (seenIds.has(r.memory_id)) continue;\n      seenIds.add(r.memory_id);\n"]] },
  { id: "V16", file: V, edits: [["          if (dryRun) {", "          if (false as boolean && dryRun) {"]] },
  { id: "L1", file: L, edits: [[lexStatus, lexStatusMut]] },
  { id: "L2", file: L, edits: [[lexProv, lexProvMut]] },
  { id: "L3", file: L, edits: [["    conditions.push(sql`attributes @> ${JSON.stringify(opts.filter.attributes)}::jsonb`);",
    "    conditions.push(sql`attributes @> ${JSON.stringify(opts.filter.attributes)}::jsonb`);\n    if (Object.keys(opts.filter.attributes).length === 0) {\n      conditions.push(sql`attributes <> '{}'::jsonb`);\n    }"]] },
  { id: "L4", file: L, edits: [["      return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };",
    "      return { memoryId: r.memory_id, coverage: Math.round(r.coverage * 100) / 100, rank: r.rank };"]] },
  { id: "L5", file: L, edits: [["      return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };\n    });",
    "      return { memoryId: r.memory_id, coverage: r.coverage, rank: r.rank };\n    }).filter((h) => h.coverage >= 0.5);"]] },
  { id: "L6", file: L, edits: [["    ORDER BY coverage DESC, rank DESC, recorded_at DESC, id", "    ORDER BY coverage DESC, rank DESC, length(content), recorded_at DESC, id"]] },
  { id: "L7", file: L, edits: [["(valid_from IS NULL OR valid_from <= ${", "(valid_from IS NULL OR valid_from < ${"]] },
  { id: "L8", file: L, edits: [["  const cappedQuery = capLexicalQueryWords(query);", "  const cappedQuery = capLexicalQueryWords(query.normalize(\"NFKC\"));"]] },
  { id: "T1", file: T, edits: [[lexStatus, lexStatusMut]] },
  { id: "T2", file: T, edits: [[lexProv, lexProvMut]] },
  { id: "T3", file: T, edits: [["    OR (${jaTerm} IS NOT NULL AND content %> ${jaTerm})",
    "    ${sql.raw(/[A-Za-z0-9]/.test(query) && /[^\\x00-\\x7F]/.test(query) ? \"AND\" : \"OR\")} (${jaTerm} IS NOT NULL AND content %> ${jaTerm})"]] },
  { id: "T4", file: T, edits: [["${TRIGRAM_JAPANESE_QUERY_MAX_CHARS}))`;", "${TRIGRAM_JAPANESE_QUERY_MAX_CHARS})) || 'さん'`;"]] },
  { id: "T5", file: T, edits: [["  return { ok: true };\n}", "  await ensureTrigramLexicalFunctions(db);\n  return { ok: true };\n}"]] },
];
