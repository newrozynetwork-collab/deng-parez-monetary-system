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
