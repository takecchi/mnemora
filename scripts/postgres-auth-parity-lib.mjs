/**
 * ⛔ `postgres` ジョブ（matrix）は対象にしない。`POSTGRES_INITDB_ARGS` が `${{ matrix.initdbArgs }}` の式で、
 * 脚によって `SQL_ASCII` になるため、他ジョブと比べると無関係な理由で赤くなる。
 * ⛔ YAML パーサは足さない（依存追加はオーナー専権）。`ci.yml` / `docker-compose.yml` は
 * `key: value` の平坦な形だけなので、正規表現とインデント幅で切り出す。
 */

export const NON_MATRIX_POSTGRES_JOBS = Object.freeze([
  "root-gate-db-stage",
  "example-chat",
  "retrieval-quality",
  "identifier-probes",
  "consolidation-cost",
  "archive-sweep-cost",
  "time-term",
  "association-probes",
]);

export const COMPARED_ENV_KEYS = Object.freeze([
  "POSTGRES_USER",
  "POSTGRES_PASSWORD",
  "POSTGRES_DB",
  "POSTGRES_INITDB_ARGS",
]);

/**
 * @param {string} value
 * @returns {string}
 */
function stripSurroundingQuotes(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * @param {string} yaml
 * @param {string} jobId
 * @returns {string | undefined} 見つからなければ `undefined`
 */
export function extractJob(yaml, jobId) {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line === `  ${jobId}:`);
  if (start === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}\S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/**
 * @param {string} jobBlock
 * @returns {{ image: string | undefined, env: Record<string, string> }}
 */
export function extractCiPostgresService(jobBlock) {
  const lines = jobBlock.split("\n");
  const serviceStart = lines.findIndex((line) => line === "      postgres:");
  if (serviceStart === -1) {
    return { image: undefined, env: {} };
  }
  let serviceEnd = lines.length;
  for (let i = serviceStart + 1; i < lines.length; i += 1) {
    if (/^ {0,6}\S/.test(lines[i])) {
      serviceEnd = i;
      break;
    }
  }
  const serviceLines = lines.slice(serviceStart + 1, serviceEnd);

  let image;
  const imageLine = serviceLines.find((line) => /^ {8}image: /.test(line));
  if (imageLine !== undefined) {
    image = imageLine.slice("        image: ".length).trim();
  }

  const envStart = serviceLines.findIndex((line) => line === "        env:");
  /** @type {Record<string, string>} */
  const env = {};
  if (envStart !== -1) {
    for (let i = envStart + 1; i < serviceLines.length; i += 1) {
      const line = serviceLines[i];
      // コメント行・空行は読み飛ばす。キーでない行で打ち切ると、コメントを挟んだ実物で
      // `POSTGRES_INITDB_ARGS` を取りこぼす。
      if (line.trim() === "" || /^ {10}#/.test(line)) {
        continue;
      }
      const matched = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (!matched) {
        break;
      }
      env[matched[1]] = stripSurroundingQuotes(matched[2].trim());
    }
  }
  return { image, env };
}

/**
 * @param {string} composeText
 * @returns {{ image: string | undefined, env: Record<string, string> }}
 */
export function extractComposePostgresService(composeText) {
  const lines = composeText.split("\n");
  const serviceStart = lines.findIndex((line) => line === "  postgres:");
  if (serviceStart === -1) {
    return { image: undefined, env: {} };
  }
  let serviceEnd = lines.length;
  for (let i = serviceStart + 1; i < lines.length; i += 1) {
    if (/^ {0,2}\S/.test(lines[i])) {
      serviceEnd = i;
      break;
    }
  }
  const serviceLines = lines.slice(serviceStart + 1, serviceEnd);

  let image;
  const imageLine = serviceLines.find((line) => /^ {4}image: /.test(line));
  if (imageLine !== undefined) {
    image = imageLine.slice("    image: ".length).trim();
  }

  const envStart = serviceLines.findIndex((line) => line === "    environment:");
  /** @type {Record<string, string>} */
  const env = {};
  if (envStart !== -1) {
    for (let i = envStart + 1; i < serviceLines.length; i += 1) {
      const line = serviceLines[i];
      if (line.trim() === "" || /^ {6}#/.test(line)) {
        continue;
      }
      const matched = /^ {6}([A-Za-z_][A-Za-z0-9_]*): (.*)$/.exec(line);
      if (!matched) {
        break;
      }
      env[matched[1]] = stripSurroundingQuotes(matched[2].trim());
    }
  }
  return { image, env };
}

/**
 * @param {{ ciYamlText: string, composeText: string }} input
 * @returns {{
 *   missingJobs: string[],
 *   composeMissing: boolean,
 *   mismatches: { job: string, key: string, ciValue: string | undefined, composeValue: string | undefined }[],
 *   crossJobMismatches: { job: string, key: string, value: string | undefined, referenceJob: string, referenceValue: string | undefined }[],
 * }}
 */
export function findPostgresAuthAsymmetry({ ciYamlText, composeText }) {
  const compose = extractComposePostgresService(composeText);
  const composeMissing = compose.image === undefined;

  /** @type {string[]} */
  const missingJobs = [];
  /** @type {{ job: string, key: string, ciValue: string | undefined, composeValue: string | undefined }[]} */
  const mismatches = [];
  /** @type {{ job: string, key: string, value: string | undefined, referenceJob: string, referenceValue: string | undefined }[]} */
  const crossJobMismatches = [];

  /** @type {{ job: string, image: string | undefined, env: Record<string, string> }[]} */
  const ciServices = [];

  for (const jobId of NON_MATRIX_POSTGRES_JOBS) {
    const jobBlock = extractJob(ciYamlText, jobId);
    if (jobBlock === undefined) {
      missingJobs.push(jobId);
      continue;
    }
    const service = extractCiPostgresService(jobBlock);
    ciServices.push({ job: jobId, ...service });
  }

  const reference = ciServices[0];

  for (const service of ciServices) {
    if (!composeMissing) {
      if (service.image !== compose.image) {
        mismatches.push({
          job: service.job,
          key: "image",
          ciValue: service.image,
          composeValue: compose.image,
        });
      }
      for (const key of COMPARED_ENV_KEYS) {
        if (service.env[key] !== compose.env[key]) {
          mismatches.push({
            job: service.job,
            key,
            ciValue: service.env[key],
            composeValue: compose.env[key],
          });
        }
      }
    }

    if (reference !== undefined && service.job !== reference.job) {
      if (service.image !== reference.image) {
        crossJobMismatches.push({
          job: service.job,
          key: "image",
          value: service.image,
          referenceJob: reference.job,
          referenceValue: reference.image,
        });
      }
      for (const key of COMPARED_ENV_KEYS) {
        if (service.env[key] !== reference.env[key]) {
          crossJobMismatches.push({
            job: service.job,
            key,
            value: service.env[key],
            referenceJob: reference.job,
            referenceValue: reference.env[key],
          });
        }
      }
    }
  }

  return { missingJobs, composeMissing, mismatches, crossJobMismatches };
}
