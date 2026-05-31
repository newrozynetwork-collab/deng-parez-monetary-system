# Chat Assistant — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a conversational data-entry layer (`/chat` page + `/api/chat` route) to `deng-parez-monetary-system`, covering v1 scope: artists and revenue flows via Google Gemini tool-calling.

**Architecture:** New Express route mounted at `/api/chat` calls Gemini 2.5 Flash with a typed tool catalog (`services/chatTools.js`). Read tools and safe additions auto-execute; updates/deletes/revenue go through a server-authoritative confirmation pipeline (`/api/chat/execute` with `pending_id` stored in a new `chat_messages` table). Frontend is a new Mendy-themed page that talks to the route via `App.api()`.

**Tech Stack:** Node.js / Express 4 / Knex 3 (PG in prod, SQLite locally) — all existing. Adds `@google/generative-ai` for Gemini and `supertest` for HTTP tests. Tests use Node's built-in `node:test` runner.

**Spec:** `docs/superpowers/specs/2026-05-26-chat-assistant-design.md`

---

## Phase 1 — Foundation

### Task 1: Project setup

**Files:**
- Modify: `package.json`
- Modify: `.env.example`
- Create: `docs/superpowers/plans/.gitkeep` (only if `docs/` doesn't already exist)

- [ ] **Step 1: Install Gemini SDK**

```bash
cd "C:\Users\PC\Documents\GitHub\deng-parez-monetary-system"
npm install @google/generative-ai
```

Expected: `package.json` `dependencies` gains `"@google/generative-ai": "^0.21.0"` (or current latest).

- [ ] **Step 2: Install supertest as a dev dependency**

```bash
npm install --save-dev supertest
```

Expected: `package.json` gains `devDependencies.supertest`.

- [ ] **Step 3: Add `test` script to `package.json`**

Edit `package.json` `scripts` block. After the existing `"setup"` line, add:

```json
"test": "node --test tests/"
```

Final `scripts` block should look like:

```json
"scripts": {
  "start": "node server.js",
  "dev": "node server.js",
  "migrate": "npx knex migrate:latest",
  "seed": "npx knex seed:run",
  "setup": "npx knex migrate:latest && npx knex seed:run",
  "test": "node --test tests/"
}
```

- [ ] **Step 4: Add `GEMINI_API_KEY` to `.env.example`**

Append to `.env.example`:

```
# Google Gemini API key for the /chat assistant (free tier OK)
GEMINI_API_KEY=
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore: add Gemini SDK and supertest, scaffold test script"
```

---

### Task 2: Database migration for chat_messages

**Files:**
- Create: `db/migrations/010_chat_messages.js`

- [ ] **Step 1: Create the migration file**

Create `db/migrations/010_chat_messages.js` with this exact content:

```js
exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('chat_messages'))) {
    await knex.schema.createTable('chat_messages', (t) => {
      t.increments('id').primary();
      t.integer('user_id').references('id').inTable('users').onDelete('CASCADE');
      t.string('session_key', 64);
      t.string('role', 16).notNullable();
      t.text('content');
      t.string('tool_name', 64);
      t.json('tool_args');
      t.json('tool_result');
      t.string('status', 16);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['user_id', 'created_at']);
      t.index(['session_key']);
    });
  }
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('chat_messages');
};
```

- [ ] **Step 2: Run the migration locally**

```bash
npx knex migrate:latest
```

Expected output includes `Batch X run: 1 migrations` mentioning `010_chat_messages.js`. If it says "already up to date" without that file, the file path is wrong — check that you saved into `db/migrations/`.

- [ ] **Step 3: Verify the table exists in the local SQLite DB**

```bash
node -e "const knex=require('knex')(require('./knexfile')); knex.schema.hasTable('chat_messages').then(r=>{console.log('chat_messages exists:',r); process.exit(0);})"
```

Expected output: `chat_messages exists: true`

- [ ] **Step 4: Commit**

```bash
git add db/migrations/010_chat_messages.js
git commit -m "feat(db): migration 010 — chat_messages table for audit trail"
```

---

### Task 3: Test infrastructure smoke test

**Files:**
- Create: `tests/setup.js`
- Create: `tests/smoke.test.js`

- [ ] **Step 1: Create `tests/setup.js` with the in-memory DB helper**

```js
const knex = require('knex');
const path = require('path');

async function makeTestDb() {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') }
  });
  await db.migrate.latest();
  return db;
}

async function seedUser(db, { role = 'admin', name = 'Tester' } = {}) {
  const [idObj] = await db('users').insert({
    username: `t_${Math.random().toString(36).slice(2, 8)}`,
    password_hash: 'unused',
    role,
    name
  }).returning('id');
  return typeof idObj === 'object' ? idObj.id : idObj;
}

module.exports = { makeTestDb, seedUser };
```

- [ ] **Step 2: Create `tests/smoke.test.js`**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTestDb } = require('./setup');

test('smoke: in-memory db boots and has chat_messages table', async () => {
  const db = await makeTestDb();
  const exists = await db.schema.hasTable('chat_messages');
  assert.equal(exists, true);
  await db.destroy();
});
```

- [ ] **Step 3: Run the smoke test**

```bash
npm test
```

Expected: `1 passing` (or `# pass 1` in node:test output). If you see "Cannot find module 'sqlite3'", run `npm install` first.

- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test: add node:test infrastructure with in-memory DB helper"
```

---

## Phase 2 — Building blocks

### Task 4: Backfill calculator tests

**Why:** The chat will lean heavily on `services/calculator.js`. It's untested today. Add coverage now so we catch regressions later.

**Files:**
- Create: `tests/calculator.test.js`

- [ ] **Step 1: Write the test file**

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculate } = require('../services/calculator');

test('calculator: basic 60/40 split with no referrals', () => {
  const r = calculate({
    grossRevenue: 1000,
    bankFeePct: 2.5,
    artistSplitPct: 60,
    companySplitPct: 40,
    referralLevels: []
  });
  assert.equal(r.bankFee, 25);
  assert.equal(r.netRevenue, 975);
  assert.equal(r.artistShare, 585);     // 975 * 0.60
  assert.equal(r.companyGross, 390);    // 975 * 0.40
  assert.equal(r.companyNet, 390);
  assert.equal(r.referralBreakdown.length, 0);
  assert.equal(r.totalReferrals, 0);
});

test('calculator: with L1 5% referral takes from company gross', () => {
  const r = calculate({
    grossRevenue: 5000,
    bankFeePct: 2.5,
    artistSplitPct: 60,
    companySplitPct: 40,
    referralLevels: [{ level: 1, referrerName: 'Sarah', commissionPct: 5 }]
  });
  assert.equal(r.bankFee, 125);
  assert.equal(r.netRevenue, 4875);
  assert.equal(r.artistShare, 2925);
  assert.equal(r.companyGross, 1950);
  assert.equal(r.referralBreakdown[0].amount, 97.5);  // 1950 * 0.05
  assert.equal(r.companyNet, 1852.5);
});

test('calculator: multiple referral levels each take from companyGross', () => {
  const r = calculate({
    grossRevenue: 1000,
    bankFeePct: 0,
    artistSplitPct: 50,
    companySplitPct: 50,
    referralLevels: [
      { level: 1, referrerName: 'L1', commissionPct: 10 },
      { level: 2, referrerName: 'L2', commissionPct: 5 }
    ]
  });
  assert.equal(r.companyGross, 500);
  assert.equal(r.referralBreakdown[0].amount, 50);  // 500 * 0.10
  assert.equal(r.referralBreakdown[1].amount, 25);  // 500 * 0.05
  assert.equal(r.totalReferrals, 75);
  assert.equal(r.companyNet, 425);
});

test('calculator: handles undefined referralLevels gracefully', () => {
  const r = calculate({
    grossRevenue: 100,
    bankFeePct: 0,
    artistSplitPct: 100,
    companySplitPct: 0,
    referralLevels: undefined
  });
  assert.equal(r.artistShare, 100);
  assert.equal(r.referralBreakdown.length, 0);
});
```

- [ ] **Step 2: Run the tests**

```bash
npm test
```

Expected: 4 calculator tests + 1 smoke test all pass.

- [ ] **Step 3: Commit**

```bash
git add tests/calculator.test.js
git commit -m "test: backfill unit tests for revenue calculator"
```

---

### Task 5: Gemini service wrapper

**Files:**
- Create: `services/gemini.js`
- Create: `tests/gemini.test.js`

The service uses dependency injection: a module-level `clientFactory` defaults to the real Gemini client but can be replaced in tests.

- [ ] **Step 1: Write the failing test**

```js
// tests/gemini.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const gemini = require('../services/gemini');

test('gemini.callModel: builds request with system prompt, tools, and messages', async () => {
  const calls = [];
  gemini._setClientFactory(() => ({
    getGenerativeModel({ model, systemInstruction, tools }) {
      return {
        async generateContent({ contents }) {
          calls.push({ model, systemInstruction, tools, contents });
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
```

- [ ] **Step 2: Run the test, confirm it fails**

```bash
npm test
```

Expected: failure with "Cannot find module '../services/gemini'" — the service file doesn't exist yet.

- [ ] **Step 3: Create `services/gemini.js`**

```js
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

async function callModel({ systemPrompt, tools, messages, modelName = 'gemini-2.5-flash' }) {
  const client = getClient();
  const model = client.getGenerativeModel({
    model: modelName,
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    tools: toGeminiTools(tools)
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
```

- [ ] **Step 4: Run the test, confirm it passes**

```bash
npm test
```

Expected: all tests pass (5 calculator + 1 smoke + 2 gemini).

- [ ] **Step 5: Commit**

```bash
git add services/gemini.js tests/gemini.test.js
git commit -m "feat: gemini service wrapper with DI for testing"
```

---

## Phase 3 — First read tool end-to-end

### Task 6: Tool catalog scaffold + list_artists tool

**Files:**
- Create: `services/chatTools.js`
- Create: `tests/chatTools.test.js`

- [ ] **Step 1: Write the failing test**

```js
// tests/chatTools.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTestDb } = require('./setup');
const tools = require('../services/chatTools');

async function seedArtist(db, name, opts = {}) {
  const [idObj] = await db('artists').insert({
    name,
    nickname: opts.nickname || null,
    revenue_type: opts.revenue_type || 'both',
    artist_split_pct: opts.artist_split_pct || 60,
    company_split_pct: opts.company_split_pct || 40,
    bank_fee_pct: opts.bank_fee_pct || 2.5
  }).returning('id');
  return typeof idObj === 'object' ? idObj.id : idObj;
}

test('list_artists: returns all artists when no query', async () => {
  const db = await makeTestDb();
  await seedArtist(db, 'Hozan');
  await seedArtist(db, 'Sarah Smith');

  const tool = tools.getTool('list_artists');
  const result = await tool.execute({ db }, {});
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.find(m => m.name === 'Hozan'));
  assert.ok(result.matches.find(m => m.name === 'Sarah Smith'));
  await db.destroy();
});

test('list_artists: filters by case-insensitive substring on name', async () => {
  const db = await makeTestDb();
  await seedArtist(db, 'Hozan');
  await seedArtist(db, 'Sarah Smith');
  await seedArtist(db, 'Sarah Khalid');

  const tool = tools.getTool('list_artists');
  const result = await tool.execute({ db }, { query: 'sarah' });
  assert.equal(result.matches.length, 2);
  assert.ok(result.matches.every(m => m.name.toLowerCase().includes('sarah')));
  await db.destroy();
});

test('list_artists: returns referrals_count', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert([
    { artist_id: aid, level: 1, referrer_name: 'Sarah', commission_pct: 5 },
    { artist_id: aid, level: 2, referrer_name: 'Ali', commission_pct: 3 }
  ]);

  const tool = tools.getTool('list_artists');
  const result = await tool.execute({ db }, {});
  const hozan = result.matches.find(m => m.name === 'Hozan');
  assert.equal(hozan.referrals_count, 2);
  await db.destroy();
});

test('tool catalog: getTool returns undefined for unknown tool', () => {
  assert.equal(tools.getTool('nonexistent_xyz'), undefined);
});

test('tool catalog: listTools returns array of {name, description, parameters, safety}', () => {
  const list = tools.listTools();
  assert.ok(Array.isArray(list));
  const la = list.find(t => t.name === 'list_artists');
  assert.ok(la);
  assert.equal(la.safety, 'read');
  assert.equal(typeof la.description, 'string');
  assert.equal(la.parameters.type, 'object');
});
```

- [ ] **Step 2: Run, confirm failure**

```bash
npm test
```

Expected: failure with "Cannot find module '../services/chatTools'".

- [ ] **Step 3: Create `services/chatTools.js`**

```js
const tools = {};

function defineTool(spec) {
  tools[spec.name] = spec;
}

defineTool({
  name: 'list_artists',
  description: 'Search or list artists. Use this to find an artist by partial name before any other artist-targeted action. Returns matches with id, name, splits, and referral count.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional case-insensitive substring filter on name or nickname. Omit to list all artists.' }
    }
  },
  async execute({ db }, args) {
    const q = (args && args.query) ? String(args.query).trim() : '';
    let query = db('artists')
      .select(
        'artists.id', 'artists.name', 'artists.nickname',
        'artists.artist_split_pct', 'artists.company_split_pct', 'artists.bank_fee_pct',
        'artists.contract_status'
      )
      .leftJoin('referral_levels', 'referral_levels.artist_id', 'artists.id')
      .count('referral_levels.id as referrals_count')
      .groupBy('artists.id')
      .orderBy('artists.name');

    if (q) {
      query = query.where(function () {
        this.whereRaw('LOWER(artists.name) LIKE ?', [`%${q.toLowerCase()}%`])
          .orWhereRaw('LOWER(COALESCE(artists.nickname, \'\')) LIKE ?', [`%${q.toLowerCase()}%`]);
      });
    }

    const rows = await query;
    return {
      matches: rows.map(r => ({
        id: r.id,
        name: r.name,
        nickname: r.nickname,
        artist_split_pct: parseFloat(r.artist_split_pct),
        company_split_pct: parseFloat(r.company_split_pct),
        bank_fee_pct: parseFloat(r.bank_fee_pct),
        contract_status: r.contract_status,
        referrals_count: parseInt(r.referrals_count, 10)
      }))
    };
  }
});

function getTool(name) { return tools[name]; }
function listTools() {
  return Object.values(tools).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    safety: t.safety
  }));
}

module.exports = { getTool, listTools, _tools: tools };
```

- [ ] **Step 4: Run, confirm pass**

```bash
npm test
```

Expected: all tests pass (calculator + smoke + gemini + 5 new chatTools).

- [ ] **Step 5: Commit**

```bash
git add services/chatTools.js tests/chatTools.test.js
git commit -m "feat(chat): tool catalog scaffold + list_artists read tool"
```

---

### Task 7: Chat route with tool dispatch

**Files:**
- Create: `routes/chat.js`
- Create: `tests/chat-route.test.js`
- Modify: `server.js`

- [ ] **Step 1: Write the failing route integration test**

```js
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
```

- [ ] **Step 2: Run the tests, confirm they fail**

```bash
npm test
```

Expected: failure ("Cannot find module '../routes/chat'").

- [ ] **Step 3: Create `routes/chat.js`**

```js
const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const chatTools = require('../services/chatTools');
const gemini = require('../services/gemini');

const SYSTEM_PROMPT = `You are the chat assistant for the Deng Parez music label monetary system.
Be terse and precise. Help the admin add, update, query, and record records.

Rules:
- Always resolve names via list_artists or list_referrers before any artist- or referrer-targeted action.
- Never guess between candidates. If a lookup returns multiple matches, ask which one.
- When a tool auto-creates side effects (e.g. add_artist creating a new referrer), disclose it in your reply.
- For revenue: call preview_revenue_split first if the user only gives an amount, so they can see the breakdown.
- Keep replies short. The UI shows tool results separately — don't restate raw numbers when a card will render them.`;

function pickSessionKey(req) {
  return req.sessionID ? String(req.sessionID).slice(0, 64) : 'unknown';
}

async function logMessage(db, fields) {
  await db('chat_messages').insert(fields);
}

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const sessionKey = pickSessionKey(req);
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'user',
        content: String(last.content || '')
      });
    }

    const toolDefs = chatTools.listTools();
    const truncated = messages.slice(-40);

    const first = await gemini.callModel({
      systemPrompt: SYSTEM_PROMPT,
      tools: toolDefs,
      messages: truncated
    });

    if (first.kind === 'text') {
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'assistant',
        content: first.text
      });
      return res.json({ reply: first.text, actions: [] });
    }

    const tool = chatTools.getTool(first.toolName);
    if (!tool) {
      const msg = `I tried to use an unknown tool: ${first.toolName}`;
      await logMessage(req.db, { user_id: req.session.userId, session_key: sessionKey, role: 'assistant', content: msg });
      return res.json({ reply: msg, actions: [] });
    }

    let toolResult;
    try {
      toolResult = await tool.execute({ db: req.db, session: req.session }, first.toolArgs);
    } catch (err) {
      toolResult = { error: 'execution_failed', message: err.message };
    }

    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: sessionKey,
      role: 'tool',
      tool_name: first.toolName,
      tool_args: JSON.stringify(first.toolArgs),
      tool_result: JSON.stringify(toolResult),
      status: 'executed'
    });

    const second = await gemini.callModel({
      systemPrompt: SYSTEM_PROMPT,
      tools: toolDefs,
      messages: [
        ...truncated,
        { role: 'assistant', parts: [{ functionCall: { name: first.toolName, args: first.toolArgs } }] },
        { role: 'tool', parts: [{ functionResponse: { name: first.toolName, response: toolResult } }] }
      ]
    });

    const replyText = second.kind === 'text' ? second.text : '(unexpected tool call — stopping for this turn)';
    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: sessionKey,
      role: 'assistant',
      content: replyText
    });

    return res.json({
      reply: replyText,
      actions: [{ type: 'executed', tool: first.toolName, args: first.toolArgs, result: toolResult }]
    });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 4: Mount the route in `server.js`**

Open `server.js`. After the line `app.use('/api/payments', require('./routes/payments'));` add:

```js
app.use('/api/chat', require('./routes/chat'));
```

(Just one new line. Don't remove or reorder anything else.)

- [ ] **Step 5: Run the tests, confirm they pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add routes/chat.js tests/chat-route.test.js server.js
git commit -m "feat(chat): /api/chat route with Gemini tool dispatch and audit logging"
```

---

## Phase 4 — Remaining read tools

### Task 8: get_artist, list_referrers, list_recent_revenue, preview_revenue_split

**Files:**
- Modify: `services/chatTools.js`
- Modify: `tests/chatTools.test.js`

These all follow the same pattern as `list_artists`. Add each tool, with a test for the happy path and one for the resolution-error path where applicable.

- [ ] **Step 1: Add shared resolveArtist / resolveReferrer helpers**

Append to `services/chatTools.js` just above `function getTool(name)`:

```js
async function resolveArtist(db, idOrName) {
  if (idOrName === undefined || idOrName === null || idOrName === '') {
    return { error: 'not_found', query: '' };
  }
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const a = await db('artists').where({ id: parseInt(idOrName, 10) }).first();
    return a ? { artist: a } : { error: 'not_found', query: String(idOrName) };
  }
  const q = String(idOrName).trim();
  const rows = await db('artists')
    .whereRaw('LOWER(name) LIKE ?', [`%${q.toLowerCase()}%`])
    .orWhereRaw('LOWER(COALESCE(nickname, \'\')) LIKE ?', [`%${q.toLowerCase()}%`])
    .orderBy('name');
  if (rows.length === 0) return { error: 'not_found', query: q };
  if (rows.length > 1) return { error: 'ambiguous', candidates: rows.map(r => ({ id: r.id, name: r.name })) };
  return { artist: rows[0] };
}

async function resolveReferrer(db, idOrName) {
  if (idOrName === undefined || idOrName === null || idOrName === '') {
    return { error: 'not_found', query: '' };
  }
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const r = await db('referrers').where({ id: parseInt(idOrName, 10) }).first();
    return r ? { referrer: r } : { error: 'not_found', query: String(idOrName) };
  }
  const q = String(idOrName).trim();
  const rows = await db('referrers')
    .whereRaw('LOWER(name) LIKE ?', [`%${q.toLowerCase()}%`])
    .orderBy('name');
  if (rows.length === 0) return { error: 'not_found', query: q };
  if (rows.length > 1) return { error: 'ambiguous', candidates: rows.map(r => ({ id: r.id, name: r.name })) };
  return { referrer: rows[0] };
}
```

- [ ] **Step 2: Add the get_artist tool definition**

Append to `services/chatTools.js` after the `list_artists` definition:

```js
defineTool({
  name: 'get_artist',
  description: 'Get a single artist with their full referral chain. Use after list_artists when the user has picked one.',
  safety: 'read',
  parameters: {
    type: 'object',
    required: ['id_or_name'],
    properties: {
      id_or_name: { type: 'string', description: 'Artist id (numeric string) or name (exact or fuzzy).' }
    }
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return r;
    const referrals = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    return {
      id: r.artist.id,
      name: r.artist.name,
      nickname: r.artist.nickname,
      artist_split_pct: parseFloat(r.artist.artist_split_pct),
      company_split_pct: parseFloat(r.artist.company_split_pct),
      bank_fee_pct: parseFloat(r.artist.bank_fee_pct),
      contract_status: r.artist.contract_status,
      referrals: referrals.map(rl => ({
        level: rl.level,
        referrer_id: rl.referrer_id,
        referrer_name: rl.referrer_name,
        commission_pct: parseFloat(rl.commission_pct)
      }))
    };
  }
});
```

- [ ] **Step 3: Add the list_referrers tool**

```js
defineTool({
  name: 'list_referrers',
  description: 'Search or list referrers from the registry.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      include_inactive: { type: 'boolean' }
    }
  },
  async execute({ db }, args) {
    let q = db('referrers').orderBy('name');
    if (!args.include_inactive) q = q.where({ is_active: true });
    if (args.query) {
      const t = String(args.query).trim().toLowerCase();
      q = q.whereRaw('LOWER(name) LIKE ?', [`%${t}%`]);
    }
    const rows = await q;
    return { matches: rows.map(r => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, is_active: !!r.is_active })) };
  }
});
```

- [ ] **Step 4: Add the list_recent_revenue tool**

```js
defineTool({
  name: 'list_recent_revenue',
  description: 'List recent revenue entries. Optionally filter by artist or by date.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      artist: { type: 'string', description: 'Artist id or name to filter by' },
      limit: { type: 'integer', description: 'Max rows to return (default 10)' },
      since: { type: 'string', description: 'ISO date — only entries with period_start >= this' }
    }
  },
  async execute({ db }, args) {
    const limit = Math.min(Math.max(parseInt(args.limit || 10, 10), 1), 100);
    let q = db('revenue_entries')
      .join('artists', 'revenue_entries.artist_id', 'artists.id')
      .select(
        'revenue_entries.id',
        'artists.name as artist_name',
        'revenue_entries.amount',
        'revenue_entries.source',
        'revenue_entries.period_start',
        'revenue_entries.period_end',
        'revenue_entries.created_at'
      )
      .orderBy('revenue_entries.created_at', 'desc')
      .limit(limit);

    if (args.artist) {
      const r = await resolveArtist(db, args.artist);
      if (r.error) return r;
      q = q.where('revenue_entries.artist_id', r.artist.id);
    }
    if (args.since) q = q.where('revenue_entries.period_start', '>=', args.since);

    const rows = await q;
    return {
      entries: rows.map(r => ({
        id: r.id,
        artist_name: r.artist_name,
        amount: parseFloat(r.amount),
        source: r.source,
        period_start: r.period_start,
        period_end: r.period_end,
        created_at: r.created_at
      }))
    };
  }
});
```

- [ ] **Step 5: Add the preview_revenue_split tool**

```js
const { calculate } = require('./calculator');

defineTool({
  name: 'preview_revenue_split',
  description: 'Compute the revenue split for an artist and a gross amount, without saving. Use whenever the user wants to see what a recorded amount would distribute as.',
  safety: 'read',
  parameters: {
    type: 'object',
    required: ['artist', 'amount'],
    properties: {
      artist: { type: 'string', description: 'Artist id or name' },
      amount: { type: 'number', description: 'Gross revenue amount in dollars' }
    }
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.artist);
    if (r.error) return r;
    const amount = parseFloat(args.amount);
    if (!isFinite(amount) || amount < 0) return { error: 'validation', field: 'amount', message: 'amount must be a non-negative number' };

    const refs = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    const result = calculate({
      grossRevenue: amount,
      bankFeePct: parseFloat(r.artist.bank_fee_pct),
      artistSplitPct: parseFloat(r.artist.artist_split_pct),
      companySplitPct: parseFloat(r.artist.company_split_pct),
      referralLevels: refs.map(rl => ({
        level: rl.level,
        referrerName: rl.referrer_name,
        commissionPct: parseFloat(rl.commission_pct)
      }))
    });
    return { artist_id: r.artist.id, artist_name: r.artist.name, ...result };
  }
});
```

Move the `require('./calculator')` to the top of the file so it's only required once. Final top-of-file should read:

```js
const { calculate } = require('./calculator');

const tools = {};
```

- [ ] **Step 6: Append tests for the new tools**

Append to `tests/chatTools.test.js`:

```js
test('get_artist: returns artist with referrals', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_name: 'Sarah', commission_pct: 5 });
  const res = await tools.getTool('get_artist').execute({ db }, { id_or_name: 'hozan' });
  assert.equal(res.name, 'Hozan');
  assert.equal(res.referrals.length, 1);
  assert.equal(res.referrals[0].referrer_name, 'Sarah');
  await db.destroy();
});

test('get_artist: returns not_found error for missing name', async () => {
  const db = await makeTestDb();
  const res = await tools.getTool('get_artist').execute({ db }, { id_or_name: 'NoOne' });
  assert.equal(res.error, 'not_found');
  await db.destroy();
});

test('get_artist: returns ambiguous error with candidates for fuzzy match', async () => {
  const db = await makeTestDb();
  await seedArtist(db, 'Sarah Smith');
  await seedArtist(db, 'Sarah Khalid');
  const res = await tools.getTool('get_artist').execute({ db }, { id_or_name: 'sarah' });
  assert.equal(res.error, 'ambiguous');
  assert.equal(res.candidates.length, 2);
  await db.destroy();
});

test('list_referrers: filters by query and excludes inactive by default', async () => {
  const db = await makeTestDb();
  await db('referrers').insert([
    { name: 'Sarah', is_active: true },
    { name: 'Ali', is_active: true },
    { name: 'Old Person', is_active: false }
  ]);
  const all = await tools.getTool('list_referrers').execute({ db }, {});
  assert.equal(all.matches.length, 2);
  const filtered = await tools.getTool('list_referrers').execute({ db }, { query: 'sa' });
  assert.equal(filtered.matches.length, 1);
  assert.equal(filtered.matches[0].name, 'Sarah');
  const incInactive = await tools.getTool('list_referrers').execute({ db }, { include_inactive: true });
  assert.equal(incInactive.matches.length, 3);
  await db.destroy();
});

test('preview_revenue_split: returns calculator output for resolved artist', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_name: 'Sarah', commission_pct: 5 });

  const res = await tools.getTool('preview_revenue_split').execute({ db }, { artist: 'hozan', amount: 5000 });
  assert.equal(res.artist_name, 'Hozan');
  assert.equal(res.bankFee, 125);
  assert.equal(res.artistShare, 2925);
  assert.equal(res.referralBreakdown[0].amount, 97.5);
  await db.destroy();
});

test('preview_revenue_split: validation error on negative amount', async () => {
  const db = await makeTestDb();
  await seedArtist(db, 'Hozan');
  const res = await tools.getTool('preview_revenue_split').execute({ db }, { artist: 'hozan', amount: -5 });
  assert.equal(res.error, 'validation');
  await db.destroy();
});

test('list_recent_revenue: returns entries sorted desc by created_at, respects limit', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('revenue_entries').insert([
    { artist_id: aid, amount: 100, source: 'platform', period_start: '2026-01-01', period_end: '2026-01-31' },
    { artist_id: aid, amount: 200, source: 'platform', period_start: '2026-02-01', period_end: '2026-02-28' }
  ]);
  const res = await tools.getTool('list_recent_revenue').execute({ db }, { limit: 1 });
  assert.equal(res.entries.length, 1);
  await db.destroy();
});
```

- [ ] **Step 7: Run tests, confirm pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add services/chatTools.js tests/chatTools.test.js
git commit -m "feat(chat): add read tools — get_artist, list_referrers, list_recent_revenue, preview_revenue_split"
```

---

## Phase 5 — Safe-write tools

### Task 9: add_referrer and add_artist

**Files:**
- Modify: `services/chatTools.js`
- Modify: `tests/chatTools.test.js`

- [ ] **Step 1: Add the add_referrer tool**

Append to `services/chatTools.js` (after the read tools):

```js
defineTool({
  name: 'add_referrer',
  description: 'Create a referrer in the registry. If an inactive referrer with the same name exists, reactivate it. If an active one exists, return the existing record (idempotent).',
  safety: 'safe_write',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      social: { type: 'string' },
      notes: { type: 'string' }
    }
  },
  async execute({ db }, args) {
    const name = String(args.name || '').trim();
    if (!name) return { error: 'validation', field: 'name', message: 'name is required' };

    const existing = await db('referrers').where({ name }).first();
    if (existing) {
      if (existing.is_active) {
        return { id: existing.id, name: existing.name, reactivated: false, already_existed: true };
      }
      await db('referrers').where({ id: existing.id }).update({
        is_active: true,
        phone: args.phone || existing.phone,
        email: args.email || existing.email,
        social: args.social || existing.social,
        notes: args.notes || existing.notes,
        updated_at: db.fn.now()
      });
      return { id: existing.id, name: existing.name, reactivated: true, already_existed: false };
    }

    const inserted = await db('referrers').insert({
      name,
      phone: args.phone || null,
      email: args.email || null,
      social: args.social || null,
      notes: args.notes || null
    }).returning('id');
    const id = Array.isArray(inserted)
      ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
      : inserted;
    return { id, name, reactivated: false, already_existed: false };
  }
});
```

- [ ] **Step 2: Add the add_artist tool**

Append to `services/chatTools.js`:

```js
defineTool({
  name: 'add_artist',
  description: 'Create a new artist record, optionally with a referral chain. If any referral.referrer_name is not yet in the registry, this tool creates the referrer first and reports it via referrers_auto_created. The assistant MUST disclose any auto-created referrers in its reply.',
  safety: 'safe_write',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      nickname: { type: 'string' },
      revenue_type: { type: 'string', enum: ['youtube', 'platform', 'both'] },
      artist_split_pct: { type: 'number' },
      company_split_pct: { type: 'number' },
      bank_fee_pct: { type: 'number' },
      phone: { type: 'string' },
      phone2: { type: 'string' },
      beneficiary: { type: 'string' },
      contract_start: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      contract_end: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      contract_years: { type: 'number' },
      notes: { type: 'string' },
      referrals: {
        type: 'array',
        description: 'Ordered referral chain. Each item gets a level (1, 2, 3...) automatically if not provided.',
        items: {
          type: 'object',
          required: ['referrer_name', 'commission_pct'],
          properties: {
            level: { type: 'integer' },
            referrer_name: { type: 'string' },
            commission_pct: { type: 'number' }
          }
        }
      }
    }
  },
  async execute({ db }, args) {
    const name = String(args.name || '').trim();
    if (!name) return { error: 'validation', field: 'name', message: 'name is required' };

    const inserted = await db('artists').insert({
      name,
      nickname: args.nickname || null,
      revenue_type: args.revenue_type || 'both',
      artist_split_pct: (args.artist_split_pct !== undefined) ? args.artist_split_pct : 60,
      company_split_pct: (args.company_split_pct !== undefined) ? args.company_split_pct : 40,
      bank_fee_pct: (args.bank_fee_pct !== undefined) ? args.bank_fee_pct : 2.5,
      phone: args.phone || null,
      phone2: args.phone2 || null,
      beneficiary: args.beneficiary || null,
      contract_start: args.contract_start || null,
      contract_end: args.contract_end || null,
      contract_years: args.contract_years || null,
      notes: args.notes || null
    }).returning('id');
    const artistId = Array.isArray(inserted)
      ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
      : inserted;

    const autoCreated = [];
    const referralsToInsert = [];
    const referrals = Array.isArray(args.referrals) ? args.referrals : [];

    for (let i = 0; i < referrals.length; i++) {
      const ref = referrals[i];
      const refName = String(ref.referrer_name || '').trim();
      if (!refName) continue;

      let row = await db('referrers').where({ name: refName }).first();
      if (!row) {
        const ins = await db('referrers').insert({ name: refName }).returning('id');
        const newId = Array.isArray(ins) ? (typeof ins[0] === 'object' ? ins[0].id : ins[0]) : ins;
        row = { id: newId, name: refName };
        autoCreated.push(refName);
      } else if (!row.is_active) {
        await db('referrers').where({ id: row.id }).update({ is_active: true, updated_at: db.fn.now() });
      }

      referralsToInsert.push({
        artist_id: artistId,
        level: ref.level || i + 1,
        referrer_id: row.id,
        referrer_name: refName,
        commission_pct: ref.commission_pct
      });
    }

    if (referralsToInsert.length > 0) {
      await db('referral_levels').insert(referralsToInsert);
    }

    return {
      id: artistId,
      name,
      referrals_created: referralsToInsert.length,
      referrers_auto_created: autoCreated
    };
  }
});
```

- [ ] **Step 3: Add tests for the write tools**

Append to `tests/chatTools.test.js`:

```js
test('add_referrer: creates new active referrer', async () => {
  const db = await makeTestDb();
  const res = await tools.getTool('add_referrer').execute({ db }, { name: 'Sarah', phone: '555-1234' });
  assert.ok(res.id);
  assert.equal(res.name, 'Sarah');
  assert.equal(res.reactivated, false);
  assert.equal(res.already_existed, false);
  const row = await db('referrers').where({ id: res.id }).first();
  assert.equal(row.name, 'Sarah');
  assert.equal(row.phone, '555-1234');
  await db.destroy();
});

test('add_referrer: reactivates soft-deleted referrer with same name', async () => {
  const db = await makeTestDb();
  await db('referrers').insert({ name: 'Sarah', is_active: false });
  const res = await tools.getTool('add_referrer').execute({ db }, { name: 'Sarah' });
  assert.equal(res.reactivated, true);
  const row = await db('referrers').where({ id: res.id }).first();
  assert.equal(!!row.is_active, true);
  await db.destroy();
});

test('add_referrer: returns existing record if active duplicate exists (idempotent)', async () => {
  const db = await makeTestDb();
  await db('referrers').insert({ name: 'Sarah', is_active: true });
  const res = await tools.getTool('add_referrer').execute({ db }, { name: 'Sarah' });
  assert.equal(res.already_existed, true);
  assert.equal(res.reactivated, false);
  await db.destroy();
});

test('add_referrer: validation error on empty name', async () => {
  const db = await makeTestDb();
  const res = await tools.getTool('add_referrer').execute({ db }, { name: '   ' });
  assert.equal(res.error, 'validation');
  await db.destroy();
});

test('add_artist: creates artist with defaults', async () => {
  const db = await makeTestDb();
  const res = await tools.getTool('add_artist').execute({ db }, { name: 'Hozan' });
  assert.ok(res.id);
  assert.equal(res.referrals_created, 0);
  assert.equal(res.referrers_auto_created.length, 0);
  const row = await db('artists').where({ id: res.id }).first();
  assert.equal(parseFloat(row.artist_split_pct), 60);
  assert.equal(parseFloat(row.company_split_pct), 40);
  await db.destroy();
});

test('add_artist: with new referral creates the referrer and reports it in referrers_auto_created', async () => {
  const db = await makeTestDb();
  const res = await tools.getTool('add_artist').execute({ db }, {
    name: 'Hozan',
    referrals: [{ referrer_name: 'Sarah', commission_pct: 5 }]
  });
  assert.equal(res.referrals_created, 1);
  assert.deepEqual(res.referrers_auto_created, ['Sarah']);
  const refRow = await db('referrers').where({ name: 'Sarah' }).first();
  assert.ok(refRow);
  const levelRow = await db('referral_levels').where({ artist_id: res.id }).first();
  assert.equal(levelRow.referrer_id, refRow.id);
  assert.equal(parseFloat(levelRow.commission_pct), 5);
  await db.destroy();
});

test('add_artist: with existing referrer reuses it and does NOT report it as auto-created', async () => {
  const db = await makeTestDb();
  await db('referrers').insert({ name: 'Sarah' });
  const res = await tools.getTool('add_artist').execute({ db }, {
    name: 'Hozan',
    referrals: [{ referrer_name: 'Sarah', commission_pct: 5 }]
  });
  assert.equal(res.referrers_auto_created.length, 0);
  assert.equal(res.referrals_created, 1);
  await db.destroy();
});
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add services/chatTools.js tests/chatTools.test.js
git commit -m "feat(chat): add_referrer and add_artist safe-write tools with auto-create disclosure"
```

---

### Task 10: Route extension — safe_write auto-execute path

The route already dispatches and executes any tool. Verify that safe_write tools behave correctly via the route (a new integration test) and add the action-type taxonomy so the UI knows what kind of result it got.

**Files:**
- Modify: `routes/chat.js`
- Modify: `tests/chat-route.test.js`

- [ ] **Step 1: Update the route to include the tool's safety in the response action**

In `routes/chat.js`, find the `return res.json({...})` block at the end of the success path (after the second Gemini call) and replace it with:

```js
    return res.json({
      reply: replyText,
      actions: [{
        type: 'executed',
        tool: first.toolName,
        safety: tool.safety,
        args: first.toolArgs,
        result: toolResult
      }]
    });
```

- [ ] **Step 2: Add integration test for add_artist via the route**

Append to `tests/chat-route.test.js`:

```js
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
```

- [ ] **Step 3: Run tests, confirm pass**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add routes/chat.js tests/chat-route.test.js
git commit -m "feat(chat): expose tool safety in route action response"
```

---

## Phase 6 — Confirmation pipeline

### Task 11: /api/chat/execute and needs_confirmation flow

**Files:**
- Modify: `routes/chat.js`
- Modify: `tests/chat-route.test.js`

- [ ] **Step 1: Update the route to short-circuit needs_confirmation tools**

In `routes/chat.js`, replace the section that currently calls `tool.execute(...)` and the subsequent Gemini call. The new flow:
- If `tool.safety === 'needs_confirmation'`: don't execute. Compute a preview (if the tool supports it via `buildPreview`), store the pending tool call in `chat_messages` with `status='pending_confirm'`, return a `confirm` action.
- Otherwise: execute as before.

Find the block starting with `let toolResult;` and ending with the final `return res.json({...})`. Replace that entire section with:

```js
    if (tool.safety === 'needs_confirmation') {
      let preview = null;
      if (typeof tool.buildPreview === 'function') {
        try { preview = await tool.buildPreview({ db: req.db }, first.toolArgs); } catch (_) { /* preview optional */ }
      }

      const [pendingIdObj] = await req.db('chat_messages').insert({
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'tool',
        tool_name: first.toolName,
        tool_args: JSON.stringify(first.toolArgs),
        status: 'pending_confirm'
      }).returning('id');
      const pendingId = typeof pendingIdObj === 'object' ? pendingIdObj.id : pendingIdObj;

      const replyText = `Please confirm: ${tool.confirmationLabel || first.toolName}`;
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'assistant',
        content: replyText
      });

      return res.json({
        reply: replyText,
        actions: [{
          type: 'confirm',
          pending_id: pendingId,
          tool: first.toolName,
          safety: tool.safety,
          args: first.toolArgs,
          preview
        }]
      });
    }

    let toolResult;
    try {
      toolResult = await tool.execute({ db: req.db, session: req.session }, first.toolArgs);
    } catch (err) {
      toolResult = { error: 'execution_failed', message: err.message };
    }

    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: sessionKey,
      role: 'tool',
      tool_name: first.toolName,
      tool_args: JSON.stringify(first.toolArgs),
      tool_result: JSON.stringify(toolResult),
      status: 'executed'
    });

    const second = await gemini.callModel({
      systemPrompt: SYSTEM_PROMPT,
      tools: toolDefs,
      messages: [
        ...truncated,
        { role: 'assistant', parts: [{ functionCall: { name: first.toolName, args: first.toolArgs } }] },
        { role: 'tool', parts: [{ functionResponse: { name: first.toolName, response: toolResult } }] }
      ]
    });

    const replyText = second.kind === 'text' ? second.text : '(unexpected tool call — stopping for this turn)';
    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: sessionKey,
      role: 'assistant',
      content: replyText
    });

    return res.json({
      reply: replyText,
      actions: [{
        type: 'executed',
        tool: first.toolName,
        safety: tool.safety,
        args: first.toolArgs,
        result: toolResult
      }]
    });
```

- [ ] **Step 2: Add the /api/chat/execute endpoint**

In `routes/chat.js`, before `module.exports = router;`, add:

```js
router.post('/execute', requireAdmin, async (req, res) => {
  try {
    const { pending_id, decision } = req.body;
    if (!pending_id || !['confirm', 'cancel'].includes(decision)) {
      return res.status(400).json({ error: 'pending_id and decision (confirm|cancel) required' });
    }

    const row = await req.db('chat_messages').where({ id: pending_id }).first();
    if (!row) return res.status(404).json({ error: 'pending row not found' });
    if (row.user_id !== req.session.userId) return res.status(403).json({ error: 'not your pending action' });
    if (row.status !== 'pending_confirm') return res.status(400).json({ error: 'pending action no longer valid', status: row.status });

    if (decision === 'cancel') {
      await req.db('chat_messages').where({ id: pending_id }).update({ status: 'cancelled' });
      const msg = 'Cancelled.';
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: row.session_key,
        role: 'assistant',
        content: msg
      });
      return res.json({ reply: msg, actions: [{ type: 'cancelled', pending_id }] });
    }

    const tool = chatTools.getTool(row.tool_name);
    if (!tool) return res.status(500).json({ error: 'tool no longer registered' });

    const args = row.tool_args ? JSON.parse(row.tool_args) : {};
    let toolResult;
    try {
      toolResult = await tool.execute({ db: req.db, session: req.session }, args);
    } catch (err) {
      toolResult = { error: 'execution_failed', message: err.message };
    }

    await req.db('chat_messages').where({ id: pending_id }).update({
      tool_result: JSON.stringify(toolResult),
      status: 'executed'
    });

    const msg = toolResult && toolResult.error
      ? `Tried but ran into a problem: ${toolResult.message || toolResult.error}`
      : 'Done.';
    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: row.session_key,
      role: 'assistant',
      content: msg
    });

    return res.json({
      reply: msg,
      actions: [{ type: 'executed', tool: row.tool_name, safety: tool.safety, args, result: toolResult }]
    });
  } catch (err) {
    console.error('Chat execute error:', err);
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add a confirmation-flow integration test using a stub `needs_confirmation` tool**

Append to `tests/chat-route.test.js`:

```js
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
  const [idObj] = await db('chat_messages').insert({
    user_id: 1, session_key: 'x', role: 'tool', tool_name: 'stub_confirm',
    tool_args: '{}', status: 'executed'
  }).returning('id');
  const id = typeof idObj === 'object' ? idObj.id : idObj;
  const res = await request(app).post('/api/chat/execute').send({ pending_id: id, decision: 'confirm' });
  assert.equal(res.status, 400);
  await db.destroy();
});
```

- [ ] **Step 4: Run tests, confirm pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add routes/chat.js tests/chat-route.test.js
git commit -m "feat(chat): confirmation pipeline — pending state and /api/chat/execute"
```

---

## Phase 7 — Confirmation-required tools

### Task 12: record_revenue

**Files:**
- Modify: `services/chatTools.js`
- Modify: `tests/chatTools.test.js`

- [ ] **Step 1: Add the record_revenue tool with buildPreview**

Append to `services/chatTools.js`:

```js
defineTool({
  name: 'record_revenue',
  description: 'Record a revenue entry for an artist. ALWAYS confirms (money in). The confirmation card shows the full calculator preview.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save this revenue entry?',
  parameters: {
    type: 'object',
    required: ['artist', 'amount', 'period_start', 'period_end'],
    properties: {
      artist: { type: 'string' },
      amount: { type: 'number' },
      period_start: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      period_end: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      source: { type: 'string', enum: ['youtube', 'platform', 'both'] },
      notes: { type: 'string' }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveArtist(db, args.artist);
    if (r.error) return { error: r };
    const refs = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    const calc = calculate({
      grossRevenue: parseFloat(args.amount),
      bankFeePct: parseFloat(r.artist.bank_fee_pct),
      artistSplitPct: parseFloat(r.artist.artist_split_pct),
      companySplitPct: parseFloat(r.artist.company_split_pct),
      referralLevels: refs.map(rl => ({ level: rl.level, referrerName: rl.referrer_name, commissionPct: parseFloat(rl.commission_pct) }))
    });
    return { artist_name: r.artist.name, ...calc, period_start: args.period_start, period_end: args.period_end, source: args.source || r.artist.revenue_type || 'both' };
  },
  async execute({ db, session }, args) {
    const r = await resolveArtist(db, args.artist);
    if (r.error) return r;
    const refs = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    const calc = calculate({
      grossRevenue: parseFloat(args.amount),
      bankFeePct: parseFloat(r.artist.bank_fee_pct),
      artistSplitPct: parseFloat(r.artist.artist_split_pct),
      companySplitPct: parseFloat(r.artist.company_split_pct),
      referralLevels: refs.map(rl => ({ level: rl.level, referrerName: rl.referrer_name, commissionPct: parseFloat(rl.commission_pct) }))
    });

    const inserted = await db('revenue_entries').insert({
      artist_id: r.artist.id,
      amount: parseFloat(args.amount),
      source: args.source || r.artist.revenue_type || 'both',
      period_start: args.period_start,
      period_end: args.period_end,
      notes: args.notes || null,
      created_by: session && session.userId
    }).returning('id');
    const id = Array.isArray(inserted) ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]) : inserted;

    const distributions = [
      { revenue_entry_id: id, recipient_type: 'artist', recipient_name: r.artist.name, amount: calc.artistShare },
      { revenue_entry_id: id, recipient_type: 'company', recipient_name: 'Company', amount: calc.companyNet }
    ];
    calc.referralBreakdown.forEach(rl => {
      distributions.push({ revenue_entry_id: id, recipient_type: 'referral', recipient_name: rl.referrerName, amount: rl.amount });
    });
    distributions.push({ revenue_entry_id: id, recipient_type: 'bank_fee', recipient_name: 'Bank Fee', amount: calc.bankFee });

    await db('revenue_distributions').insert(distributions);

    return { revenue_entry_id: id, artist_name: r.artist.name, calculation: calc };
  }
});
```

- [ ] **Step 2: Add tests**

Append to `tests/chatTools.test.js`:

```js
test('record_revenue.buildPreview: returns full calculator output', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_name: 'Sarah', commission_pct: 5 });
  const preview = await tools.getTool('record_revenue').buildPreview({ db }, {
    artist: 'hozan', amount: 5000, period_start: '2026-05-01', period_end: '2026-05-31'
  });
  assert.equal(preview.artist_name, 'Hozan');
  assert.equal(preview.bankFee, 125);
  assert.equal(preview.artistShare, 2925);
  assert.equal(preview.referralBreakdown[0].amount, 97.5);
  await db.destroy();
});

test('record_revenue.execute: writes one revenue_entries row and N distributions', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_name: 'Sarah', commission_pct: 5 });
  const session = { userId: 1 };
  const res = await tools.getTool('record_revenue').execute({ db, session }, {
    artist: 'hozan', amount: 5000, period_start: '2026-05-01', period_end: '2026-05-31', source: 'platform'
  });
  assert.ok(res.revenue_entry_id);
  const entry = await db('revenue_entries').where({ id: res.revenue_entry_id }).first();
  assert.equal(parseFloat(entry.amount), 5000);
  const dists = await db('revenue_distributions').where({ revenue_entry_id: res.revenue_entry_id });
  // artist + company + 1 referral + bank_fee = 4
  assert.equal(dists.length, 4);
  await db.destroy();
});
```

- [ ] **Step 3: Run, confirm pass**

```bash
npm test
```

- [ ] **Step 4: Commit**

```bash
git add services/chatTools.js tests/chatTools.test.js
git commit -m "feat(chat): record_revenue with calculator preview + confirmation"
```

---

### Task 13: update_artist, update_referrer

**Files:**
- Modify: `services/chatTools.js`
- Modify: `tests/chatTools.test.js`

- [ ] **Step 1: Add update_artist tool**

```js
defineTool({
  name: 'update_artist',
  description: 'Update fields on an existing artist. Confirmation required because splits/fees affect future revenue. If changes include `referrals`, replaces the entire referral chain (matches existing route semantics).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save these artist changes?',
  parameters: {
    type: 'object',
    required: ['id_or_name', 'changes'],
    properties: {
      id_or_name: { type: 'string' },
      changes: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          nickname: { type: 'string' },
          revenue_type: { type: 'string', enum: ['youtube', 'platform', 'both'] },
          artist_split_pct: { type: 'number' },
          company_split_pct: { type: 'number' },
          bank_fee_pct: { type: 'number' },
          phone: { type: 'string' },
          phone2: { type: 'string' },
          beneficiary: { type: 'string' },
          contract_start: { type: 'string' },
          contract_end: { type: 'string' },
          contract_years: { type: 'number' },
          notes: { type: 'string' },
          referrals: {
            type: 'array',
            items: {
              type: 'object',
              required: ['referrer_name', 'commission_pct'],
              properties: {
                level: { type: 'integer' },
                referrer_name: { type: 'string' },
                commission_pct: { type: 'number' }
              }
            }
          }
        }
      }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return { error: r };
    return { current: r.artist, changes: args.changes };
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return r;
    const changes = args.changes || {};
    const { referrals, ...fieldChanges } = changes;
    if (Object.keys(fieldChanges).length > 0) {
      await db('artists').where({ id: r.artist.id }).update(fieldChanges);
    }
    if (Array.isArray(referrals)) {
      await db('referral_levels').where({ artist_id: r.artist.id }).del();
      const inserts = [];
      const autoCreated = [];
      for (let i = 0; i < referrals.length; i++) {
        const ref = referrals[i];
        const refName = String(ref.referrer_name || '').trim();
        if (!refName) continue;
        let row = await db('referrers').where({ name: refName }).first();
        if (!row) {
          const ins = await db('referrers').insert({ name: refName }).returning('id');
          const newId = Array.isArray(ins) ? (typeof ins[0] === 'object' ? ins[0].id : ins[0]) : ins;
          row = { id: newId, name: refName };
          autoCreated.push(refName);
        } else if (!row.is_active) {
          await db('referrers').where({ id: row.id }).update({ is_active: true, updated_at: db.fn.now() });
        }
        inserts.push({
          artist_id: r.artist.id,
          level: ref.level || i + 1,
          referrer_id: row.id,
          referrer_name: refName,
          commission_pct: ref.commission_pct
        });
      }
      if (inserts.length > 0) await db('referral_levels').insert(inserts);
      return { id: r.artist.id, updated: true, referrals_replaced: inserts.length, referrers_auto_created: autoCreated };
    }
    return { id: r.artist.id, updated: true };
  }
});
```

- [ ] **Step 2: Add update_referrer tool**

```js
defineTool({
  name: 'update_referrer',
  description: 'Update a referrer record. A name change cascades to referral_levels.referrer_name for future payouts; historical revenue_distributions rows are NOT rewritten (matches existing route semantics).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save these referrer changes?',
  parameters: {
    type: 'object',
    required: ['id_or_name', 'changes'],
    properties: {
      id_or_name: { type: 'string' },
      changes: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          social: { type: 'string' },
          notes: { type: 'string' }
        }
      }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return { error: r };
    const c = await db('referral_levels').where({ referrer_id: r.referrer.id }).count('* as count').first();
    return { current: r.referrer, changes: args.changes, cascade_rows: parseInt(c.count, 10) };
  },
  async execute({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return r;
    const changes = args.changes || {};
    if (Object.keys(changes).length === 0) return { id: r.referrer.id, updated: false };

    await db('referrers').where({ id: r.referrer.id }).update({ ...changes, updated_at: db.fn.now() });

    if (changes.name && changes.name !== r.referrer.name) {
      await db('referral_levels').where({ referrer_id: r.referrer.id }).update({ referrer_name: changes.name });
    }
    return { id: r.referrer.id, updated: true };
  }
});
```

- [ ] **Step 3: Add tests**

Append to `tests/chatTools.test.js`:

```js
test('update_artist: changes top-level fields', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await tools.getTool('update_artist').execute({ db }, { id_or_name: 'hozan', changes: { nickname: 'H', artist_split_pct: 70, company_split_pct: 30 } });
  const row = await db('artists').where({ id: aid }).first();
  assert.equal(row.nickname, 'H');
  assert.equal(parseFloat(row.artist_split_pct), 70);
  await db.destroy();
});

test('update_artist: with referrals replaces the chain and reports auto-created referrers', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_name: 'Old', commission_pct: 1 });
  const res = await tools.getTool('update_artist').execute({ db }, {
    id_or_name: 'hozan',
    changes: { referrals: [{ referrer_name: 'NewPerson', commission_pct: 4 }] }
  });
  assert.equal(res.referrals_replaced, 1);
  assert.deepEqual(res.referrers_auto_created, ['NewPerson']);
  const levels = await db('referral_levels').where({ artist_id: aid });
  assert.equal(levels.length, 1);
  assert.equal(levels[0].referrer_name, 'NewPerson');
  await db.destroy();
});

test('update_referrer: rename cascades to referral_levels.referrer_name', async () => {
  const db = await makeTestDb();
  const [rObj] = await db('referrers').insert({ name: 'OldName' }).returning('id');
  const rid = typeof rObj === 'object' ? rObj.id : rObj;
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_id: rid, referrer_name: 'OldName', commission_pct: 5 });

  await tools.getTool('update_referrer').execute({ db }, { id_or_name: rid, changes: { name: 'NewName' } });
  const level = await db('referral_levels').where({ artist_id: aid }).first();
  assert.equal(level.referrer_name, 'NewName');
  await db.destroy();
});
```

- [ ] **Step 4: Run, confirm pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add services/chatTools.js tests/chatTools.test.js
git commit -m "feat(chat): update_artist and update_referrer with confirmation"
```

---

### Task 14: delete_artist, delete_referrer

**Files:**
- Modify: `services/chatTools.js`
- Modify: `tests/chatTools.test.js`

- [ ] **Step 1: Add delete_artist tool**

```js
defineTool({
  name: 'delete_artist',
  description: 'Delete an artist. Cascades to referral_levels and revenue_entries. Confirmation required.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this artist and ALL related revenue and referrals?',
  parameters: {
    type: 'object',
    required: ['id_or_name'],
    properties: { id_or_name: { type: 'string' } }
  },
  async buildPreview({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return { error: r };
    const revs = await db('revenue_entries').where({ artist_id: r.artist.id }).count('* as c').first();
    const lvls = await db('referral_levels').where({ artist_id: r.artist.id }).count('* as c').first();
    return {
      artist: { id: r.artist.id, name: r.artist.name },
      cascade: {
        revenue_entries: parseInt(revs.c, 10),
        referral_levels: parseInt(lvls.c, 10)
      }
    };
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return r;
    await db('artists').where({ id: r.artist.id }).del();
    return { id: r.artist.id, deleted: true };
  }
});
```

- [ ] **Step 2: Add delete_referrer tool**

```js
defineTool({
  name: 'delete_referrer',
  description: 'Delete a referrer. Soft-deletes (is_active=false) if any referral_levels reference them; hard-deletes otherwise. Confirmation required.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this referrer?',
  parameters: {
    type: 'object',
    required: ['id_or_name'],
    properties: { id_or_name: { type: 'string' } }
  },
  async buildPreview({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return { error: r };
    const c = await db('referral_levels').where({ referrer_id: r.referrer.id }).count('* as c').first();
    const inUse = parseInt(c.c, 10);
    return { referrer: r.referrer, in_use_on_artists: inUse, mode: inUse > 0 ? 'soft' : 'hard' };
  },
  async execute({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return r;
    const c = await db('referral_levels').where({ referrer_id: r.referrer.id }).count('* as c').first();
    if (parseInt(c.c, 10) > 0) {
      await db('referrers').where({ id: r.referrer.id }).update({ is_active: false, updated_at: db.fn.now() });
      return { id: r.referrer.id, deleted: true, soft: true, artists_affected: parseInt(c.c, 10) };
    }
    await db('referrers').where({ id: r.referrer.id }).del();
    return { id: r.referrer.id, deleted: true, soft: false };
  }
});
```

- [ ] **Step 3: Add tests**

```js
test('delete_artist: removes the row', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await tools.getTool('delete_artist').execute({ db }, { id_or_name: 'hozan' });
  const row = await db('artists').where({ id: aid }).first();
  assert.equal(row, undefined);
  await db.destroy();
});

test('delete_artist.buildPreview: returns cascade counts', async () => {
  const db = await makeTestDb();
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_name: 'X', commission_pct: 1 });
  await db('revenue_entries').insert({ artist_id: aid, amount: 100, source: 'both', period_start: '2026-01-01', period_end: '2026-01-31' });
  const preview = await tools.getTool('delete_artist').buildPreview({ db }, { id_or_name: 'hozan' });
  assert.equal(preview.cascade.referral_levels, 1);
  assert.equal(preview.cascade.revenue_entries, 1);
  await db.destroy();
});

test('delete_referrer: soft-deletes when in use', async () => {
  const db = await makeTestDb();
  const [rObj] = await db('referrers').insert({ name: 'Sarah' }).returning('id');
  const rid = typeof rObj === 'object' ? rObj.id : rObj;
  const aid = await seedArtist(db, 'Hozan');
  await db('referral_levels').insert({ artist_id: aid, level: 1, referrer_id: rid, referrer_name: 'Sarah', commission_pct: 5 });

  const res = await tools.getTool('delete_referrer').execute({ db }, { id_or_name: rid });
  assert.equal(res.soft, true);
  const row = await db('referrers').where({ id: rid }).first();
  assert.equal(!!row.is_active, false);
  await db.destroy();
});

test('delete_referrer: hard-deletes when not in use', async () => {
  const db = await makeTestDb();
  const [rObj] = await db('referrers').insert({ name: 'Sarah' }).returning('id');
  const rid = typeof rObj === 'object' ? rObj.id : rObj;
  const res = await tools.getTool('delete_referrer').execute({ db }, { id_or_name: rid });
  assert.equal(res.soft, false);
  const row = await db('referrers').where({ id: rid }).first();
  assert.equal(row, undefined);
  await db.destroy();
});
```

- [ ] **Step 4: Run, confirm pass**

```bash
npm test
```

- [ ] **Step 5: Commit**

```bash
git add services/chatTools.js tests/chatTools.test.js
git commit -m "feat(chat): delete_artist and delete_referrer with confirmation previews"
```

---

## Phase 8 — UI

### Task 15: chat.html + chat page route

**Files:**
- Create: `public/pages/chat.html`
- Modify: `server.js`

- [ ] **Step 1: Create the chat page HTML**

Create `public/pages/chat.html` with this content. **IMPORTANT:** This file's `<aside class="left-sidebar">` block MUST match the sidebar markup used in the other admin pages. Open `public/pages/dashboard.html` and copy the entire `<aside class="left-sidebar"> ... </aside>` block verbatim, plus the surrounding header HTML. The skeleton below shows ONLY the parts unique to this page; merge them into a copy of `dashboard.html`.

Use `dashboard.html` as your starting template. Copy it to `chat.html`, then make these specific changes:

a) Set `<title>` to `Chat — Deng Parez`.

b) Replace the main content area (`<div class="page-wrapper">` inner content, NOT the sidebar/header) with:

```html
<div class="page-wrapper">
  <div class="page-breadcrumb">
    <div class="row">
      <div class="col-12 d-flex align-items-center">
        <h4 class="page-title">Chat</h4>
        <div class="ml-auto">
          <button id="chat-clear" class="btn btn-sm btn-outline-secondary">Clear conversation</button>
        </div>
      </div>
    </div>
  </div>

  <div class="container-fluid">
    <div class="card">
      <div class="card-body" style="display:flex; flex-direction:column; height:calc(100vh - 220px);">
        <div id="chat-thread" style="flex:1; overflow-y:auto; padding:8px;"></div>
        <form id="chat-form" style="display:flex; gap:8px; align-items:flex-end; margin-top:8px;">
          <button type="button" id="chat-mic" class="btn btn-outline-secondary" title="Speak"><i data-feather="mic"></i></button>
          <textarea id="chat-input" class="form-control" rows="2" placeholder="Type a command..." style="flex:1; resize:vertical;"></textarea>
          <button type="submit" id="chat-send" class="btn btn-primary"><i data-feather="send"></i></button>
        </form>
      </div>
    </div>
  </div>
</div>
```

c) In the script-loading section at the bottom of the body (where dashboard loads `dashboard.js`), replace that line with:

```html
<script src="/app/chat.js"></script>
```

Keep all other script tags (`common.js`, `feather`, `jquery`, `sidebarmenu.js`, etc.) exactly as they are in `dashboard.html`.

d) Add some lightweight chat styles in a `<style>` block in `<head>`:

```html
<style>
  .chat-msg { margin: 8px 0; padding: 8px 12px; border-radius: 12px; max-width: 80%; word-wrap: break-word; }
  .chat-msg-user { background: #f158d0; color: #fff; margin-left: auto; }
  .chat-msg-assistant { background: #f4f4f8; color: #333; margin-right: auto; }
  [data-theme="dark"] .chat-msg-assistant { background: #2a2a36; color: #e8e8e8; }
  .chat-msg-error { background: #fde2e2; color: #a02525; margin-right: auto; }
  .chat-card { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 6px 0; background: #fff; }
  [data-theme="dark"] .chat-card { background: #1f1f29; border-color: #3a3a48; color: #e8e8e8; }
  .chat-card table { width: 100%; }
  .chat-card td { padding: 2px 6px; }
  .chat-confirm-actions { display: flex; gap: 8px; margin-top: 10px; }
  .chat-tool-name { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; }
</style>
```

- [ ] **Step 2: Add the page route in `server.js`**

Find the line `app.get('/payments', (req, res) => ...)` in `server.js`. After it, add:

```js
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pages', 'chat.html')));
```

- [ ] **Step 3: Verify the route loads (manual)**

Start the server in another terminal:
```bash
npm start
```

Open `http://localhost:3000/chat` in a browser. You should see the chat page shell (no behavior yet — that's the next task). Sidebar should render. The thread area should be empty.

- [ ] **Step 4: Commit**

```bash
git add public/pages/chat.html server.js
git commit -m "feat(chat): chat page HTML skeleton with sidebar + composer"
```

---

### Task 16: chat.js controller with message rendering and voice

**Files:**
- Create: `public/app/chat.js`

- [ ] **Step 1: Create `public/app/chat.js`**

```js
(function () {
  let messages = [];

  App.init(function () {
    bindEvents();
    renderThread();
  });

  function bindEvents() {
    $('#chat-form').on('submit', function (e) {
      e.preventDefault();
      sendUser();
    });
    $('#chat-input').on('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendUser();
      }
    });
    $('#chat-clear').on('click', clearThread);
    setupMic();
  }

  function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      $('#chat-mic').hide();
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';
    let active = false;
    rec.onresult = function (e) {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      $('#chat-input').val(text);
    };
    rec.onend = function () { active = false; $('#chat-mic').removeClass('btn-danger').addClass('btn-outline-secondary'); };
    $('#chat-mic').on('click', function () {
      if (active) { rec.stop(); return; }
      try {
        rec.start();
        active = true;
        $('#chat-mic').removeClass('btn-outline-secondary').addClass('btn-danger');
      } catch (err) {
        App.showError('Mic could not start: ' + err.message);
      }
    });
  }

  function sendUser() {
    const text = String($('#chat-input').val() || '').trim();
    if (!text) return;
    $('#chat-input').val('').prop('disabled', true);
    $('#chat-send').prop('disabled', true);
    messages.push({ role: 'user', content: text });
    renderThread();
    showThinking(true);

    App.api('POST', '/api/chat', { messages: lastN(messages, 40) })
      .then(handleAssistantResponse)
      .catch(err => {
        showThinking(false);
        renderError(err && err.responseJSON && err.responseJSON.error || String(err));
      })
      .always(function () {
        $('#chat-input').prop('disabled', false).focus();
        $('#chat-send').prop('disabled', false);
      });
  }

  function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

  function handleAssistantResponse(resp) {
    showThinking(false);
    if (resp.reply) {
      messages.push({ role: 'assistant', content: resp.reply, actions: resp.actions || [] });
    }
    renderThread();
  }

  function clearThread() {
    messages = [];
    renderThread();
  }

  function showThinking(on) {
    $('#chat-thinking').remove();
    if (on) {
      $('#chat-thread').append('<div id="chat-thinking" class="chat-msg chat-msg-assistant">…</div>');
      scrollBottom();
    }
  }

  function renderError(msg) {
    $('#chat-thread').append('<div class="chat-msg chat-msg-error">' + esc(msg) + '</div>');
    scrollBottom();
  }

  function renderThread() {
    const $t = $('#chat-thread').empty();
    messages.forEach(m => {
      if (m.role === 'user') {
        $t.append('<div class="chat-msg chat-msg-user">' + esc(m.content) + '</div>');
      } else {
        $t.append('<div class="chat-msg chat-msg-assistant">' + esc(m.content) + '</div>');
        (m.actions || []).forEach(a => $t.append(renderAction(a)));
      }
    });
    if (window.feather) feather.replace();
    scrollBottom();
  }

  function renderAction(a) {
    if (a.type === 'executed') return renderExecuted(a);
    if (a.type === 'confirm') return renderConfirm(a);
    if (a.type === 'cancelled') return $('<div class="chat-card"><span class="chat-tool-name">' + esc(a.tool || 'cancelled') + '</span><div>Cancelled.</div></div>');
    return $('<div class="chat-card"><span class="chat-tool-name">' + esc(a.type) + '</span></div>');
  }

  function renderExecuted(a) {
    const $card = $('<div class="chat-card"></div>');
    $card.append('<div class="chat-tool-name">' + esc(a.tool) + '</div>');
    if (a.result && a.result.error) {
      $card.append('<div style="color:#a02525">' + esc(a.result.message || a.result.error) + '</div>');
      if (a.result.candidates) {
        const $ul = $('<ul></ul>');
        a.result.candidates.forEach(c => $ul.append('<li>' + esc(c.name) + ' (id ' + c.id + ')</li>'));
        $card.append($ul);
      }
      return $card;
    }
    if (a.tool === 'list_artists' || a.tool === 'list_referrers') {
      const matches = (a.result && a.result.matches) || [];
      if (matches.length === 0) { $card.append('<div>No matches.</div>'); return $card; }
      const $ul = $('<ul></ul>');
      matches.forEach(m => $ul.append('<li>' + esc(m.name) + (m.nickname ? ' (' + esc(m.nickname) + ')' : '') + '</li>'));
      $card.append($ul);
      return $card;
    }
    if (a.tool === 'list_recent_revenue') {
      const entries = (a.result && a.result.entries) || [];
      const $tbl = $('<table><thead><tr><th>Artist</th><th>Amount</th><th>Period</th><th>Source</th></tr></thead><tbody></tbody></table>');
      entries.forEach(e => {
        $tbl.find('tbody').append('<tr><td>' + esc(e.artist_name) + '</td><td>' + App.formatCurrency(e.amount) + '</td><td>' + esc(e.period_start || '') + ' → ' + esc(e.period_end || '') + '</td><td>' + esc(e.source || '') + '</td></tr>');
      });
      $card.append($tbl);
      return $card;
    }
    if (a.tool === 'preview_revenue_split') {
      $card.append(buildSplitTable(a.result));
      return $card;
    }
    // Generic: show JSON
    $card.append('<pre style="font-size:11px; white-space:pre-wrap;">' + esc(JSON.stringify(a.result, null, 2)) + '</pre>');
    return $card;
  }

  function renderConfirm(a) {
    const $card = $('<div class="chat-card"></div>');
    $card.append('<div class="chat-tool-name">Confirm: ' + esc(a.tool) + '</div>');
    if (a.preview) {
      if (a.tool === 'record_revenue') {
        $card.append(buildSplitTable(a.preview));
      } else if (a.tool === 'delete_artist' || a.tool === 'delete_referrer') {
        $card.append('<pre style="font-size:11px; white-space:pre-wrap;">' + esc(JSON.stringify(a.preview, null, 2)) + '</pre>');
      } else if (a.tool === 'update_artist' || a.tool === 'update_referrer') {
        $card.append('<pre style="font-size:11px; white-space:pre-wrap;">' + esc(JSON.stringify(a.preview, null, 2)) + '</pre>');
      } else {
        $card.append('<pre style="font-size:11px; white-space:pre-wrap;">' + esc(JSON.stringify(a.preview, null, 2)) + '</pre>');
      }
    }
    const $actions = $('<div class="chat-confirm-actions"></div>');
    const $yes = $('<button class="btn btn-success btn-sm">Confirm & save</button>');
    const $no = $('<button class="btn btn-outline-secondary btn-sm">Cancel</button>');
    $yes.on('click', () => decideConfirm(a.pending_id, 'confirm', $card));
    $no.on('click', () => decideConfirm(a.pending_id, 'cancel', $card));
    $actions.append($yes).append($no);
    $card.append($actions);
    return $card;
  }

  function decideConfirm(pendingId, decision, $card) {
    $card.find('button').prop('disabled', true);
    App.api('POST', '/api/chat/execute', { pending_id: pendingId, decision })
      .then(resp => {
        if (resp.reply) messages.push({ role: 'assistant', content: resp.reply, actions: resp.actions || [] });
        renderThread();
      })
      .catch(err => {
        renderError(err && err.responseJSON && err.responseJSON.error || String(err));
      });
  }

  function buildSplitTable(c) {
    const $tbl = $('<table></table>');
    if (c.artist_name) $tbl.append('<tr><td colspan=2><strong>Artist:</strong> ' + esc(c.artist_name) + '</td></tr>');
    $tbl.append(row('Gross', App.formatCurrency(c.grossRevenue)));
    $tbl.append(row('Bank fee (' + (c.bankFeePct || 0) + '%)', '-' + App.formatCurrency(c.bankFee || 0)));
    $tbl.append(row('Net', App.formatCurrency(c.netRevenue)));
    $tbl.append(row('Artist (' + (c.artistSplitPct || 0) + '%)', App.formatCurrency(c.artistShare)));
    $tbl.append(row('Company gross (' + (c.companySplitPct || 0) + '%)', App.formatCurrency(c.companyGross)));
    (c.referralBreakdown || []).forEach(r => {
      $tbl.append(row('→ ' + r.referrerName + ' L' + r.level + ' (' + r.commissionPct + '%)', App.formatCurrency(r.amount)));
    });
    $tbl.append(row('<strong>Company net</strong>', '<strong>' + App.formatCurrency(c.companyNet) + '</strong>'));
    return $tbl;
    function row(k, v) { return '<tr><td>' + k + '</td><td style="text-align:right">' + v + '</td></tr>'; }
  }

  function scrollBottom() {
    const t = document.getElementById('chat-thread');
    if (t) t.scrollTop = t.scrollHeight;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
```

- [ ] **Step 2: Manual smoke test of the page**

Start the server (`npm start` if not running). Set `GEMINI_API_KEY` in your local `.env` (get one at https://aistudio.google.com — free).

Open `http://localhost:3000/chat`, log in if needed, then try:
1. Type `list artists` → expect a list (empty if no artists, otherwise a bulleted list).
2. Type `add hozan with 60% commission` → expect the assistant to reply with confirmation (Hozan was added).
3. Type `record 5000 for hozan, may 2026` → expect a calculator preview card with Confirm & save / Cancel buttons. Click Confirm → expect "Done." and verify on `/revenue` that the entry exists.
4. Click the mic in Chrome → speak "list artists" → expect transcript in the textarea.

If any of these fail, debug:
- Open DevTools Network tab, find the `/api/chat` request, look at the response JSON shape.
- Look at the server console for thrown errors.
- Check `chat_messages` rows: `node -e "const k=require('knex')(require('./knexfile')); k('chat_messages').orderBy('id','desc').limit(10).then(r=>{console.log(r); process.exit(0)})"`

- [ ] **Step 3: Commit**

```bash
git add public/app/chat.js
git commit -m "feat(chat): chat.js page controller with rendering and voice input"
```

---

## Phase 9 — Integration

### Task 17: Add Chat sidebar item to all 14 admin pages

**Files:**
- Modify: every file in `public/pages/*.html` EXCEPT `login.html`, `connect.html`, `connect-universal.html`, `shower-index.html`, `shower-artist.html` (those are public or don't have the admin sidebar)

- [ ] **Step 1: Identify the exact sidebar markup to insert**

Open `public/pages/dashboard.html` and find the existing "Referrers" sidebar `<li>` entry. The new Chat entry should sit right above it (or wherever feels most logical to you — top of the list is fine since chat is now the primary entry surface). Use this markup, matching the existing pattern's classes:

```html
<li class="sidebar-item admin-only">
  <a class="sidebar-link waves-effect waves-dark sidebar-link" href="/chat" aria-expanded="false">
    <i data-feather="message-circle" class="feather-icon"></i>
    <span class="hide-menu">Chat</span>
  </a>
</li>
```

**Verify** the exact CSS class names (`sidebar-item`, `sidebar-link`, `hide-menu`, `feather-icon`) by inspecting one of the existing `<li>` items in `dashboard.html`. If any class names differ in your repo, use whatever the existing items use — consistency over the snippet above.

- [ ] **Step 2: Add a one-shot script to update all pages**

Create `scripts/add-chat-sidebar.js`:

```js
// One-shot utility: inserts the Chat sidebar item before the Referrers item
// in every admin HTML page. Safe to re-run — idempotent (checks if already present).
const fs = require('fs');
const path = require('path');

const pagesDir = path.join(__dirname, '..', 'public', 'pages');
const skip = new Set(['login.html', 'connect.html', 'connect-universal.html', 'shower-index.html', 'shower-artist.html']);

const chatItem = `
        <li class="sidebar-item admin-only">
          <a class="sidebar-link waves-effect waves-dark sidebar-link" href="/chat" aria-expanded="false">
            <i data-feather="message-circle" class="feather-icon"></i>
            <span class="hide-menu">Chat</span>
          </a>
        </li>
`;

const markerPattern = /<a class="sidebar-link[^"]*"\s+href="\/referrers"/;

for (const file of fs.readdirSync(pagesDir)) {
  if (!file.endsWith('.html') || skip.has(file)) continue;
  const fp = path.join(pagesDir, file);
  let html = fs.readFileSync(fp, 'utf8');
  if (html.includes('href="/chat"')) {
    console.log('skip (already has Chat):', file);
    continue;
  }
  const m = html.match(markerPattern);
  if (!m) {
    console.warn('WARN: no Referrers sidebar marker in', file, '— skipping');
    continue;
  }
  // Find the <li> that contains the matched <a>
  const idx = m.index;
  const liStart = html.lastIndexOf('<li', idx);
  if (liStart === -1) {
    console.warn('WARN: could not find <li> opening before referrers anchor in', file);
    continue;
  }
  html = html.slice(0, liStart) + chatItem.trimStart() + '        ' + html.slice(liStart);
  fs.writeFileSync(fp, html);
  console.log('updated:', file);
}
console.log('Done.');
```

- [ ] **Step 3: Run the script**

```bash
node scripts/add-chat-sidebar.js
```

Expected output: a list of "updated: X.html" lines. If you see "WARN: no Referrers sidebar marker", open that file and check whether it has a different sidebar pattern; you may need to add the Chat item manually to that file.

- [ ] **Step 4: Verify visually**

Reload `http://localhost:3000/dashboard` — confirm the Chat sidebar item appears and clicking it navigates to `/chat`. Open `/artists`, `/revenue`, `/payments`, `/referrers` — Chat item should appear on all.

- [ ] **Step 5: Commit**

```bash
git add public/pages/ scripts/add-chat-sidebar.js
git commit -m "feat(chat): add Chat item to admin sidebar across all pages"
```

---

### Task 18: End-to-end smoke test against live Gemini

**Files:**
- Create: `tests/chat-corpus.md`

This is a manual checklist, not an automated test, because hitting live Gemini in CI burns quota. Run it before shipping.

- [ ] **Step 1: Create the corpus document**

Create `tests/chat-corpus.md`:

```markdown
# Chat Command Corpus

Manual test phrases for the chat assistant. Run after any prompt or tool-schema change. Record results in your shipping checklist.

## v1 — Read tools

| # | Input | Expected behavior |
|---|---|---|
| 1 | `list artists` | Bulleted list of artist names |
| 2 | `show me sarah` (with 2+ Sarahs) | Assistant asks which Sarah |
| 3 | `who is hozan` | Get artist card with referrals |
| 4 | `list referrers` | Bulleted referrer list |
| 5 | `what would 5000 look like for hozan` | preview_revenue_split card with full breakdown |
| 6 | `what revenue did we record last week` | list_recent_revenue table |

## v1 — Safe writes

| # | Input | Expected behavior |
|---|---|---|
| 7 | `add hozan` | Artist created with 60/40 defaults; assistant mentions the defaults |
| 8 | `add hozan with 70% split, referred by sarah at 5%` | Artist created; if Sarah didn't exist, disclosure ("Sarah wasn't in the registry, so I created her too") |
| 9 | `add a new referrer named ahmed, phone 555-1234` | Referrer created |

## v1 — Confirmation required

| # | Input | Expected behavior |
|---|---|---|
| 10 | `record 5000 for hozan from streaming, may 2026` | Confirmation card with calculator preview; Confirm saves to revenue_entries + distributions; Cancel marks cancelled |
| 11 | `change hozan's commission to 70%` | Confirmation card showing the diff; Confirm updates |
| 12 | `delete the artist hozan` | Confirmation card showing cascade counts; Confirm removes |
| 13 | `delete sarah from referrers` | Confirmation card; soft-delete if in use |

## Error and disambiguation

| # | Input | Expected behavior |
|---|---|---|
| 14 | `delete unknownperson` | Assistant says "I couldn't find unknownperson" — no execution |
| 15 | Click Confirm twice on the same card | Second click should fail with "pending action no longer valid" (server-authoritative) |
| 16 | Refresh page mid-confirmation | Pending row remains `pending_confirm` in DB; UI loses the card. Acceptable for v1; v2 could restore pending cards on reconnect. |

## Voice (Chrome only)

| # | Input | Expected behavior |
|---|---|---|
| 17 | Click mic, say "list artists" | Transcript appears in textarea; pressing Enter submits |
| 18 | Click mic on Safari iOS | Mic button is hidden (no SpeechRecognition support) |
```

- [ ] **Step 2: Walk through the corpus manually**

With the server running and `GEMINI_API_KEY` set, open `http://localhost:3000/chat` and run through entries 1–18. For each one, note pass/fail in a scratch file or git commit message.

Common failures and remediation:
- **Tool not being called when expected** → The tool description may be unclear. Refine the `description` field in `services/chatTools.js`, and the `SYSTEM_PROMPT` in `routes/chat.js`.
- **Date parsing wrong** ("may 2026" → wrong period_start) → Improve the system prompt's date guidance, or add explicit examples.
- **LLM picks wrong tool** → Check tool description specificity; consider adding "When to use this" hints.
- **Confirmation card has wrong preview shape** → Inspect the action JSON in DevTools and adjust the corresponding `buildPreview` or `renderConfirm` branch.

- [ ] **Step 3: Fix any issues found, retest**

For each failure: identify whether it's a prompt issue, a tool description issue, a tool implementation bug, or a UI bug. Fix; commit; re-run that corpus entry.

- [ ] **Step 4: Commit the corpus document**

```bash
git add tests/chat-corpus.md
git commit -m "docs(chat): manual command corpus for pre-ship verification"
```

---

### Task 19: Final integration verification

- [ ] **Step 1: Run all automated tests**

```bash
npm test
```

Expected: all tests pass (calculator + smoke + gemini + chatTools + chat-route).

- [ ] **Step 2: Verify the dev server boots cleanly**

```bash
npm start
```

Expected: `Database migrations complete` and `Deng Parez Monetary System running on port 3000` in the console with no errors. Migration 010 should NOT re-run on this second boot (idempotent).

- [ ] **Step 3: Walk through one full end-to-end happy path in the browser**

1. Open `/chat`, log in.
2. Type: `add a referrer named TestRef`. Confirm response.
3. Type: `add an artist named TestArtist with 65% split, referred by TestRef at 4%`. Confirm response includes auto-create disclosure if applicable.
4. Type: `record 1000 for TestArtist, period 2026-05-01 to 2026-05-31, source platform`. See calculator preview, click Confirm.
5. Navigate to `/revenue` — confirm the new entry exists.
6. Navigate to `/payments` — confirm TestArtist appears as a recipient.
7. Back to `/chat`. Type: `delete TestArtist`. See cascade preview, click Confirm.
8. Verify `/revenue` no longer shows TestArtist's entry (cascade).

- [ ] **Step 4: Final commit if any fixes were needed**

If you adjusted code during the walkthrough, commit:

```bash
git add -A
git commit -m "fix(chat): tweaks from end-to-end smoke walkthrough"
```

- [ ] **Step 5: Optional — push to deploy**

If the user has approved deployment:

```bash
git push origin master
```

Railway will auto-deploy. Verify on `https://dp.tt-social.com/chat` once the build finishes (~30-60s).

---

*End of plan.*
