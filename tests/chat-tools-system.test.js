// tests/chat-tools-system.test.js — the "chat controls everything" toolset:
// income/expenses/categories CRUD, financial reports, payments, users (read),
// Report Shower management, and YouTube (server-side reads + share link).
// NOTE: migration 003 already seeds default categories (Others, Consulting,
// Operations, Marketing, ...) — tests use those instead of inserting their own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTestDb, seedUser } = require('./setup');
const chatTools = require('../services/chatTools');

const t = (name) => {
  const tool = chatTools.getTool(name);
  assert.ok(tool, `tool ${name} is registered`);
  return tool;
};
const run = (name, db, args, session) => t(name).execute({ db, session: session || { userId: 1 } }, args || {});

// Every test runs inside withDb so the knex pool is ALWAYS destroyed — a
// leaked pool keeps node:test's event loop alive and hangs `npm test`.
async function withDb(fn) {
  const db = await makeTestDb();
  try {
    const userId = await seedUser(db, { role: 'admin', name: 'Admin' });
    await fn(db, userId);
  } finally {
    await db.destroy();
  }
}

// ───────────────────────── ADDITIONAL INCOME ─────────────────────────

test('add_additional_income: resolves seeded category case-insensitively, defaults commission to 0 and date to today', () => withDb(async (db, userId) => {
  const res = await run('add_additional_income', db, { amount: 500, category: 'others', description: 'misc' }, { userId });
  assert.ok(res.id, 'returns new id');
  assert.equal(res.category_name, 'Other', "'others' fuzzy-matches the seeded 'Other'");

  const row = await db('additional_income').where({ id: res.id }).first();
  assert.equal(parseFloat(row.amount), 500);
  assert.equal(parseFloat(row.commission_pct || 0), 0, 'no commissions by default');
  assert.ok(row.category_id, 'category linked');
  assert.ok(row.date, 'date defaulted');
  assert.equal(row.created_by, userId);
}));

test('add_additional_income: unknown category → not_found, nothing inserted; expense-type names do not leak in', () => withDb(async (db) => {
  const bad = await run('add_additional_income', db, { amount: 10, category: 'no-such-cat' });
  assert.equal(bad.error, 'not_found');
  const wrongType = await run('add_additional_income', db, { amount: 10, category: 'Operations' }); // expense-type
  assert.equal(wrongType.error, 'not_found', 'expense category is not a valid income category');
  assert.equal((await db('additional_income')).length, 0);
}));

test('add_additional_income: explicit commission is stored; preview reflects it', () => withDb(async (db) => {
  const prev = await t('add_additional_income').buildPreview({ db }, { amount: 200, category: 'Consulting', commission_pct: 10, commission_to: 'Hama' });
  assert.equal(prev.amount, 200);
  assert.equal(prev.category_name, 'Consulting');
  assert.equal(prev.commission_amount, 20);

  const res = await run('add_additional_income', db, { amount: 200, category: 'Consulting', commission_pct: 10, commission_to: 'Hama', date: '2026-06-01' });
  const row = await db('additional_income').where({ id: res.id }).first();
  assert.equal(parseFloat(row.commission_pct), 10);
  assert.equal(row.commission_to, 'Hama');
}));

test('list/update/delete_additional_income: full lifecycle', () => withDb(async (db) => {
  const a = await run('add_additional_income', db, { amount: 100, category: 'Other', date: '2026-05-01' });
  await run('add_additional_income', db, { amount: 50, category: 'Consulting', date: '2026-06-05' });

  const all = await run('list_additional_income', db, {});
  assert.equal(all.entries.length, 2);
  const june = await run('list_additional_income', db, { start: '2026-06-01' });
  assert.equal(june.entries.length, 1);
  assert.equal(june.entries[0].amount, 50);

  const upd = await run('update_additional_income', db, { id: a.id, changes: { amount: 120, description: 'fixed' } });
  assert.equal(upd.updated, true);
  assert.equal(parseFloat((await db('additional_income').where({ id: a.id }).first()).amount), 120);

  const del = await run('delete_additional_income', db, { id: a.id });
  assert.equal(del.deleted, true);
  assert.equal((await db('additional_income')).length, 1);
}));

// ───────────────────────── EXPENSES ─────────────────────────

test('add_expense: resolves expense category, stores legacy name + FK, defaults date', () => withDb(async (db, userId) => {
  const res = await run('add_expense', db, { amount: 75.5, category: 'operations', description: 'server bill' }, { userId });
  assert.ok(res.id);
  const row = await db('expenses').where({ id: res.id }).first();
  assert.equal(parseFloat(row.amount), 75.5);
  assert.equal(row.category, 'Operations', 'legacy string column carries the canonical name');
  assert.ok(row.category_id);
  assert.ok(row.date);
}));

test('expenses: list filters by date; update and delete work', () => withDb(async (db) => {
  const e1 = await run('add_expense', db, { amount: 10, category: 'Operations', date: '2026-05-01' });
  await run('add_expense', db, { amount: 20, category: 'Marketing', date: '2026-06-05' });

  const may = await run('list_expenses', db, { start: '2026-05-01', end: '2026-05-31' });
  assert.equal(may.entries.length, 1);
  assert.equal(may.entries[0].amount, 10);

  await run('update_expense', db, { id: e1.id, changes: { amount: 15 } });
  assert.equal(parseFloat((await db('expenses').where({ id: e1.id }).first()).amount), 15);

  const del = await run('delete_expense', db, { id: e1.id });
  assert.equal(del.deleted, true);
  assert.equal((await db('expenses')).length, 1);
}));

// ───────────────────────── CATEGORIES ─────────────────────────

test('categories: list filters by type; add rejects duplicates; update renames; delete guards in-use', () => withDb(async (db) => {
  const inc = await run('list_categories', db, { type: 'income' });
  assert.ok(inc.categories.some(c => c.name === 'Other'));
  assert.ok(!inc.categories.some(c => c.name === 'Operations'), 'expense cats excluded');

  const dup = await run('add_category', db, { name: 'other', type: 'income' });
  assert.equal(dup.error, 'duplicate');

  const added = await run('add_category', db, { name: 'Zakat Test Cat', type: 'income', color: '#e0a93e' });
  assert.ok(added.id);

  const ren = await run('update_category', db, { id_or_name: 'Zakat Test Cat', type: 'income', changes: { name: 'Zakat Renamed' } });
  assert.equal(ren.updated, true);

  // make 'Others' in-use, then try deleting it
  await run('add_additional_income', db, { amount: 5, category: 'Other' });
  const guarded = await run('delete_category', db, { id_or_name: 'Other', type: 'income' });
  assert.equal(guarded.error, 'in_use');
  const forced = await run('delete_category', db, { id_or_name: 'Other', type: 'income', force: true });
  assert.equal(forced.deleted, true);
  const orphan = await db('additional_income').first();
  assert.equal(orphan.category_id, null, 'force-delete unlinks rows instead of deleting them');
}));

// ───────────────── REVENUE DELETE + REPORTS + PAYMENTS ─────────────────

async function seedRevenueWorld(db, userId) {
  await db('artists').insert({ name: 'Hozan', artist_split_pct: 60, company_split_pct: 40, bank_fee_pct: 0 });
  const rec = await run('record_revenue', db, { artist: 'Hozan', amount: 100, period_start: '2026-06-01', period_end: '2026-06-30' }, { userId });
  await run('add_expense', db, { amount: 25, category: 'Operations', date: '2026-06-10' }, { userId });
  await run('add_additional_income', db, { amount: 50, category: 'Other', date: '2026-06-10', commission_pct: 10, commission_to: 'Hama' }, { userId });
  return rec;
}

test('get_financial_summary: aggregates revenue, expenses, income and net profit', () => withDb(async (db, userId) => {
  await seedRevenueWorld(db, userId);
  const s = await run('get_financial_summary', db, {});
  assert.equal(s.totalRevenue, 100);
  assert.equal(s.totalExpenses, 25);
  assert.equal(s.totalAdditionalIncome, 50);
  assert.equal(s.totalArtistPayouts, 60, '60% split of 100, no bank fee');
  assert.equal(s.companyRevenue, 40);
  assert.equal(s.netCompanyProfit, 40 + 50 - 25);
}));

test('delete_revenue_entry: removes the entry AND its distributions', () => withDb(async (db, userId) => {
  const rec = await seedRevenueWorld(db, userId);
  const del = await run('delete_revenue_entry', db, { id: rec.revenue_entry_id });
  assert.equal(del.deleted, true);
  assert.equal((await db('revenue_entries')).length, 0);
  assert.equal((await db('revenue_distributions')).length, 0, 'no orphaned distributions');
}));

test('payments: summary lists artist + commission recipients; history merges sources', () => withDb(async (db, userId) => {
  await seedRevenueWorld(db, userId);

  const sum = await run('get_payments_summary', db, {});
  const hozan = sum.recipients.find(r => r.name === 'Hozan');
  assert.ok(hozan, 'artist appears');
  assert.equal(hozan.totalPaid, 60);
  const hama = sum.recipients.find(r => r.name === 'Hama');
  assert.ok(hama, 'income commission recipient appears');
  assert.equal(hama.totalPaid, 5, '10% of 50');

  const hist = await run('get_payment_history', db, { name: 'Hozan' });
  assert.equal(hist.payments.length, 1);
  assert.equal(hist.payments[0].amount, 60);
}));

// ───────────────────────── USERS (READ-ONLY) ─────────────────────────

test('list_users: returns accounts WITHOUT password hashes; no write tools exist for users', () => withDb(async (db) => {
  const res = await run('list_users', db, {});
  assert.ok(res.users.length >= 1);
  assert.ok(res.users[0].username);
  assert.equal(res.users[0].password_hash, undefined, 'hash never exposed');
  for (const banned of ['add_user', 'update_user', 'delete_user', 'change_password']) {
    assert.equal(chatTools.getTool(banned), undefined, `${banned} must not exist`);
  }
}));

// ───────────────────────── REPORT SHOWER ─────────────────────────

async function seedShower(db) {
  await db('artist_slugs').insert({ slug: 'kamal-fadawi', artist_name: 'Kamal Fadawi' });
  const imp = await db('royalty_imports').insert({ filename: 'f.csv', row_count: 1, total_revenue: 9 }).returning('id');
  const importId = Array.isArray(imp) ? (typeof imp[0] === 'object' ? imp[0].id : imp[0]) : imp;
  await db('royalty_rows').insert({ import_id: importId, artist_slug: 'kamal-fadawi', artist_name: 'Kamal Fadawi', track: 'T', store: 'S', period: '2026-01', net_revenue: 9 });
}

test('shower: list artists, get public link, delete artist', () => withDb(async (db) => {
  await seedShower(db);

  const list = await run('list_shower_artists', db, {});
  assert.ok(list.artists.some(a => a.slug === 'kamal-fadawi'));

  const link = await run('get_shower_link', db, { artist: 'kamal' });
  assert.equal(link.slug, 'kamal-fadawi');
  assert.match(link.url, /\/shower\/kamal-fadawi$/);

  const del = await run('delete_shower_artist', db, { artist: 'kamal-fadawi' });
  assert.equal(del.deleted, true);
  assert.equal((await db('royalty_rows')).length, 0);
  assert.equal((await db('artist_slugs')).length, 0);
}));

// ───────────────────────── YOUTUBE (SERVER-SIDE) ─────────────────────────

test('youtube_overview: aggregates linked channels, pending and revenue history', () => withDb(async (db) => {
  await db('artists').insert({ name: 'Hozan' });
  const artist = await db('artists').first();
  await db('youtube_accounts').insert({ artist_id: artist.id, channel_id: 'UC1', channel_title: 'Hozan TV', refresh_token_encrypted: 'x' });
  await db('youtube_pending_connections').insert({ channel_id: 'UC2', channel_title: 'Orphan FM', refresh_token_encrypted: 'y' });
  await db('youtube_revenue_history').insert([
    { artist_id: artist.id, channel_id: 'UC1', month: '2026-05', estimated_revenue: 12.5 },
    { artist_id: artist.id, channel_id: 'UC1', month: '2026-06', estimated_revenue: 7.5 }
  ]);

  const o = await run('youtube_overview', db, {});
  assert.equal(o.linked_channels.length, 1);
  assert.equal(o.pending_channels.length, 1);
  assert.equal(o.total_synced_revenue, 20);
}));

test('youtube_share_link: mints a 30-day token and invalidates old unused ones', () => withDb(async (db) => {
  await db('artists').insert({ name: 'Hozan' });

  const first = await run('youtube_share_link', db, { artist: 'Hozan' });
  assert.ok(first.token);
  assert.match(first.url_path, /^\/connect\//);
  const second = await run('youtube_share_link', db, { artist: 'Hozan' });
  assert.notEqual(second.token, first.token);
  const rows = await db('youtube_connect_tokens');
  assert.equal(rows.length, 1, 'old unused token replaced');
}));
