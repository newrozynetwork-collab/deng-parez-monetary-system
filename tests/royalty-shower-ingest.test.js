'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const knex = require('knex');
const service = require('../services/royaltyShower.js');

const DB = path.join(os.tmpdir(), 'dp-shower-ingest-test.sqlite');
let db;

before(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  db = knex({
    client: 'sqlite3', connection: { filename: DB }, useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') }, pool: { min: 1, max: 1 },
  });
  await db.migrate.latest();
});
after(async () => { await db.destroy(); try { fs.unlinkSync(DB); } catch (_) {} });

const escCsv = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const csv = (rows) => ['PRODUCT ARTIST,TRACK,STORE,STATEMENT PERIOD,NET SHARE ACCOUNT CURRENCY',
  ...rows.map((r) => r.map(escCsv).join(','))].join('\n');
const ingest = (rows, opts = {}) => service.ingestCsv({ db, filename: 'f.csv', buffer: Buffer.from(csv(rows), 'utf8'), uploadedBy: null, ...opts });

test('primary-artist: a collab credit collapses to the first name', async () => {
  await ingest([['Miran Ali, Aziz Waisi', 'Song A', 'Spotify', 'April 2026', '10']]);
  const mine = await db('royalty_rows').where({ artist_slug: 'miran-ali' });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].artist_name, 'Miran Ali');
  const combo = await db('royalty_rows').where({ artist_slug: 'miran-ali-aziz-waisi' });
  assert.equal(combo.length, 0, 'no combined entry should exist');
});

test('duplicate month is skipped by default, but aggregate adds it', async () => {
  const file = [['Kamal Fadawi', 'S1', 'YouTube', 'May 2026', '5'], ['Kamal Fadawi', 'S2', 'YouTube', 'May 2026', '3']];
  await ingest(file);
  const second = await ingest(file); // same month again, default → skip
  assert.equal(second.rowCount, 0, 'all rows skipped');
  assert.ok(second.skipped >= 2, 'reports skipped rows');
  assert.equal((await service.buildReport(db, 'kamal-fadawi')).totalRevenue, 8, 'no double count');
  await ingest(file, { aggregate: true }); // explicit aggregate → add (Believe + Orchard same month)
  assert.equal((await service.buildReport(db, 'kamal-fadawi')).totalRevenue, 16, 'aggregate adds on top');
});

test('a genuinely new month still imports (not skipped)', async () => {
  await ingest([['Hama Jaza', 'T', 'YouTube', 'Jan 2026', '4']]);
  const r = await ingest([['Hama Jaza', 'T', 'YouTube', 'Feb 2026', '6']]);
  assert.equal(r.rowCount, 1);
  assert.equal((await service.buildReport(db, 'hama-jaza')).totalRevenue, 10);
});

test('all-time buildReport returns a per-month summary', async () => {
  await ingest([
    ['Dashni', 'T1', 'Spotify', 'January 2026', '4'],
    ['Dashni', 'T2', 'Spotify', 'February 2026', '6'],
  ]);
  const rep = await service.buildReport(db, 'dashni'); // no period → all time
  assert.equal(rep.period, null, 'all-time mode');
  assert.equal(rep.totalRevenue, 10);
  assert.ok(Array.isArray(rep.byMonth) && rep.byMonth.length === 2, 'byMonth present');
  const jan = rep.byMonth.find((m) => m.period === '2026-01');
  assert.ok(jan && jan.total === 4, 'monthly total correct');
  // newest first
  assert.equal(rep.byMonth[0].period, '2026-02');
});

test('single-month buildReport still works and still carries byMonth', async () => {
  const rep = await service.buildReport(db, 'dashni', '2026-01');
  assert.equal(rep.period, '2026-01');
  assert.equal(rep.totalRevenue, 4);
  assert.equal(rep.byMonth.length, 2, 'monthly summary still available when viewing one month');
});
