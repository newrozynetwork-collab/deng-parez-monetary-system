'use strict';
// Tests the one-time legacy-cleanup migration (011) that:
//   A) folds "Primary, Featured" collab credits into the primary artist
//   B) drops undated duplicate rows for artists that ALSO have dated rows
//   C) prunes imports left with no rows
// Modeled on the real prod state: Miran Ali has 6 combo profiles; Kamal Fadawi
// has a dated set (~$115.87) plus a null-period duplicate (~$115.88).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const knex = require('knex');
const service = require('../services/royaltyShower.js');
const migration = require('../db/migrations/011_cleanup_shower_legacy.js');

const DB = path.join(os.tmpdir(), 'dp-shower-cleanup-test.sqlite');
let db;

const sumFor = async (slug) =>
  Number((await db('royalty_rows').where({ artist_slug: slug }).sum({ s: 'net_revenue' }).first()).s || 0);
const impId = async (filename) => (await db('royalty_imports').where({ filename }).first()).id;

before(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  db = knex({
    client: 'sqlite3', connection: { filename: DB }, useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') }, pool: { min: 1, max: 1 },
  });
  await db.migrate.latest(); // runs 011 on empty tables (no-op)

  // ---- registry (what ingest would have created) ----
  await db('artist_slugs').insert([
    { slug: 'miran-ali', artist_name: 'Miran Ali' },
    { slug: 'miran-ali-aziz-waisi', artist_name: 'Miran Ali, Aziz Waisi' },
    { slug: 'kamal-fadawi', artist_name: 'Kamal Fadawi' },
    { slug: 'ghost', artist_name: 'Ghost' },
  ]);

  // ---- imports ----
  await db('royalty_imports').insert([
    { filename: 'miran-solo.csv', period_start: '2024-01', period_end: '2024-01', row_count: 1, total_revenue: 10 },
    { filename: 'miran-aziz.csv', period_start: '2024-02', period_end: '2024-02', row_count: 1, total_revenue: 5 },
    { filename: 'kamal-dated.csv', period_start: '2025-07', period_end: '2025-08', row_count: 2, total_revenue: 10 },
    { filename: 'kamal-raw.csv', period_start: null, period_end: null, row_count: 2, total_revenue: 10 },
    { filename: 'ghost-raw.csv', period_start: null, period_end: null, row_count: 1, total_revenue: 3 },
  ]);

  // ---- rows ----
  await db('royalty_rows').insert([
    // Miran solo
    { import_id: await impId('miran-solo.csv'), artist_slug: 'miran-ali', artist_name: 'Miran Ali', track: 'Solo', store: 'Spotify', period: '2024-01', net_revenue: 10 },
    // Miran collab credit -> should fold into miran-ali
    { import_id: await impId('miran-aziz.csv'), artist_slug: 'miran-ali-aziz-waisi', artist_name: 'Miran Ali, Aziz Waisi', track: 'Collab', store: 'Spotify', period: '2024-02', net_revenue: 5 },
    // Kamal dated (the truth, ~115.87 in prod; here 10)
    { import_id: await impId('kamal-dated.csv'), artist_slug: 'kamal-fadawi', artist_name: 'Kamal Fadawi', track: 'K1', store: 'YouTube', period: '2025-07', net_revenue: 4 },
    { import_id: await impId('kamal-dated.csv'), artist_slug: 'kamal-fadawi', artist_name: 'Kamal Fadawi', track: 'K2', store: 'YouTube', period: '2025-08', net_revenue: 6 },
    // Kamal undated duplicate (the junk, ~115.88 in prod; here 10)
    { import_id: await impId('kamal-raw.csv'), artist_slug: 'kamal-fadawi', artist_name: 'Kamal Fadawi', track: 'K1', store: 'YouTube', period: null, net_revenue: 4 },
    { import_id: await impId('kamal-raw.csv'), artist_slug: 'kamal-fadawi', artist_name: 'Kamal Fadawi', track: 'K2', store: 'YouTube', period: null, net_revenue: 6 },
    // Ghost: ONLY undated -> must be protected (never wipe a profile whose only data is undated)
    { import_id: await impId('ghost-raw.csv'), artist_slug: 'ghost', artist_name: 'Ghost', track: 'G', store: 'YouTube', period: null, net_revenue: 3 },
  ]);

  await migration.up(db);
});
after(async () => { await db.destroy(); try { fs.unlinkSync(DB); } catch (_) {} });

test('A) collab credits collapse into the primary artist (no comma names remain)', async () => {
  const commas = await db('royalty_rows').where('artist_name', 'like', '%,%');
  assert.equal(commas.length, 0, 'no comma artist_name should remain');
  const folded = await db('royalty_rows').where({ artist_slug: 'miran-ali-aziz-waisi' });
  assert.equal(folded.length, 0, 'old combo slug has no rows');
  assert.equal(await sumFor('miran-ali'), 15, 'solo + collab revenue rolls into Miran Ali');
});

test('A) registry: combo entries removed, primary present', async () => {
  assert.equal((await db('artist_slugs').where('artist_name', 'like', '%,%')).length, 0);
  assert.ok(await db('artist_slugs').where({ slug: 'miran-ali' }).first(), 'primary slug kept');
  assert.equal(await db('artist_slugs').where({ slug: 'miran-ali-aziz-waisi' }).first(), undefined, 'combo slug gone');
});

test('B) undated duplicate dropped for an artist that also has dated rows', async () => {
  const nulls = await db('royalty_rows').where({ artist_slug: 'kamal-fadawi' }).whereNull('period');
  assert.equal(nulls.length, 0, 'Kamal undated rows removed');
  assert.equal(await sumFor('kamal-fadawi'), 10, 'Kamal left with the dated truth only (no double count)');
});

test('B) an artist whose ONLY data is undated is protected', async () => {
  const ghost = await db('royalty_rows').where({ artist_slug: 'ghost' });
  assert.equal(ghost.length, 1, 'undated-only profile is not wiped');
  assert.equal(await sumFor('ghost'), 3);
});

test('C) imports with no remaining rows are pruned; others kept', async () => {
  assert.equal(await db('royalty_imports').where({ filename: 'kamal-raw.csv' }).first(), undefined, 'empty import pruned');
  for (const f of ['miran-solo.csv', 'miran-aziz.csv', 'kamal-dated.csv', 'ghost-raw.csv']) {
    assert.ok(await db('royalty_imports').where({ filename: f }).first(), `${f} kept`);
  }
});

test('buildReport reflects the cleaned data', async () => {
  assert.equal((await service.buildReport(db, 'miran-ali')).totalRevenue, 15);
  assert.equal((await service.buildReport(db, 'kamal-fadawi')).totalRevenue, 10);
  assert.equal(await service.buildReport(db, 'miran-ali-aziz-waisi'), null, 'old combo URL 404s');
});

test('idempotent: running the cleanup again changes nothing', async () => {
  await migration.up(db);
  assert.equal(await sumFor('miran-ali'), 15);
  assert.equal(await sumFor('kamal-fadawi'), 10);
  assert.equal(await sumFor('ghost'), 3);
  assert.equal((await db('royalty_rows').where('artist_name', 'like', '%,%')).length, 0);
  assert.equal((await db('royalty_imports')).length, 4);
});
