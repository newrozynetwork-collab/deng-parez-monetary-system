let clientFactory = null;

function getClient() {
  if (clientFactory) return clientFactory();
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');
  return new GoogleGenerativeAI(key);
}

function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters
    }))
  }];
}

function toGeminiContents(messages) {
  return messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : (m.role === 'tool' ? 'function' : 'user'),
    parts: m.parts || [{ text: m.content || '' }]
  }));
}

const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

async function callModel({ systemPrompt, tools, messages, modelName = DEFAULT_MODEL }) {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    tools: toGeminiTools(tools),
    // Disable extended thinking: with a long directive system prompt and many
    // tools, 2.5 Flash sometimes consumes its full thinking budget and stops
    // before producing any output (empty `parts`, finishReason STOP). For
    // command→tool routing we don't need deep reasoning anyway.
    generationConfig: {
      thinkingConfig: { thinkingBudget: 0 }
    }
  });

  const result = await model.generateContent({ contents: toGeminiContents(messages) });
  const candidate = result.response.candidates && result.response.candidates[0];
  if (!candidate) return { kind: 'text', text: '' };

  const parts = candidate.content.parts || [];
  const fnCall = parts.find(p => p.functionCall);
  if (fnCall) {
    return { kind: 'tool_call', toolName: fnCall.functionCall.name, toolArgs: fnCall.functionCall.args || {} };
  }
  const textPart = parts.find(p => p.text);
  return { kind: 'text', text: textPart ? textPart.text : '' };
}

function _setClientFactory(fn) { clientFactory = fn; }
function _resetClientFactory() { clientFactory = null; }

module.exports = { callModel, _setClientFactory, _resetClientFactory };
