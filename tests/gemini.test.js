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
