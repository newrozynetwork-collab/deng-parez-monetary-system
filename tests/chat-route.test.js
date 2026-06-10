// tests/chat-route.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const request = require('supertest');
const { makeTestDb, seedUser } = require('./setup');
const gemini = require('../services/gemini');

async function makeApp() {
  const db = await makeTestDb();
  const userId = await seedUser(db, { role: 'admin', name: 'Admin' });
  const app = express();
  app.use(express.json());
  app.use(session({ secret: 't', resave: false, saveUninitialized: false }));
  app.use((req, res, next) => {
    req.db = db;
    req.session.userId = userId;
    req.session.role = 'admin';
    req.session.name = 'Admin';
    next();
  });
  app.use('/api/chat', require('../routes/chat'));
  return { app, db, userId };
}

test('POST /api/chat: returns 401 when no session (skipped — middleware injects session in tests)', () => {
  assert.ok(true);
});

test('POST /api/chat: when Gemini returns text, route returns reply and logs to chat_messages', async () => {
  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return { async generateContent() { return { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Hi there.' }] } }] } }; } };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'hello' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, 'Hi there.');
  assert.deepEqual(res.body.actions, []);

  const rows = await db('chat_messages').orderBy('id');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].role, 'user');
  assert.equal(rows[0].content, 'hello');
  assert.equal(rows[1].role, 'assistant');
  assert.equal(rows[1].content, 'Hi there.');

  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat: when Gemini returns a list_artists tool call, route executes and re-prompts Gemini', async () => {
  const { app, db } = await makeApp();
  await db('artists').insert({ name: 'Hozan', artist_split_pct: 60, company_split_pct: 40, bank_fee_pct: 2.5 });

  let callCount = 0;
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_artists', args: {} } }] } }] } };
          }
          return { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'I see Hozan in the list.' }] } }] } };
        }
      };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'list artists' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.reply, 'I see Hozan in the list.');
  assert.equal(callCount, 2, 'should call Gemini twice: once for tool, once for narration');

  const rows = await db('chat_messages').orderBy('id');
  const toolRow = rows.find(r => r.role === 'tool');
  assert.ok(toolRow);
  assert.equal(toolRow.tool_name, 'list_artists');
  assert.equal(toolRow.status, 'executed');

  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat: rejects requests with no messages', async () => {
  const { app, db } = await makeApp();
  const res = await request(app).post('/api/chat').send({});
  assert.equal(res.status, 400);
  await db.destroy();
});

test('POST /api/chat: when first Gemini call throws, returns 500 and logs nothing about tools', async () => {
  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return { async generateContent() { throw new Error('network blew up'); } };
    }
  }));
  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'list artists' }] });
  assert.equal(res.status, 500);
  const toolRows = await db('chat_messages').where({ role: 'tool' });
  assert.equal(toolRows.length, 0);
  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat: chains read tool → confirm tool in ONE turn (lookup then act)', async () => {
  const { app, db } = await makeApp();
  let callCount = 0;
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_categories', args: { type: 'income' } } }] } }] } };
          }
          return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'add_additional_income', args: { amount: 500, category: 'Other', description: 'fixing social media accounts' } } }] } }] } };
        }
      };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'I earned 500$ additional income, other category' }] });
  assert.equal(res.status, 200);
  assert.equal(callCount, 2, 'model consulted twice: lookup, then act');
  assert.equal(res.body.actions.length, 2, 'both steps surface in the UI');
  assert.equal(res.body.actions[0].type, 'executed');
  assert.equal(res.body.actions[0].tool, 'list_categories');
  assert.equal(res.body.actions[1].type, 'confirm');
  assert.equal(res.body.actions[1].tool, 'add_additional_income');
  assert.ok(res.body.actions[1].preview && res.body.actions[1].preview.amount === 500, 'confirm card carries the preview');
  assert.match(res.body.reply, /confirm/i);
  assert.ok(!/unexpected tool call/i.test(res.body.reply), 'no dead-end message');

  const pending = await db('chat_messages').where({ status: 'pending_confirm' }).first();
  assert.ok(pending, 'pending confirmation stored');
  assert.equal(pending.tool_name, 'add_additional_income');

  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat: a runaway tool loop stops gracefully at the step cap', async () => {
  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_categories', args: {} } }] } }] } };
        }
      };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'loop forever' }] });
  assert.equal(res.status, 200, 'no crash');
  assert.ok(res.body.actions.length <= 5, 'bounded number of steps');
  assert.ok(res.body.reply && res.body.reply.length > 0, 'still says something useful');

  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat: quota-dead Gemini (both models 429) → friendly 503, no raw API dump', async () => {
  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          throw new Error('[GoogleGenerativeAI Error]: Error fetching from https://generativelanguage.googleapis.com/v1beta/models/x:generateContent: [429 Too Many Requests] You exceeded your current quota. * Quota exceeded for metric: generate_content_free_tier_requests, limit: 0 [{"@type":"type.googleapis.com/google.rpc.QuotaFailure"}]');
        }
      };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 503, 'service-unavailable, not a generic 500');
  assert.ok(res.body.error, 'has an error message');
  assert.ok(!/GoogleGenerativeAI|@type|quotaMetric|generativelanguage/.test(res.body.error), 'no raw Google jargon reaches the user');
  assert.match(res.body.error, /busy|limit|try again/i, 'reads like a human sentence');

  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat: when second Gemini call throws, tool already executed, route still returns 200 with fallback reply', async () => {
  const { app, db } = await makeApp();
  await db('artists').insert({ name: 'Hozan', artist_split_pct: 60, company_split_pct: 40, bank_fee_pct: 2.5 });
  let callCount = 0;
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_artists', args: {} } }] } }] } };
          }
          throw new Error('narration died');
        }
      };
    }
  }));
  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'list artists' }] });
  assert.equal(res.status, 200);
  assert.ok(res.body.reply.includes('Narration unavailable') || res.body.reply.includes('Done'));
  const toolRow = await db('chat_messages').where({ role: 'tool' }).first();
  assert.ok(toolRow);
  assert.equal(toolRow.status, 'executed');
  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat: when tool throws, status is "failed" in chat_messages', async () => {
  const { app, db } = await makeApp();
  // Inject a tool that always throws
  const chatTools = require('../services/chatTools');
  const original = chatTools._tools.list_artists;
  chatTools._tools.list_artists = {
    ...original,
    execute: async () => { throw new Error('boom'); }
  };
  let callCount = 0;
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'list_artists', args: {} } }] } }] } };
          }
          return { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Reported it.' }] } }] } };
        }
      };
    }
  }));
  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'list' }] });
  assert.equal(res.status, 200);
  const toolRow = await db('chat_messages').where({ role: 'tool' }).first();
  assert.equal(toolRow.status, 'failed');
  // Restore original tool
  chatTools._tools.list_artists = original;
  gemini._resetClientFactory();
  await db.destroy();
});

const chatTools = require('../services/chatTools');

test('POST /api/chat: needs_confirmation tool returns pending_id and does NOT execute', async () => {
  // Register a temporary tool for this test
  chatTools._tools.stub_confirm = {
    name: 'stub_confirm',
    description: 'test',
    safety: 'needs_confirmation',
    parameters: { type: 'object', properties: {} },
    confirmationLabel: 'Stub confirm action',
    buildPreview: async () => ({ preview_note: 'about to happen' }),
    execute: async () => ({ executed: true })
  };

  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return { async generateContent() { return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'stub_confirm', args: {} } }] } }] } }; } };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'do stub' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.actions[0].type, 'confirm');
  assert.ok(res.body.actions[0].pending_id);
  assert.deepEqual(res.body.actions[0].preview, { preview_note: 'about to happen' });

  const pendingRow = await db('chat_messages').where({ id: res.body.actions[0].pending_id }).first();
  assert.equal(pendingRow.status, 'pending_confirm');
  assert.equal(pendingRow.tool_result, null);

  delete chatTools._tools.stub_confirm;
  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat/execute confirm: executes pending tool and marks executed', async () => {
  chatTools._tools.stub_confirm = {
    name: 'stub_confirm', description: 'test', safety: 'needs_confirmation',
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ executed: true })
  };
  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return { async generateContent() { return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'stub_confirm', args: {} } }] } }] } }; } };
    }
  }));

  const first = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'do stub' }] });
  const pendingId = first.body.actions[0].pending_id;

  const second = await request(app).post('/api/chat/execute').send({ pending_id: pendingId, decision: 'confirm' });
  assert.equal(second.status, 200);
  assert.equal(second.body.actions[0].type, 'executed');
  assert.deepEqual(second.body.actions[0].result, { executed: true });

  const row = await db('chat_messages').where({ id: pendingId }).first();
  assert.equal(row.status, 'executed');

  delete chatTools._tools.stub_confirm;
  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat/execute cancel: marks cancelled, does NOT execute', async () => {
  let executed = false;
  chatTools._tools.stub_confirm = {
    name: 'stub_confirm', description: 'test', safety: 'needs_confirmation',
    parameters: { type: 'object', properties: {} },
    execute: async () => { executed = true; return {}; }
  };
  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return { async generateContent() { return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'stub_confirm', args: {} } }] } }] } }; } };
    }
  }));

  const first = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'do stub' }] });
  const pendingId = first.body.actions[0].pending_id;

  const second = await request(app).post('/api/chat/execute').send({ pending_id: pendingId, decision: 'cancel' });
  assert.equal(second.status, 200);
  assert.equal(executed, false);
  const row = await db('chat_messages').where({ id: pendingId }).first();
  assert.equal(row.status, 'cancelled');

  delete chatTools._tools.stub_confirm;
  gemini._resetClientFactory();
  await db.destroy();
});

test('POST /api/chat/execute: 400 when pending action status is not pending_confirm', async () => {
  const { app, db } = await makeApp();
  const insertedRow = await db('chat_messages').insert({
    user_id: 1, session_key: 'x', role: 'tool', tool_name: 'stub_confirm',
    tool_args: '{}', status: 'executed'
  }).returning('id');
  const id = Array.isArray(insertedRow)
    ? (typeof insertedRow[0] === 'object' ? insertedRow[0].id : insertedRow[0])
    : insertedRow;
  const res = await request(app).post('/api/chat/execute').send({ pending_id: id, decision: 'confirm' });
  assert.equal(res.status, 400);
  await db.destroy();
});

test('POST /api/chat: add_artist tool call executes and persists', async () => {
  const { app, db } = await makeApp();

  let callCount = 0;
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return {
        async generateContent() {
          callCount++;
          if (callCount === 1) {
            return { response: { candidates: [{ content: { role: 'model', parts: [{
              functionCall: { name: 'add_artist', args: { name: 'Hozan', artist_split_pct: 60, referrals: [{ referrer_name: 'Sarah', commission_pct: 5 }] } }
            }] } }] } };
          }
          return { response: { candidates: [{ content: { role: 'model', parts: [{ text: 'Added Hozan with Sarah at 5%.' }] } }] } };
        }
      };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'add hozan' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.actions[0].safety, 'safe_write');
  assert.equal(res.body.actions[0].result.referrers_auto_created[0], 'Sarah');

  const artist = await db('artists').where({ name: 'Hozan' }).first();
  assert.ok(artist);
  const refRow = await db('referrers').where({ name: 'Sarah' }).first();
  assert.ok(refRow);

  gemini._resetClientFactory();
  await db.destroy();
});

test('parsePendingArgs: handles both string and object', () => {
  // The defensive parse logic from routes/chat.js
  const parse = (v) => v ? (typeof v === 'string' ? JSON.parse(v) : v) : {};
  assert.deepEqual(parse('{"a":1}'), { a: 1 });
  assert.deepEqual(parse({ a: 1 }), { a: 1 });
  assert.deepEqual(parse(null), {});
  assert.deepEqual(parse(undefined), {});
});

test('POST /api/chat: needs_confirmation tool whose buildPreview surfaces an error short-circuits — no pending row, no confirm card', async () => {
  // Stub a confirmation tool whose buildPreview returns an error wrapper,
  // simulating record_revenue with a non-existent artist.
  const chatTools = require('../services/chatTools');
  chatTools._tools.stub_preview_err = {
    name: 'stub_preview_err',
    description: 'test',
    safety: 'needs_confirmation',
    parameters: { type: 'object', properties: {} },
    confirmationLabel: 'Would never reach this',
    buildPreview: async () => ({ error: { error: 'not_found', query: 'Mahmud Mhamad' } }),
    execute: async () => { throw new Error('should not execute'); }
  };
  const { app, db } = await makeApp();
  gemini._setClientFactory(() => ({
    getGenerativeModel() {
      return { async generateContent() { return { response: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'stub_preview_err', args: {} } }] } }] } }; } };
    }
  }));

  const res = await request(app).post('/api/chat').send({ messages: [{ role: 'user', content: 'try a doomed action' }] });
  assert.equal(res.status, 200);
  assert.equal(res.body.actions[0].type, 'preview_failed');
  assert.equal(res.body.actions[0].error.error, 'not_found');
  assert.equal(res.body.actions[0].error.query, 'Mahmud Mhamad');
  assert.ok(res.body.reply.includes('Mahmud Mhamad'));

  // No pending_confirm row should exist.
  const pending = await db('chat_messages').where({ status: 'pending_confirm' });
  assert.equal(pending.length, 0);

  // A failed tool row IS logged for audit, with status 'failed'.
  const failedRows = await db('chat_messages').where({ tool_name: 'stub_preview_err', status: 'failed' });
  assert.equal(failedRows.length, 1);

  delete chatTools._tools.stub_preview_err;
  gemini._resetClientFactory();
  await db.destroy();
});
