// Regression test for the @ai-sdk/anthropic web_fetch error-passthrough patch.
// Replays the exact poisoned-message shape from prod (2026-06-12 incident):
// a provider-executed webFetch tool-result whose output is typed `json` but
// whose value is the error variant. Unpatched: AI_TypeValidationError before
// the request is even sent (proven 3x in prod). Patched: the request goes out
// with a proper web_fetch_tool_result_error block.
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

const captured = [];
const fakeFetch = async (_url, init) => {
  captured.push(JSON.parse(init.body));
  return new Response(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'Understood — that page could not be fetched.' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

const anthropic = createAnthropic({ apiKey: 'test-key', fetch: fakeFetch });

const result = await generateText({
  model: anthropic('claude-sonnet-4-5-20250929'),
  tools: { webFetch: anthropic.tools.webFetch_20250910({}) },
  messages: [
    { role: 'user', content: 'What is on the goal page?' },
    {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'srvtoolu_test1',
          toolName: 'webFetch',
          input: { url: 'https://www.exponential.im/w/personal-cmdfuz6e/goals/19' },
          providerExecuted: true,
        },
        {
          type: 'tool-result',
          toolCallId: 'srvtoolu_test1',
          toolName: 'webFetch',
          // The poisoned shape: error payload under a success-typed output.
          output: {
            type: 'json',
            value: { type: 'web_fetch_tool_result_error', errorCode: 'url_not_allowed' },
          },
          providerExecuted: true,
        },
      ],
    },
    { role: 'user', content: 'ok, what now?' },
  ],
});

const body = captured[0];
const blocks = body.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []));
const errBlock = blocks.find((b) => b.type === 'web_fetch_tool_result');

if (!errBlock) throw new Error('FAIL: no web_fetch_tool_result block in outgoing request');
if (errBlock.content?.type !== 'web_fetch_tool_result_error')
  throw new Error('FAIL: block is not the error variant: ' + JSON.stringify(errBlock));
if (errBlock.content?.error_code !== 'url_not_allowed')
  throw new Error('FAIL: wrong error_code: ' + JSON.stringify(errBlock.content));
if (!result.text) throw new Error('FAIL: no text result');

console.log('PASS: poisoned web_fetch result converted to proper error block:');
console.log('  ', JSON.stringify(errBlock.content));
console.log('PASS: turn completed, model said:', JSON.stringify(result.text));
