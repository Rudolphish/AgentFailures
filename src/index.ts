import { JSONRPCMessageSchema, type JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { isAuthorized } from './auth.js';
import { missingEnvKeys, type Env } from './env.js';
import { createMcpServer } from './mcp.js';
import { ping, createStore } from './store.js';
import { WorkersHttpTransport } from './transport.js';

/** MCP のエンドポイント。クライアントにはこのパスまでを含む URL を設定する。 */
const MCP_PATH = '/mcp';

/** 1 リクエストあたりの処理上限。Workers の実行時間内に収める。 */
const DISPATCH_TIMEOUT_MS = 25_000;

/** JSON-RPC のエラーコード。 */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function rpcError(
  code: number,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return json({ jsonrpc: '2.0', id: null, error: { code, message } }, status, headers);
}

async function handleMcpPost(request: Request, env: Env): Promise<Response> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return rpcError(INVALID_REQUEST, 'Content-Type は application/json である必要があります。', 415);
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return rpcError(PARSE_ERROR, 'リクエストボディを JSON として解釈できませんでした。', 400);
  }

  const isBatch = Array.isArray(payload);
  const rawMessages = isBatch ? (payload as unknown[]) : [payload];
  if (rawMessages.length === 0) {
    return rpcError(INVALID_REQUEST, 'JSON-RPC メッセージが含まれていません。', 400);
  }

  const messages: JSONRPCMessage[] = [];
  for (const raw of rawMessages) {
    const parsed = JSONRPCMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return rpcError(INVALID_REQUEST, '不正な JSON-RPC メッセージが含まれています。', 400);
    }
    messages.push(parsed.data);
  }

  const server = createMcpServer(env);
  const transport = new WorkersHttpTransport();

  try {
    await server.connect(transport);
    const responses = await transport.dispatch(messages, DISPATCH_TIMEOUT_MS);

    // 通知のみの場合、返すべきボディは存在しない。
    if (responses.length === 0) {
      return new Response(null, { status: 202 });
    }
    return json(isBatch ? responses : responses[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return rpcError(INTERNAL_ERROR, `Internal error: ${message}`, 500);
  } finally {
    await server.close().catch(() => undefined);
  }
}

async function handleFetch(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const missing = missingEnvKeys(env);

  // 疎通確認用。認証を要さないエンドポイントであるため、設定の詳細
  // （どの環境変数が不足しているか）は返さず、状態のみを返す。
  if (url.pathname === '/health') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method Not Allowed' }, 405, { allow: 'GET, HEAD' });
    }
    return json({ status: missing.length > 0 ? 'misconfigured' : 'ok' });
  }

  if (missing.length > 0) {
    // 不足している変数名はサーバーのログにのみ残す。
    // 未認証の相手に返すと、どのシークレットが未設定かを外部へ教えることになる。
    console.error(`サーバー設定が不足しています: ${missing.join(', ')}`);
    return json({ error: 'Server misconfigured' }, 500);
  }

  if (url.pathname !== MCP_PATH) {
    return json({ error: `Not Found. MCP エンドポイントは ${MCP_PATH} です。` }, 404);
  }

  if (!(await isAuthorized(request, env.MCP_AUTH_TOKEN))) {
    return json({ error: 'Unauthorized' }, 401, { 'www-authenticate': 'Bearer' });
  }

  switch (request.method) {
    case 'POST':
      return handleMcpPost(request, env);

    case 'DELETE':
      // ステートレス運用のため破棄すべきセッションは存在しない。
      return new Response(null, { status: 204 });

    default:
      // サーバー起点の SSE ストリームは提供しないため GET は受け付けない。
      return rpcError(
        INVALID_REQUEST,
        'このエンドポイントが受け付けるのは POST と DELETE のみです。',
        405,
        { allow: 'POST, DELETE' },
      );
  }
}

export default {
  // ランタイムはハンドラの戻り値が Promise であることを要求する。
  // async として宣言し、await して返すことで、必ずネイティブの Promise を返す。
  async fetch(request, env): Promise<Response> {
    try {
      return await handleFetch(request, env);
    } catch (error) {
      // 例外を捕捉しない場合、Cloudflare は診断情報の無い 1101 のエラーページを返す。
      // 内容はサーバーのログにのみ残し、クライアントへは汎用の応答を返す。
      console.error('未捕捉の例外が発生しました:', error);
      return json({ error: 'Internal Server Error' }, 500);
    }
  },

  /**
   * Supabase 無料プランは 7 日間 DB アクセスが無いとプロジェクトが自動停止するため、
   * Cron Trigger から軽量なクエリを実行して停止を回避する。
   */
  async scheduled(_event, env, ctx) {
    if (missingEnvKeys(env).length > 0) {
      console.error('keep-alive: シークレットが未設定のため実行を中止しました。');
      return;
    }
    ctx.waitUntil(
      ping(createStore(env)).then(
        () => console.log('keep-alive: Supabase への疎通に成功しました。'),
        (error: unknown) => console.error('keep-alive: 失敗しました。', error),
      ),
    );
  },
} satisfies ExportedHandler<Env>;
