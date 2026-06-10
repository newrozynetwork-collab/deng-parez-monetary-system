// tests/gemini.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../services/gemini');

test('gemini.callModel: builds request with system prompt, tools, and messages', async () => {
  const calls = [];
  gemini._setClientFactory(() => ({
    getGenerativeModel({ model, systemInstruction, tools, generationConfig }) {
      return {
        async generateContent({ contents }) {
          calls.push({ model, systemInstruction, tools, generationConfig, contents });
          return {
            response: {
              candidates: [{
                content: { role: 'model', parts: [{ text: 'Hello back' }] }
              }]
            }
          };
        }
      };
    }
  }));

  const result = await gemini.callModel({
    systemPrompt: 'You are a test bot.',
    tools: [{ name: 'list_artists', description: 'List', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'Hi' }]
  });

  assert.equal(calls.length, 1);
  // Default model: gemini-2.5-flash. (gemini-2.0-flash was retired by Google
  // on 2026-06-01 — free-tier quota went to 0.) Override via GEMINI_MODEL env.
  assert.equal(calls[0].model, 'gemini-2.5-flash');
  assert.deepEqual(calls[0].systemInstruction, { role: 'system', parts: [{ text: 'You are a test bot.' }] });
  assert.equal(calls[0].tools[0].functionDeclarations[0].name, 'list_artists');
  assert.equal(calls[0].contents[0].role, 'user');
  assert.equal(calls[0].contents[0].parts[0].text, 'Hi');
  // Regression guard: thinking must be disabled — otherwise 2.5 Flash
  // sometimes consumes its full thinking budget and produces empty output
  // when paired with a directive system prompt + many tools.
  assert.deepEqual(calls[0].generationConfig, { thinkingConfig: { thinkingBudget: 0 } });

  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'Hello back');

  gemini._resetClientFactory();
});

test('gemini.callModel: returns tool_call when model emits a functionCall part', async () => {
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          return {
            response: {
              candidates: [{
                content: {
                  role: 'model',
                  parts: [{
                    functionCall: { name: 'list_artists', args: { query: 'sarah' } }
                  }]
                }
              }]
            }
          };
        }
      };
    }
  }));

  const result = await gemini.callModel({
    systemPrompt: 'sys',
    tools: [{ name: 'list_artists', description: 'd', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'find sarah' }]
  });

  assert.equal(result.kind, 'tool_call');
  assert.equal(result.toolName, 'list_artists');
  assert.deepEqual(result.toolArgs, { query: 'sarah' });

  gemini._resetClientFactory();
});

test('gemini.callModel: falls back to the fallback model when the primary is quota-dead (429 limit 0)', async () => {
  const modelsTried = [];
  gemini._setClientFactory(() => ({
    getGenerativeModel({ model }) {
      modelsTried.push(model);
      return {
        async generateContent() {
          if (model === 'gemini-2.5-flash') {
            throw new Error('[GoogleGenerativeAI Error]: [429 Too Many Requests] You exceeded your current quota. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, model: gemini-2.5-flash');
          }
          return { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'fallback says hi' }] } }] } };
        }
      };
    }
  }));

  const result = await gemini.callModel({
    systemPrompt: 'sys',
    tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }],
    messages: [{ role: 'user', content: 'hi' }]
  });

  assert.deepEqual(modelsTried, ['gemini-2.5-flash', 'gemini-2.5-flash-lite'], 'tries primary then fallback');
  assert.equal(result.kind, 'text');
  assert.equal(result.text, 'fallback says hi');

  gemini._resetClientFactory();
});

test('gemini.callModel: non-quota errors do NOT trigger the fallback (rethrown as-is)', async () => {
  const modelsTried = [];
  gemini._setClientFactory(() => ({
    getGenerativeModel({ model }) {
      modelsTried.push(model);
      return { async generateContent() { throw new Error('network socket hang up'); } };
    }
  }));

  await assert.rejects(
    () => gemini.callModel({ systemPrompt: 's', tools: [{ name: 't', description: 'd', parameters: { type: 'object', properties: {} } }], messages: [{ role: 'user', content: 'x' }] }),
    /socket hang up/
  );
  assert.deepEqual(modelsTried, ['gemini-2.5-flash'], 'no fallback attempt for non-model errors');

  gemini._resetClientFactory();
});

test('gemini.friendlyError: maps quota/model/key errors to human messages, null otherwise', () => {
  const quota = gemini.friendlyError(new Error('[GoogleGenerativeAI Error]: [429 Too Many Requests] quota exceeded, limit: 0'));
  assert.ok(quota && quota.status === 503);
  assert.match(quota.message, /busy|limit|try again/i);
  assert.ok(!/GoogleGenerativeAI|quotaMetric|@type/.test(quota.message), 'no raw API jargon');

  const gone = gemini.friendlyError(new Error('[404 Not Found] models/gemini-x is not found for API version v1beta'));
  assert.ok(gone && gone.status === 503);

  const noKey = gemini.friendlyError(new Error('GEMINI_API_KEY not set'));
  assert.ok(noKey && noKey.status === 503);
  assert.match(noKey.message, /not configured/i);

  assert.equal(gemini.friendlyError(new Error('random boom')), null);
});
