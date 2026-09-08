import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

/**
 * Cloudflare Workers 用のステートレス Streamable HTTP トランスポート。
 *
 * SDK 同梱の StreamableHTTPServerTransport は Node の IncomingMessage /
 * ServerResponse を前提としており Workers 上では動作しないため、
 * 1 リクエスト = 1 JSON レスポンス（SSE なし・セッションなし）に限定した
 * 最小のブリッジを用意する。
 */
export class WorkersHttpTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  /** ステートレス運用のためセッション ID は発行しない。 */
  readonly sessionId: string | undefined = undefined;

  private collected: JSONRPCMessage[] = [];
  private expected = 0;
  private settle: (() => void) | undefined;

  async start(): Promise<void> {
    // 接続の確立は HTTP リクエスト自体が担うため、ここで行う処理はない。
  }

  setProtocolVersion(_version: string): void {
    // ステートレス運用のため、ネゴシエート結果を保持する必要はない。
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.collected.push(message);
    if (this.collected.length >= this.expected) {
      this.settle?.();
    }
  }

  async close(): Promise<void> {
    this.onclose?.();
  }

  /**
   * 受信メッセージを MCP サーバーへ流し込み、返すべきレスポンスを集めて返す。
   * 通知のみの場合は空配列を返す。
   */
  async dispatch(messages: JSONRPCMessage[], timeoutMs: number): Promise<JSONRPCMessage[]> {
    this.collected = [];
    this.expected = messages.filter(isRequest).length;

    if (this.expected === 0) {
      for (const message of messages) {
        this.onmessage?.(message);
      }
      return [];
    }

    const completed = new Promise<void>((resolve) => {
      this.settle = resolve;
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    });

    try {
      for (const message of messages) {
        this.onmessage?.(message);
      }
      await Promise.race([completed, timedOut]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.settle = undefined;
    }

    // 応答が返らなかった要求があれば、その場でエラー応答を合成する。
    const answered = new Set(
      this.collected
        .filter((message) => 'id' in message && !('method' in message))
        .map((message) => JSON.stringify((message as { id: unknown }).id)),
    );
    const missing = messages
      .filter(isRequest)
      .filter((message) => !answered.has(JSON.stringify(message.id)))
      .map((message) => ({
        jsonrpc: '2.0' as const,
        id: message.id,
        error: {
          code: -32603,
          message: `Internal error: ${message.method} の応答が ${timeoutMs}ms 以内に返りませんでした。`,
        },
      }));

    return [...this.collected, ...(missing as unknown as JSONRPCMessage[])];
  }
}

interface JSONRPCRequestLike {
  method: string;
  id: string | number;
}

/** 応答を要する要求（通知ではない）かどうかを判定する。 */
function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & JSONRPCRequestLike {
  return (
    typeof message === 'object' &&
    message !== null &&
    'method' in message &&
    'id' in message &&
    (message as { id: unknown }).id !== null &&
    (message as { id: unknown }).id !== undefined
  );
}
