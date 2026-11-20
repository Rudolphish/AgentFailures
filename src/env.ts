/**
 * Worker に注入される binding とシークレット。
 *
 * `DB` は `wrangler.jsonc` の `d1_databases` で宣言する binding であり、
 * シークレットではない。`MCP_AUTH_TOKEN` は `wrangler secret` / `.dev.vars`
 * で設定する。
 */
export interface Env {
  DB: D1Database;
  MCP_AUTH_TOKEN: string;
}

/** 文字列として設定されている必要があるもの。 */
const REQUIRED_SECRETS = ['MCP_AUTH_TOKEN'] as const satisfies readonly (keyof Env)[];

/**
 * 未設定のシークレットと binding があれば、その名前を列挙して返す。
 *
 * **binding も同じ経路に載せている。** `wrangler.jsonc` の宣言が無いと
 * `env.DB` は `undefined` のまま注入され、最初のクエリで初めて落ちる。
 * `/health` が `misconfigured` を返す形にしておけば、デプロイ直後に気づける。
 */
export function missingEnvKeys(env: Partial<Env>): string[] {
  const missing: string[] = REQUIRED_SECRETS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.length === 0;
  });

  if (typeof env.DB?.prepare !== 'function') {
    missing.push('DB');
  }

  return missing;
}
