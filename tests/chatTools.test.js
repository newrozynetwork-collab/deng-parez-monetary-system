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
