/** Worker に注入されるシークレット。値は wrangler secret / .dev.vars で設定する。 */
export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  MCP_AUTH_TOKEN: string;
}

const REQUIRED_KEYS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'MCP_AUTH_TOKEN',
] as const satisfies readonly (keyof Env)[];

/** 未設定のシークレットがあれば、その名前を列挙して返す。 */
export function missingEnvKeys(env: Partial<Env>): string[] {
  return REQUIRED_KEYS.filter((key) => {
    const value = env[key];
    return typeof value !== 'string' || value.length === 0;
  });
}
