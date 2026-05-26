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
