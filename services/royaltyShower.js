const { parse } = require('csv-parse/sync');

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTH_LOOKUP = { jan:1,january:1,feb:2,february:2,mar:3,march:3,apr:4,april:4,may:5,jun:6,june:6,jul:7,july:7,aug:8,august:8,sep:9,sept:9,september:9,oct:10,october:10,nov:11,november:11,dec:12,december:12 };

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

function parsePeriod(val) {
  if (val === null || val === undefined || val === '') return null;
  const mk = (mo, y) => `${y}-${String(mo).padStart(2, '0')}`;
  if (val instanceof Date && !isNaN(val)) return mk(val.getMonth() + 1, val.getFullYear());
  const s = String(val).trim();
  if (!s) return null;

  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (m) {
    const a = parseInt(m[1]), b = parseInt(m[2]), y = parseInt(m[3]);
    let mo;
    if (a > 12) mo = b;
    else if (b > 12) mo = a;
    else mo = b;
    if (mo >= 1 && mo <= 12) return mk(mo, y);
  }
  m = s.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/);
  if (m) {
    const y = parseInt(m[1]), mo = parseInt(m[2]);
    if (mo >= 1 && mo <= 12) return mk(mo, y);
  }
  m = s.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (m) {
    const mo = MONTH_LOOKUP[m[1].toLowerCase()];
    if (mo) return mk(mo, parseInt(m[2]));
  }
  const d = new Date(s);
  if (!isNaN(d)) return mk(d.getMonth() + 1, d.getFullYear());
  return null;
}

function detectDelimiter(text) {
  const first = text.split(/\r?\n/)[0] || '';
  const semi = (first.match(/;/g) || []).length;
  const comma = (first.match(/,/g) || []).length;
  const tab = (first.match(/\t/g) || []).length;
  if (tab > semi && tab > comma) return '\t';
  if (semi > comma) return ';';
  return ',';
}

function findCol(headers, ...candidates) {
  for (const c of candidates) {
    const hit = headers.find(h => String(h || '').toUpperCase().includes(c.toUpperCase()));
    if (hit) return hit;
  }
  return null;
}

function parseCsvBuffer(buffer) {
  const text = buffer.toString('utf8');
  const delimiter = detectDelimiter(text);
  const rows = parse(text, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    delimiter,
    trim: true
  });
  return rows;
}

async function ingestCsv({ db, filename, buffer, uploadedBy = null }) {
  const rows = parseCsvBuffer(buffer);
  if (rows.length === 0) throw new Error('CSV is empty');

  const headers = Object.keys(rows[0]);
  const artistCol  = findCol(headers, 'PRODUCT ARTIST', 'TRACK ARTIST', 'ARTIST NAME', 'ARTIST', 'PRODUCT_ARTIST');
  const trackCol   = findCol(headers, 'TRACK TITLE', 'TRACK', 'SONG', 'PRODUCT');
  const storeCol   = findCol(headers, 'STORE', 'PLATFORM', 'DSP', 'SERVICE');
  const countryCol = findCol(headers, 'SALE COUNTRY', 'COUNTRY', 'TERRITORY', 'REGION');
  const revenueCol = findCol(headers, 'NET REVENUE', 'NET SHARE ACCOUNT CURRENCY', 'NET SHARE', 'NET_REVENUE', 'NET_SHARE', 'EARNINGS', 'REVENUE', 'AMOUNT');
  const monthCol   = findCol(headers, 'REPORTING MONTH', 'SALES MONTH', 'STATEMENT PERIOD', 'PERIOD', 'TRANSACTION DATE', 'MONTH', 'DATE');
  const typeCol    = findCol(headers, 'TRANSACTION TYPE', 'SALES TYPE', 'SALE TYPE', 'TRANSACTION_TYPE');
  const qtyCol     = findCol(headers, 'QUANTITY', 'UNITS', 'STREAMS');

  if (!artistCol || !revenueCol) {
    throw new Error(`Required columns missing. Found: artist=${artistCol || '✗'}, revenue=${revenueCol || '✗'}`);
  }

  const normalized = [];
  const artistsSeen = new Set();
  const periodsSeen = new Set();
  let total = 0;

  for (const row of rows) {
    const artistName = String(row[artistCol] || '').trim();
    const rev = parseFloat(row[revenueCol]) || 0;
    if (!artistName || rev === 0) continue;

    const track = String((trackCol && row[trackCol]) || '').trim() || null;
    const store = String((storeCol && row[storeCol]) || '').trim() || null;
    const country = String((countryCol && row[countryCol]) || '').trim() || null;
    const period = monthCol ? parsePeriod(row[monthCol]) : null;
    const type = String((typeCol && row[typeCol]) || '').trim() || null;
    const qty = qtyCol ? parseInt(row[qtyCol]) || 0 : 0;

    artistsSeen.add(artistName);
    if (period) periodsSeen.add(period);
    total += rev;

    normalized.push({
      artist_name: artistName,
      artist_slug: slugify(artistName),
      track, store, country, period,
      transaction_type: type,
      quantity: qty,
      net_revenue: rev
    });
  }

  if (normalized.length === 0) throw new Error('No valid rows to import (all zero revenue or missing artist).');

  const periods = [...periodsSeen].sort();
  const periodStart = periods[0] || null;
  const periodEnd = periods[periods.length - 1] || null;

  const [importId] = await db('royalty_imports').insert({
    filename,
    period_start: periodStart,
    period_end: periodEnd,
    row_count: normalized.length,
    total_revenue: total,
    uploaded_by: uploadedBy
  });

  // Ensure artist_slugs entries exist
  for (const artistName of artistsSeen) {
    const slug = slugify(artistName);
    const existing = await db('artist_slugs').where({ slug }).first();
    if (!existing) {
      try {
        await db('artist_slugs').insert({ slug, artist_name: artistName });
      } catch (_) { /* unique collision — ignore */ }
    }
  }

  // Batch insert rows
  const batchSize = 500;
  for (let i = 0; i < normalized.length; i += batchSize) {
    const batch = normalized.slice(i, i + batchSize).map(r => ({ ...r, import_id: importId }));
    await db('royalty_rows').insert(batch);
  }

  return {
    importId,
    rowCount: normalized.length,
    totalRevenue: total,
    artistCount: artistsSeen.size,
    periodStart,
    periodEnd
  };
}

async function listArtists(db) {
  const rows = await db('royalty_rows')
    .select('artist_slug', 'artist_name')
    .sum({ total_rev: 'net_revenue' })
    .count({ row_count: 'id' })
    .countDistinct({ period_count: 'period' })
    .groupBy('artist_slug', 'artist_name')
    .orderBy('total_rev', 'desc');

  // Latest period per artist
  const latestRows = await db('royalty_rows')
    .select('artist_slug')
    .max({ latest_period: 'period' })
    .groupBy('artist_slug');
  const latestMap = Object.fromEntries(latestRows.map(r => [r.artist_slug, r.latest_period]));

  return rows.map(r => ({
    slug: r.artist_slug,
    name: r.artist_name,
    totalRevenue: parseFloat(r.total_rev) || 0,
    rowCount: parseInt(r.row_count) || 0,
    periodCount: parseInt(r.period_count) || 0,
    latestPeriod: latestMap[r.artist_slug] || null
  }));
}

async function listPeriodsForArtist(db, slug) {
  const rows = await db('royalty_rows')
    .where({ artist_slug: slug })
    .distinct('period')
    .whereNotNull('period')
    .orderBy('period', 'desc');
  return rows.map(r => r.period).filter(Boolean);
}

async function buildReport(db, slug, period = null) {
  const slugRow = await db('artist_slugs').where({ slug }).first();
  if (!slugRow) return null;

  const periods = await listPeriodsForArtist(db, slug);
  const activePeriod = period && periods.includes(period) ? period : periods[0] || null;

  const q = db('royalty_rows').where({ artist_slug: slug });
  if (activePeriod) q.andWhere({ period: activePeriod });

  const rows = await q.select('*');

  if (rows.length === 0) {
    return {
      artist: { name: slugRow.artist_name, slug: slugRow.slug },
      period: activePeriod,
      periods,
      totalRevenue: 0,
      totalQuantity: 0,
      stores: [], countries: [], tracks: [], types: []
    };
  }

  const sumBy = (key) => {
    const map = {};
    for (const r of rows) {
      const k = r[key] || 'Unknown';
      if (!map[k]) map[k] = { name: k, rev: 0, qty: 0 };
      map[k].rev += parseFloat(r.net_revenue) || 0;
      map[k].qty += parseInt(r.quantity) || 0;
    }
    return Object.values(map).sort((a, b) => b.rev - a.rev);
  };

  const tracks = sumBy('track').filter(t => t.name !== 'Unknown' && t.name != null);
  const stores = sumBy('store').filter(s => s.name !== 'Unknown');
  const countries = sumBy('country').filter(c => c.name !== 'Unknown');
  const types = sumBy('transaction_type').filter(t => t.name !== 'Unknown' && t.name != null);

  const totalRevenue = rows.reduce((s, r) => s + (parseFloat(r.net_revenue) || 0), 0);
  const totalQuantity = rows.reduce((s, r) => s + (parseInt(r.quantity) || 0), 0);

  return {
    artist: { name: slugRow.artist_name, slug: slugRow.slug },
    period: activePeriod,
    periods,
    totalRevenue,
    totalQuantity,
    stores, countries, tracks, types
  };
}

module.exports = { ingestCsv, listArtists, listPeriodsForArtist, buildReport, slugify };
