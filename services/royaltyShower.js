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
  const norm = headers.map(h => ({ raw: h, up: String(h || '').toUpperCase().trim() }));
  // Prefer an EXACT header match (in candidate priority order) so that, e.g.,
  // "TRACK" wins over "TRACK ARTIST" — Orchard lists TRACK ARTIST before the
  // real TRACK (song title) column, and a substring match grabbed the wrong one.
  for (const c of candidates) {
    const cu = c.toUpperCase().trim();
    const hit = norm.find(h => h.up === cu);
    if (hit) return hit.raw;
  }
  // Fall back to substring matching for distributors with longer header names.
  for (const c of candidates) {
    const cu = c.toUpperCase().trim();
    const hit = norm.find(h => h.up.includes(cu));
    if (hit) return hit.raw;
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

async function ingestCsv({ db, filename, buffer, uploadedBy = null, aggregate = false }) {
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
    // Specifically detect aggregate-only Orchard breakdown reports so the
    // user gets a clear message instead of a cryptic "columns missing".
    const upper = headers.map(h => String(h || '').toUpperCase());
    const has = (k) => upper.some(h => h.includes(k));
    let kind = null;
    if (!artistCol) {
      if (has('COUNTRY') || has('TERRITORY') || has('REGION')) kind = 'Countries';
      else if (has('STORE') || has('PLATFORM') || has('DSP')) kind = 'Stores';
      else if (has('STATEMENT') && (has('PERIOD') || has('MONTH'))) kind = 'Statement Periods';
    }
    if (kind) {
      throw new Error(
        `This looks like an aggregate "${kind}" report — it has no per-artist breakdown ` +
        `(no Primary Artist / Track Artist column). Report Shower needs per-artist data. ` +
        `Upload the "Tracks" report or the raw "revenue details" CSV from your distributor instead.`
      );
    }
    throw new Error(`Required columns missing. Found: artist=${artistCol || '✗'}, revenue=${revenueCol || '✗'}. ` +
      `Headers in file: ${headers.join(', ')}`);
  }

  const normalized = [];
  for (const row of rows) {
    // Collab credits like "Miran Ali, Aziz Waisi" collapse to the primary (first) artist.
    const artistName = String(row[artistCol] || '').split(',')[0].trim();
    const rev = parseFloat(row[revenueCol]) || 0;
    if (!artistName || rev === 0) continue;

    const track = String((trackCol && row[trackCol]) || '').trim() || null;
    const store = String((storeCol && row[storeCol]) || '').trim() || null;
    const country = String((countryCol && row[countryCol]) || '').trim() || null;
    const period = monthCol ? parsePeriod(row[monthCol]) : null;
    const type = String((typeCol && row[typeCol]) || '').trim() || null;
    const qty = qtyCol ? parseInt(row[qtyCol]) || 0 : 0;

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

  // Replace-on-upload: the file is the source of truth for the (artist, month)
  // combinations it contains. For each of those combos we delete what's stored and
  // insert the file's rows — so re-uploading a file refreshes those months instead
  // of duplicating them. With `aggregate`, we skip the delete and simply add on top
  // (for a legitimate second source, e.g. Believe + Orchard for the same month).
  const total = normalized.reduce((s, r) => s + (r.net_revenue || 0), 0);
  const periods = [...new Set(normalized.map(r => r.period).filter(Boolean))].sort();
  const periodStart = periods[0] || null;
  const periodEnd = periods[periods.length - 1] || null;
  const insertedArtists = new Set(normalized.map(r => r.artist_name));

  let replaced = 0;
  const importId = await db.transaction(async (trx) => {
    if (!aggregate) {
      // Group the file's months per artist, then delete those exact combos.
      const bySlug = new Map();
      for (const r of normalized) {
        if (!bySlug.has(r.artist_slug)) bySlug.set(r.artist_slug, new Set());
        bySlug.get(r.artist_slug).add(r.period || null);
      }
      for (const [slug, periodSet] of bySlug) {
        const ps = [...periodSet];
        const nonNull = ps.filter((p) => p !== null);
        const hasNull = nonNull.length !== ps.length;
        replaced += await trx('royalty_rows').where('artist_slug', slug).andWhere(function () {
          if (nonNull.length) this.whereIn('period', nonNull);
          if (hasNull) this.orWhereNull('period');
        }).del();
      }
    }

    // .returning('id') is required for PostgreSQL (SQLite ignores it cleanly).
    const insertedRows = await trx('royalty_imports')
      .insert({
        filename,
        period_start: periodStart,
        period_end: periodEnd,
        row_count: normalized.length,
        total_revenue: total,
        uploaded_by: uploadedBy
      })
      .returning('id');
    const id = Array.isArray(insertedRows)
      ? (typeof insertedRows[0] === 'object' ? insertedRows[0].id : insertedRows[0])
      : insertedRows;

    // Ensure artist_slugs entries exist for everything we're inserting.
    for (const name of insertedArtists) {
      const slug = slugify(name);
      const existsSlug = await trx('artist_slugs').where({ slug }).first();
      if (!existsSlug) {
        try { await trx('artist_slugs').insert({ slug, artist_name: name }); }
        catch (_) { /* unique collision — ignore */ }
      }
    }

    // Batch insert the file's rows.
    const batchSize = 500;
    for (let i = 0; i < normalized.length; i += batchSize) {
      const batch = normalized.slice(i, i + batchSize).map((r) => ({ ...r, import_id: id }));
      await trx('royalty_rows').insert(batch);
    }

    // Drop any imports the replace left empty, so the admin list stays honest.
    const liveIds = (await trx('royalty_rows').whereNotNull('import_id').distinct('import_id').pluck('import_id'))
      .filter((x) => x !== null && x !== undefined);
    if (liveIds.length) await trx('royalty_imports').whereNotIn('id', liveIds).del();

    return id;
  });

  return {
    importId,
    rowCount: normalized.length,
    replaced,
    skipped: 0, // kept for backward-compat with the admin UI
    totalRevenue: total,
    artistCount: insertedArtists.size,
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
  // No (or unknown) period in the URL → All-time view. A valid period → just that month.
  const isAllTime = !period || period === 'all' || !periods.includes(period);
  const activePeriod = isAllTime ? null : period;

  const q = db('royalty_rows').where({ artist_slug: slug });
  if (activePeriod) q.andWhere({ period: activePeriod });
  const rows = await q.select('*');

  // Monthly summary across ALL of the artist's rows (shown regardless of active scope).
  const allRows = isAllTime ? rows : await db('royalty_rows').where({ artist_slug: slug }).select('period', 'net_revenue', 'quantity');
  const monthMap = {};
  for (const r of allRows) {
    const k = r.period || '—';
    if (!monthMap[k]) monthMap[k] = { period: r.period || null, total: 0, quantity: 0 };
    monthMap[k].total += parseFloat(r.net_revenue) || 0;
    monthMap[k].quantity += parseInt(r.quantity) || 0;
  }
  const byMonth = Object.values(monthMap).sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));

  // No data anywhere for this artist → treat as not found (404), not a blank page.
  if (allRows.length === 0) return null;

  if (rows.length === 0) {
    return {
      artist: { name: slugRow.artist_name, slug: slugRow.slug },
      period: activePeriod,
      periods,
      byMonth,
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
    byMonth,
    totalRevenue,
    totalQuantity,
    stores, countries, tracks, types
  };
}

// Wipe one artist completely: their rows + registry entry, then prune now-empty imports.
async function deleteArtist(db, slug) {
  return db.transaction(async (trx) => {
    const deletedRows = await trx('royalty_rows').where({ artist_slug: slug }).del();
    await trx('artist_slugs').where({ slug }).del();
    const liveIds = (await trx('royalty_rows').whereNotNull('import_id').distinct('import_id').pluck('import_id'))
      .filter((x) => x !== null && x !== undefined);
    if (liveIds.length) await trx('royalty_imports').whereNotIn('id', liveIds).del();
    else await trx('royalty_imports').del();
    return { ok: true, deletedRows };
  });
}

// Delete an import and its rows, then drop any artist left with no rows from the registry.
async function deleteImport(db, id) {
  return db.transaction(async (trx) => {
    const slugs = await trx('royalty_rows').where({ import_id: id }).distinct('artist_slug').pluck('artist_slug');
    await trx('royalty_rows').where({ import_id: id }).del(); // explicit — don't rely on FK cascade
    await trx('royalty_imports').where({ id }).del();
    for (const slug of slugs) {
      const remaining = await trx('royalty_rows').where({ artist_slug: slug }).count('id as c').first();
      if (Number(remaining.c) === 0) await trx('artist_slugs').where({ slug }).del();
    }
    return { ok: true };
  });
}

// Grouped detail + summaries for the styled .xlsx export. Null when the artist has no data.
async function getArtistExport(db, slug) {
  const detail = await db('royalty_rows').where({ artist_slug: slug })
    .select('track', 'store', 'period')
    .sum({ revenue: 'net_revenue' })
    .groupBy('track', 'store', 'period')
    .orderBy('period', 'desc');
  if (!detail.length) return null;
  const first = await db('royalty_rows').where({ artist_slug: slug }).first();
  const artist = first ? first.artist_name : slug;
  const num = (v) => parseFloat(v) || 0;
  const total = detail.reduce((s, r) => s + num(r.revenue), 0);
  const mMap = {};
  for (const r of detail) {
    const k = r.period || '—';
    (mMap[k] = mMap[k] || { period: r.period || null, total: 0 }).total += num(r.revenue);
  }
  const byMonth = Object.values(mMap).sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
  const pMap = {};
  for (const r of detail) {
    const k = r.store || '—';
    (pMap[k] = pMap[k] || { name: r.store || '—', rev: 0 }).rev += num(r.revenue);
  }
  const byPlatform = Object.values(pMap).sort((a, b) => b.rev - a.rev);
  return { artist, slug, total, detail, byMonth, byPlatform };
}

module.exports = { ingestCsv, listArtists, listPeriodsForArtist, buildReport, slugify, findCol, deleteArtist, deleteImport, getArtistExport };
