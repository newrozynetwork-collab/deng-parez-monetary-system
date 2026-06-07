'use strict';
// Builds a styled .xlsx for an artist's Report Shower data, matching the
// Report Generator look: title + grand TOTAL, a per-track/store/month detail
// table, and By-Month + By-Platform summary tables. Server-side via exceljs.
const ExcelJS = require('exceljs');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(p) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(p || ''));
  if (!m) return p ? String(p) : '—';
  return `${MONTHS[parseInt(m[2], 10) - 1] || m[2]} ${m[1]}`;
}
function safeSheetName(name) {
  return (String(name || 'Report').replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 31)) || 'Report';
}

const TEAL = 'FF0D9488';
const DARK = 'FF0F172A';
const GOLD = 'FFB45309';
const LIGHT = 'FFF1F5F9';
const BORDER = 'FFD9DEE7';

function buildArtistWorkbook(data) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Deng Parez Report Shower';
  const ws = wb.addWorksheet(safeSheetName(data.artist), { views: [{ state: 'frozen', ySplit: 3 }] });

  ws.columns = [
    { width: 34 }, { width: 26 }, { width: 14 }, { width: 16 },
    { width: 3 }, { width: 16 }, { width: 16 },
    { width: 3 }, { width: 26 }, { width: 16 },
  ];

  const thin = { style: 'thin', color: { argb: BORDER } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const money = (cell, v) => {
    cell.value = Math.round((parseFloat(v) || 0) * 1e6) / 1e6;
    cell.numFmt = '#,##0.00';
    cell.alignment = { horizontal: 'right' };
  };

  // ── Title + grand total ──
  ws.mergeCells('A1:D1');
  const title = ws.getCell('A1');
  title.value = `🎵 ${data.artist} — ووردەکاری هەژمار`;
  title.font = { bold: true, size: 15, color: { argb: DARK } };
  title.alignment = { horizontal: 'left', vertical: 'middle' };
  ws.getRow(1).height = 26;

  const totLabel = ws.getCell('F1');
  totLabel.value = '💰 کۆی گشتی / TOTAL';
  totLabel.font = { bold: true, size: 11, color: { argb: GOLD } };
  totLabel.alignment = { horizontal: 'right', vertical: 'middle' };
  const totVal = ws.getCell('G1');
  money(totVal, data.total);
  totVal.font = { bold: true, size: 13, color: { argb: TEAL } };

  // ── Header row 3 ──
  const headerCell = (addr, text, align) => {
    const c = ws.getCell(addr);
    c.value = text;
    c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: TEAL } };
    c.alignment = { horizontal: align || 'left', vertical: 'middle' };
    c.border = border;
  };
  headerCell('A3', 'Track / گۆرانی');
  headerCell('B3', 'Store / پلاتفۆرم');
  headerCell('C3', 'Month / مانگ');
  headerCell('D3', 'Revenue / داهات ($)', 'right');
  headerCell('F3', 'مانگ / Month');
  headerCell('G3', 'کۆی داهات ($)', 'right');
  headerCell('I3', 'پلاتفۆرم / Platform');
  headerCell('J3', 'کۆی داهات ($)', 'right');
  ws.getRow(3).height = 20;

  // ── Detail rows ──
  let r = 4;
  for (const d of data.detail || []) {
    ws.getCell(`A${r}`).value = d.track || '—';
    ws.getCell(`B${r}`).value = d.store || '—';
    ws.getCell(`C${r}`).value = monthLabel(d.period);
    money(ws.getCell(`D${r}`), d.revenue);
    const tint = r % 2 === 0;
    for (const col of ['A', 'B', 'C', 'D']) {
      const c = ws.getCell(`${col}${r}`);
      c.border = border;
      if (tint) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };
    }
    r++;
  }

  // ── By-month summary ──
  let mr = 4;
  for (const m of data.byMonth || []) {
    ws.getCell(`F${mr}`).value = monthLabel(m.period);
    money(ws.getCell(`G${mr}`), m.total);
    ws.getCell(`F${mr}`).border = border;
    ws.getCell(`G${mr}`).border = border;
    mr++;
  }

  // ── By-platform summary ──
  let pr = 4;
  for (const p of data.byPlatform || []) {
    ws.getCell(`I${pr}`).value = p.name || '—';
    money(ws.getCell(`J${pr}`), p.rev);
    ws.getCell(`I${pr}`).border = border;
    ws.getCell(`J${pr}`).border = border;
    pr++;
  }

  return wb;
}

module.exports = { buildArtistWorkbook, monthLabel, safeSheetName };
