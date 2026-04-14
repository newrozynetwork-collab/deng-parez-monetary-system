const router = require('express').Router();
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const ExcelJS = require('exceljs');
const { requireAdmin } = require('../middleware/auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/artists', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let rows;
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    if (ext === 'csv') {
      rows = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      const headers = [];
      sheet.getRow(1).eachCell((cell, i) => { headers[i - 1] = cell.value?.toString().toLowerCase().trim(); });
      rows = [];
      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const obj = {};
        row.eachCell((cell, i) => { obj[headers[i - 1]] = cell.value; });
        rows.push(obj);
      });
    } else {
      return res.status(400).json({ error: 'Unsupported file format. Use CSV or XLSX.' });
    }

    let imported = 0;
    for (const row of rows) {
      const name = row.name || row.artist || row.artist_name;
      if (!name) continue;

      const existing = await req.db('artists').where('name', name).first();
      if (existing) continue;

      const [id] = await req.db('artists').insert({
        name,
        nickname: row.nickname || null,
        revenue_type: row.revenue_type || row.type || 'both',
        artist_split_pct: parseFloat(row.artist_split_pct || row.artist_split || 60),
        company_split_pct: parseFloat(row.company_split_pct || row.company_split || 40),
        bank_fee_pct: parseFloat(row.bank_fee_pct || row.bank_fee || 2.5),
        notes: row.notes || null
      });
      const artistId = typeof id === 'object' ? id.id : id;

      // Import referrals if present (format: "Name1:35,Name2:5")
      const refStr = row.referrals || row.referral_chain;
      if (refStr) {
        const refs = refStr.toString().split(',').map((r, i) => {
          const [rName, pct] = r.trim().split(':');
          return { artist_id: artistId, level: i + 1, referrer_name: rName.trim(), commission_pct: parseFloat(pct) || 0 };
        }).filter(r => r.referrer_name);
        if (refs.length) await req.db('referral_levels').insert(refs);
      }
      imported++;
    }

    res.json({ imported, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/revenue', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    let rows;
    const ext = req.file.originalname.split('.').pop().toLowerCase();

    if (ext === 'csv') {
      rows = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(req.file.buffer);
      const sheet = workbook.worksheets[0];
      const headers = [];
      sheet.getRow(1).eachCell((cell, i) => { headers[i - 1] = cell.value?.toString().toLowerCase().trim(); });
      rows = [];
      sheet.eachRow((row, rowNum) => {
        if (rowNum === 1) return;
        const obj = {};
        row.eachCell((cell, i) => { obj[headers[i - 1]] = cell.value; });
        rows.push(obj);
      });
    } else {
      return res.status(400).json({ error: 'Unsupported file format' });
    }

    let imported = 0;
    const { calculate } = require('../services/calculator');

    for (const row of rows) {
      const artistName = row.artist || row.artist_name || row.name;
      const amount = parseFloat(row.amount || row.revenue || 0);
      if (!artistName || !amount) continue;

      const artist = await req.db('artists').where('name', artistName).first();
      if (!artist) continue;

      const referrals = await req.db('referral_levels').where({ artist_id: artist.id }).orderBy('level');
      const calc = calculate({
        grossRevenue: amount,
        bankFeePct: parseFloat(artist.bank_fee_pct),
        artistSplitPct: parseFloat(artist.artist_split_pct),
        companySplitPct: parseFloat(artist.company_split_pct),
        referralLevels: referrals.map(r => ({
          level: r.level, referrerName: r.referrer_name, commissionPct: parseFloat(r.commission_pct)
        }))
      });

      const [entryId] = await req.db('revenue_entries').insert({
        artist_id: artist.id, amount,
        source: row.source || artist.revenue_type || 'both',
        period_start: row.period_start || row.start_date || row.date || null,
        period_end: row.period_end || row.end_date || null,
        notes: row.notes || null,
        created_by: req.session.userId
      });
      const id = typeof entryId === 'object' ? entryId.id : entryId;

      const distributions = [
        { revenue_entry_id: id, recipient_type: 'artist', recipient_name: artist.name, amount: calc.artistShare },
        { revenue_entry_id: id, recipient_type: 'company', recipient_name: 'Company', amount: calc.companyNet },
        { revenue_entry_id: id, recipient_type: 'bank_fee', recipient_name: 'Bank Fee', amount: calc.bankFee }
      ];
      calc.referralBreakdown.forEach(r => {
        distributions.push({ revenue_entry_id: id, recipient_type: 'referral', recipient_name: r.referrerName, amount: r.amount });
      });
      await req.db('revenue_distributions').insert(distributions);
      imported++;
    }

    res.json({ imported, total: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
