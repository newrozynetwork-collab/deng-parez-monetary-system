'use strict';
// Styled .xlsx export: the data query (getArtistExport) and the workbook builder.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const knex = require('knex');
const ExcelJS = require('exceljs');
const service = require('../services/royaltyShower.js');
const { buildArtistWorkbook } = require('../services/showerXlsx.js');

const DB = path.join(os.tmpdir(), 'dp-shower-export-test.sqlite');
let db;

const escCsv = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
const csv = (rows) => ['PRODUCT ARTIST,TRACK,STORE,STATEMENT PERIOD,NET SHARE ACCOUNT CURRENCY',
  ...rows.map((r) => r.map(escCsv).join(','))].join('\n');
const ingest = (rows, opts = {}) => service.ingestCsv({ db, filename: 'f.csv', buffer: Buffer.from(csv(rows), 'utf8'), uploadedBy: null, ...opts });

before(async () => {
  try { fs.unlinkSync(DB); } catch (_) {}
  db = knex({
    client: 'sqlite3', connection: { filename: DB }, useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') }, pool: { min: 1, max: 1 },
  });
  await db.migrate.latest();
  await ingest([
    ['Kamal Fadawi', 'Song A', 'YouTube', 'Jan 2026', '4'],
    ['Kamal Fadawi', 'Song A', 'Spotify', 'Jan 2026', '2'],
    ['Kamal Fadawi', 'Song B', 'YouTube', 'Feb 2026', '6'],
  ]);
});
after(async () => { await db.destroy(); try { fs.unlinkSync(DB); } catch (_) {} });

test('getArtistExport returns grouped detail + summaries, null when missing', async () => {
  assert.equal(await service.getArtistExport(db, 'nobody'), null);
  const d = await service.getArtistExport(db, 'kamal-fadawi');
  assert.equal(d.artist, 'Kamal Fadawi');
  assert.equal(Math.round(d.total * 100) / 100, 12);
  assert.equal(d.detail.length, 3, 'one row per track×store×month');
  // by month newest first
  assert.equal(d.byMonth[0].period, '2026-02');
  assert.equal(d.byMonth.find((m) => m.period === '2026-01').total, 6);
  // by platform
  assert.equal(d.byPlatform.find((p) => p.name === 'YouTube').rev, 10);
});

test('buildArtistWorkbook produces a readable styled sheet with the right numbers', async () => {
  const data = await service.getArtistExport(db, 'kamal-fadawi');
  const wb = buildArtistWorkbook(data);
  const buf = await wb.xlsx.writeBuffer();
  const rt = new ExcelJS.Workbook();
  await rt.xlsx.load(buf);
  const ws = rt.worksheets[0];
  assert.ok(/Kamal Fadawi/.test(String(ws.getCell('A1').value)), 'title carries the artist');
  // grand total appears somewhere in the first row band
  const flat = [];
  ws.eachRow((row) => row.eachCell((c) => flat.push(c.value)));
  const nums = flat.map((v) => (v && typeof v === 'object' && 'result' in v) ? v.result : v).filter((v) => typeof v === 'number');
  assert.ok(nums.some((n) => Math.abs(n - 12) < 0.001), 'grand total 12 present');
  // detail rows present (Song A / Song B somewhere)
  const text = flat.map((v) => String(v == null ? '' : (v.richText ? v.richText.map((t) => t.text).join('') : v))).join('|');
  assert.ok(/Song A/.test(text) && /Song B/.test(text), 'detail tracks rendered');
  assert.ok(/YouTube/.test(text), 'stores rendered');
});
