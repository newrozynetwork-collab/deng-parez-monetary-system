'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isStyledReport, styledReportToRows, rowsToCsv } = require('../public/app/styled-report.js');

// A single artist sheet exactly as the offline Report Generator emits it
// (see rgBuildReportWorkbook): title row, blank, detail header, detail rows,
// detail total (col0 empty), then platform-summary and track-summary sections
// whose data rows DO have a non-empty col0 and must NOT be ingested.
function aramSheet() {
  return {
    name: 'Aram Sardar',
    aoa: [
      ['🎵 Aram Sardar — گزارشی داهات'],
      [],
      ['Track / گۆرانی', 'Store / پلاتفۆرم', 'Revenue / داهات ($)', 'Month / مانگ'],
      ['Yara', 'Spotify', 1.5, 'Jan 2026'],
      ['Yara', 'Apple Music', 0.75, 'Jan 2026'],
      ['Bahar', 'Spotify', 2.0, 'Feb 2026'],
      ['', 'کۆی گشتی داهات ↓', 4.25],
      [],
      [],
      ['پلاتفۆرم', 'کۆی داهات ($)', '٪ لە گشتی'],
      ['Spotify', 3.5, 0.8235],
      ['Apple Music', 0.75, 0.1765],
      ['کۆی گشتی', 4.25, 1],
      [],
      [],
      ['گۆرانی', 'کۆی داهات ($)', '٪ لە گشتی'],
      ['Yara', 2.25, 0.5294],
      ['Bahar', 2.0, 0.4706],
      ['کۆی گشتی', 4.25, 1],
      [],
      ['', '💰 کۆی گشتی داهات', 4.25],
    ],
  };
}

test('detects a Report Generator styled report', () => {
  assert.equal(isStyledReport([aramSheet()]), true);
});

test('does not flag a raw distributor sheet as styled', () => {
  const raw = {
    name: 'Sheet1',
    aoa: [
      ['PRODUCT ARTIST', 'TRACK TITLE', 'STORE', 'NET REVENUE'],
      ['Aram Sardar', 'Yara', 'Spotify', 1.5],
    ],
  };
  assert.equal(isStyledReport([raw]), false);
});

test('extracts the detail rows with artist/track/store/period/revenue', () => {
  const rows = styledReportToRows([aramSheet()]);
  assert.deepEqual(rows, [
    { artist: 'Aram Sardar', track: 'Yara', store: 'Spotify', period: 'Jan 2026', revenue: 1.5 },
    { artist: 'Aram Sardar', track: 'Yara', store: 'Apple Music', period: 'Jan 2026', revenue: 0.75 },
    { artist: 'Aram Sardar', track: 'Bahar', store: 'Spotify', period: 'Feb 2026', revenue: 2.0 },
  ]);
});

test('stops at the total row and ignores the summary sections', () => {
  const rows = styledReportToRows([aramSheet()]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.track !== 'کۆی گشتی'));
});

test('handles a multi-artist report (one sheet per artist)', () => {
  const second = {
    name: 'Hama Jaza',
    aoa: [
      ['🎵 Hama Jaza — گزارشی داهات'],
      [],
      ['Track / گۆرانی', 'Store / پلاتفۆرم', 'Revenue / داهات ($)'],
      ['Sosret', 'YouTube', 5],
      ['', 'کۆی گشتی داهات ↓', 5],
    ],
  };
  const rows = styledReportToRows([aramSheet(), second]);
  assert.deepEqual([...new Set(rows.map((r) => r.artist))], ['Aram Sardar', 'Hama Jaza']);
  assert.equal(rows.length, 4);
});

test('rowsToCsv emits a header the server parser recognizes (incl. period), with CSV escaping', () => {
  const csv = rowsToCsv([{ artist: 'A, B', track: 'x"y', store: 'Spotify', period: 'Jan 2026', revenue: 1.5 }]);
  const lines = csv.split('\n');
  assert.equal(lines[0], 'artist,track,store,period,revenue');
  assert.equal(lines[1], '"A, B","x""y",Spotify,Jan 2026,1.5');
});
