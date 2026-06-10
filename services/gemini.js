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

// gemini-2.0-flash was retired by Google on 2026-06-01 (free-tier quota → 0).
// Default to the current flash model; if Google ever kills that one too, we
// fall back once to the -lite sibling instead of taking the chat down.
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-lite';

// Errors that mean "this model can't serve you" (quota gone / model retired),
// as opposed to transient network errors where a different model won't help.
function isModelUnavailable(err) {
  const msg = String((err && err.message) || err || '');
  return /429|Too Many Requests|quota|RESOURCE_EXHAUSTED/i.test(msg)
    || /\b404\b|is not found|not supported for/i.test(msg);
}

// Map AI-service failures to messages fit for the chat UI. Returns null for
// anything that isn't clearly an AI-service problem (caller keeps its 500).
function friendlyError(err) {
  const msg = String((err && err.message) || err || '');
  if (/GEMINI_API_KEY not set/i.test(msg)) {
    return { status: 503, message: 'The AI assistant is not configured yet (missing API key). Ask the administrator to set GEMINI_API_KEY.' };
  }
  if (/429|Too Many Requests|quota|RESOURCE_EXHAUSTED/i.test(msg)) {
    return { status: 503, message: 'The AI assistant is busy right now (rate limit reached). Please try again in a minute.' };
  }
  if (/\b404\b|is not found|not supported for/i.test(msg)) {
    return { status: 503, message: 'The AI model is unavailable right now. Please try again shortly — if it persists, the model name needs updating.' };
  }
  return null;
}

async function callModel({ systemPrompt, tools, messages, modelName = DEFAULT_MODEL }) {
  const client = getClient();

  const callOnce = async (name) => {
    const model = client.getGenerativeModel({
      model: name,
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
    return model.generateContent({ contents: toGeminiContents(messages) });
  };

  let result;
  try {
    result = await callOnce(modelName);
  } catch (err) {
    if (isModelUnavailable(err) && FALLBACK_MODEL && FALLBACK_MODEL !== modelName) {
      console.warn(`Gemini model "${modelName}" unavailable (${String(err.message).slice(0, 120)}…) — retrying with "${FALLBACK_MODEL}"`);
      result = await callOnce(FALLBACK_MODEL);
    } else {
      throw err;
    }
  }

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

module.exports = { callModel, friendlyError, _setClientFactory, _resetClientFactory };
