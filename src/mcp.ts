import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Env } from './env.js';
import { formatRecordResult, formatSearchResult } from './format.js';
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  recordFailureInputShape,
  searchFailuresInputShape,
} from './schema.js';
import { createStore, recordFailure, searchFailures } from './store.js';

export const SERVER_NAME = 'agent-failures';
export const SERVER_VERSION = '0.1.0';

const SEARCH_DESCRIPTION = [
  '過去に記録された失敗談を検索する。',
  'タスクの実行計画を立てる前に本ツールを呼び出し、同種の失敗が記録されていないか確認すること。',
  '結果は新しい順に返る。',
  `件数は既定 ${SEARCH_LIMIT_DEFAULT} 件、上限 ${SEARCH_LIMIT_MAX} 件。`,
  'domain / environment / query はいずれも任意であり、すべて省略した場合は最新の失敗談を返す。',
].join('\n');

const RECORD_DESCRIPTION = [
  '発生した失敗を記録する。成功事例は記録しない。',
  'observed には観測された事実のみを記載し、解釈や推測を混ぜないこと。',
  '原因が推定である場合は cause_is_assumption を true にすること。',
  '必須項目（domain / environment / attempted / observed / cause / cause_is_assumption / tags）が',
  '欠落している場合はエラーとなり、登録は行われない。',
].join('\n');

export function createMcpServer(env: Env): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const store = createStore(env);

  server.registerTool(
    'search_failures',
    {
      title: '失敗談の検索',
      description: SEARCH_DESCRIPTION,
      inputSchema: searchFailuresInputShape,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => {
      const records = await searchFailures(store, input);
      return {
        content: [{ type: 'text', text: formatSearchResult(records, input.detail ?? 'summary') }],
      };
    },
  );

  server.registerTool(
    'record_failure',
    {
      title: '失敗談の記録',
      description: RECORD_DESCRIPTION,
      inputSchema: recordFailureInputShape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (input) => {
      const record = await recordFailure(store, input);
      return { content: [{ type: 'text', text: formatRecordResult(record) }] };
    },
  );

  return server;
}
