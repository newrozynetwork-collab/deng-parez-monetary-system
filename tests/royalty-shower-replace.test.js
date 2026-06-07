'use strict';
// Replace-on-upload (idempotent ingest), 404-on-empty, self-cleaning slugs,
// delete-artist / delete-import helpers, and migration 012 (orphan-slug cleanup).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const knex = require('knex');
const service = require('../services/royaltyShower.js');
const migration012 = require('../db/migrations/012_cleanup_orphan_slugs.js');

const DB = path.join(os.tmpdir(), 'dp-shower-replace-test.sqlite');
let db;

const escCsv = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const csv = (rows) => ['PRODUCT ARTIST,TRACK,STORE,STATEMENT PERIOD,NET SHARE ACCOUNT CURRENCY',
  ...rows.map((r) => r.map(escCsv).join(','))].join('\n');
const ingest = (rows, opts = {}) => service.ingestCsv({ db, filename: 'f.csv', buffer: Buffer.from(csv(rows), 'utf8'), uploadedBy: null, ...opts });
const total = async (slug) => (await service.buildReport(db, slug) || { totalRevenue: -1 }).totalRevenue;

before(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  db = knex({
    client: 'sqlite3', connection: { filename: DB }, useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') }, pool: { min: 1, max: 1 },
  });
  await db.migrate.latest();
});
after(async () => { await db.destroy(); try { fs.unlinkSync(DB); } catch (_) {} });

test('re-uploading the same file replaces (no double count)', async () => {
  const file = [['Kamal Fadawi', 'S1', 'YouTube', 'May 2026', '5'], ['Kamal Fadawi', 'S2', 'YouTube', 'May 2026', '3']];
  await ingest(file);
  assert.equal(await total('kamal-fadawi'), 8);
  const r = await ingest(file); // default = replace
  assert.equal(await total('kamal-fadawi'), 8, 'still 8 — replaced, not doubled');
  assert.ok(r.replaced >= 2, 'reports how many rows it replaced');
});

test('re-upload with corrected values reflects the new file only', async () => {
  await ingest([['Aram Sardar', 'T', 'Spotify', 'Jan 2026', '10']]);
  assert.equal(await total('aram-sardar'), 10);
  await ingest([['Aram Sardar', 'T', 'Spotify', 'Jan 2026', '7']]); // corrected down
  assert.equal(await total('aram-sardar'), 7, 'old Jan rows gone, new value stands');
});

test('replace only touches the months present in the file', async () => {
  await ingest([['Rawa Jamal', 'A', 'YouTube', 'Jan 2026', '10']]);
  await ingest([['Rawa Jamal', 'B', 'YouTube', 'Feb 2026', '20']]); // new month, Jan must survive
  assert.equal(await total('rawa-jamal'), 30, 'Jan kept + Feb added');
  await ingest([['Rawa Jamal', 'B', 'YouTube', 'Feb 2026', '5']]); // replace only Feb
  assert.equal(await total('rawa-jamal'), 15, 'Jan 10 + Feb 5');
});

test('Aggregate still adds a second source on top (Believe + Orchard)', async () => {
  await ingest([['Dashni', 'X', 'Orchard', 'Mar 2026', '4']]);
  await ingest([['Dashni', 'Y', 'Believe', 'Mar 2026', '6']], { aggregate: true });
  assert.equal(await total('dashni'), 10, 'aggregate adds rather than replaces');
});

test('buildReport 404s (null) when an artist has no rows', async () => {
  await ingest([['Ghost Artist', 'G', 'YouTube', 'Jan 2026', '5']]);
  assert.equal(await total('ghost-artist'), 5);
  await service.deleteArtist(db, 'ghost-artist');
  assert.equal(await service.buildReport(db, 'ghost-artist'), null, 'empty profile is a 404');
});

test('deleteArtist removes data + registry entry, drops it from the list', async () => {
  await ingest([['Temp One', 'T', 'YouTube', 'Jan 2026', '9']]);
  await service.deleteArtist(db, 'temp-one');
  assert.equal(await db('royalty_rows').where({ artist_slug: 'temp-one' }).first(), undefined);
  assert.equal(await db('artist_slugs').where({ slug: 'temp-one' }).first(), undefined);
  const list = await service.listArtists(db);
  assert.ok(!list.find((a) => a.slug === 'temp-one'), 'gone from artist list');
});

test('deleteImport cascades rows and cleans an emptied slug', async () => {
  const r = await ingest([['Solo Imp', 'T', 'YouTube', 'Jan 2026', '4']]);
  await service.deleteImport(db, r.importId);
  assert.equal(await db('royalty_rows').where({ artist_slug: 'solo-imp' }).first(), undefined, 'rows cascaded');
  assert.equal(await db('artist_slugs').where({ slug: 'solo-imp' }).first(), undefined, 'emptied slug removed');
});

test('migration 012 removes orphan slugs (no rows) but keeps live ones', async () => {
  await db('artist_slugs').insert({ slug: 'orphan-xyz', artist_name: 'Orphan Xyz' }); // no rows
  await ingest([['Live Artist', 'T', 'YouTube', 'Jan 2026', '3']]);
  await migration012.up(db);
  assert.equal(await db('artist_slugs').where({ slug: 'orphan-xyz' }).first(), undefined, 'orphan removed');
  assert.ok(await db('artist_slugs').where({ slug: 'live-artist' }).first(), 'live slug kept');
});
