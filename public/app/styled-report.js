// Parses the offline Report Generator's styled per-artist .xlsx output into
// normalized { artist, track, store, revenue } rows that the Report Shower's
// existing CSV importer already understands.
//
// Shared between the browser (loaded as a <script> on shower-admin.html) and the
// Node test (required from tests/). Pure functions operating on a sheet model of
// the form: [{ name: string, aoa: any[][] }] — `aoa` is the sheet as an array of
// rows (XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' })).
(function (global) {
  'use strict';

  function cell(row, i) {
    return row && row[i] != null ? row[i] : '';
  }

  // The styled detail header is bilingual: "Track / گۆرانی" | "Store / ..." |
  // "Revenue / داهات ($)". We require the Kurdish "داهات" (revenue) marker so a
  // raw distributor header (e.g. "TRACK ARTIST … NET REVENUE") is never misread,
  // and we exclude the month / platform / track summary headers (their 3rd
  // column is "٪ لە گشتی" or lacks داهات), which would otherwise pull in the
  // wrong rows.
  function detailHeaderIndex(aoa) {
    for (let i = 0; i < aoa.length; i++) {
      const c0 = String(cell(aoa[i], 0));
      const c2 = String(cell(aoa[i], 2));
      if (c2.indexOf('داهات') !== -1 && (/track/i.test(c0) || c0.indexOf('گۆرانی') !== -1)) {
        return i;
      }
    }
    return -1;
  }

  function isStyledReport(sheets) {
    if (!Array.isArray(sheets)) return false;
    for (const sheet of sheets) {
      const aoa = (sheet && sheet.aoa) || [];
      if (String(cell(aoa[0], 0)).indexOf('گزارشی داهات') !== -1) return true;
      if (detailHeaderIndex(aoa) !== -1) return true;
    }
    return false;
  }

  function artistName(sheet) {
    const aoa = (sheet && sheet.aoa) || [];
    const title = String(cell(aoa[0], 0));
    // Strip a leading emoji / non-letter prefix, then take the part before the
    // em-dash separator (" — گزارشی داهات").
    const parsed = title.replace(/^[^A-Za-z0-9؀-ۿ]+/, '').split('—')[0].trim();
    if (parsed && parsed.indexOf('گزارشی') === -1) return parsed;
    return String((sheet && sheet.name) || '').trim();
  }

  function styledReportToRows(sheets) {
    const out = [];
    if (!Array.isArray(sheets)) return out;
    for (const sheet of sheets) {
      const aoa = (sheet && sheet.aoa) || [];
      const hdr = detailHeaderIndex(aoa);
      if (hdr === -1) continue;
      const artist = artistName(sheet);
      for (let i = hdr + 1; i < aoa.length; i++) {
        const track = String(cell(aoa[i], 0)).trim();
        if (!track) break; // the detail total row has an empty first column → end of detail
        const store = String(cell(aoa[i], 1)).trim();
        const revenue = parseFloat(cell(aoa[i], 2));
        if (!isFinite(revenue)) continue;
        const period = String(cell(aoa[i], 3)).trim(); // 4th detail column = Month / مانگ (blank in older reports)
        out.push({ artist: artist, track: track, store: store, period: period, revenue: revenue });
      }
    }
    return out;
  }

  function rowsToCsv(rows) {
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const lines = ['artist,track,store,period,revenue'];
    for (const r of rows || []) {
      lines.push([esc(r.artist), esc(r.track), esc(r.store), esc(r.period), esc(r.revenue)].join(','));
    }
    return lines.join('\n');
  }

  const api = { isStyledReport, styledReportToRows, rowsToCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.StyledReport = api;
})(typeof window !== 'undefined' ? window : this);
