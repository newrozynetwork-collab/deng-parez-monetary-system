const ExcelJS = require('exceljs');

async function exportRevenueToExcel(data, res) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Deng Parez Monetary System';

  // Revenue Summary Sheet
  const summarySheet = workbook.addWorksheet('Revenue Summary');
  summarySheet.columns = [
    { header: 'Date', key: 'date', width: 15 },
    { header: 'Artist', key: 'artist', width: 20 },
    { header: 'Source', key: 'source', width: 15 },
    { header: 'Gross Revenue', key: 'gross', width: 15 },
    { header: 'Bank Fee', key: 'bankFee', width: 12 },
    { header: 'Net Revenue', key: 'net', width: 15 },
    { header: 'Artist Share', key: 'artistShare', width: 15 },
    { header: 'Company Gross', key: 'companyGross', width: 15 },
    { header: 'Total Referrals', key: 'totalReferrals', width: 15 },
    { header: 'Company Net', key: 'companyNet', width: 15 }
  ];

  // Style header row
  summarySheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  summarySheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C63FF' } };

  data.entries.forEach(entry => {
    summarySheet.addRow({
      date: entry.period_start || entry.created_at,
      artist: entry.artist_name,
      source: entry.source,
      gross: entry.amount,
      bankFee: entry.bank_fee,
      net: entry.net_revenue,
      artistShare: entry.artist_share,
      companyGross: entry.company_gross,
      totalReferrals: entry.total_referrals,
      companyNet: entry.company_net
    });
  });

  // Format currency columns
  ['gross', 'bankFee', 'net', 'artistShare', 'companyGross', 'totalReferrals', 'companyNet'].forEach(key => {
    summarySheet.getColumn(key).numFmt = '$#,##0.00';
  });

  // Distributions Sheet
  if (data.distributions && data.distributions.length > 0) {
    const distSheet = workbook.addWorksheet('Distributions');
    distSheet.columns = [
      { header: 'Revenue Entry ID', key: 'entryId', width: 15 },
      { header: 'Artist', key: 'artist', width: 20 },
      { header: 'Recipient Type', key: 'type', width: 15 },
      { header: 'Recipient Name', key: 'name', width: 20 },
      { header: 'Amount', key: 'amount', width: 15 }
    ];
    distSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    distSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF6C63FF' } };

    data.distributions.forEach(d => {
      distSheet.addRow({
        entryId: d.revenue_entry_id,
        artist: d.artist_name,
        type: d.recipient_type,
        name: d.recipient_name,
        amount: d.amount
      });
    });
    distSheet.getColumn('amount').numFmt = '$#,##0.00';
  }

  // Financial Summary Sheet
  if (data.summary) {
    const sumSheet = workbook.addWorksheet('Financial Summary');
    sumSheet.addRow(['Metric', 'Amount']);
    sumSheet.getRow(1).font = { bold: true };
    sumSheet.addRow(['Total Revenue', data.summary.totalRevenue]);
    sumSheet.addRow(['Total Bank Fees', data.summary.totalBankFees]);
    sumSheet.addRow(['Total Artist Payouts', data.summary.totalArtistPayouts]);
    sumSheet.addRow(['Total Referral Payouts', data.summary.totalReferralPayouts]);
    sumSheet.addRow(['Total Expenses', data.summary.totalExpenses]);
    sumSheet.addRow(['Total Additional Income', data.summary.totalAdditionalIncome]);
    sumSheet.addRow(['Net Company Profit', data.summary.netCompanyProfit]);
    sumSheet.getColumn(1).width = 25;
    sumSheet.getColumn(2).width = 18;
    sumSheet.getColumn(2).numFmt = '$#,##0.00';
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=revenue-report-${new Date().toISOString().slice(0, 10)}.xlsx`);
  await workbook.xlsx.write(res);
}

async function exportArtistsToExcel(artists, res) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Deng Parez Monetary System';

  const sheet = workbook.addWorksheet('Artists');
  sheet.columns = [
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Nickname', key: 'nickname', width: 20 },
    { header: 'Revenue Type', key: 'revenue_type', width: 15 },
    { header: 'Artist Split %', key: 'artist_split', width: 15 },
    { header: 'Company Split %', key: 'company_split', width: 15 },
    { header: 'Bank Fee %', key: 'bank_fee', width: 12 },
    { header: 'Referrals', key: 'referrals', width: 50 },
    { header: 'Total Revenue', key: 'total_revenue', width: 15 },
    { header: 'Total Earned', key: 'total_earned', width: 15 },
    { header: 'Notes', key: 'notes', width: 40 },
    { header: 'Created', key: 'created_at', width: 20 }
  ];

  // Style header row
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF3B82F6' } };
  sheet.getRow(1).height = 22;
  sheet.getRow(1).alignment = { vertical: 'middle' };

  artists.forEach(a => {
    const refs = (a.referrals || [])
      .map(r => `L${r.level}: ${r.referrer_name} (${r.commission_pct}%)`)
      .join(', ');
    sheet.addRow({
      name: a.name,
      nickname: a.nickname || '',
      revenue_type: a.revenue_type,
      artist_split: parseFloat(a.artist_split_pct),
      company_split: parseFloat(a.company_split_pct),
      bank_fee: parseFloat(a.bank_fee_pct),
      referrals: refs || '—',
      total_revenue: a.total_revenue || 0,
      total_earned: a.total_earned || 0,
      notes: a.notes || '',
      created_at: a.created_at ? new Date(a.created_at).toISOString().slice(0, 10) : ''
    });
  });

  // Format percentage columns
  ['artist_split', 'company_split', 'bank_fee'].forEach(k => {
    sheet.getColumn(k).numFmt = '0.00"%"';
  });
  ['total_revenue', 'total_earned'].forEach(k => {
    sheet.getColumn(k).numFmt = '$#,##0.00';
  });

  // Freeze header row
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  // Alternate row colors
  for (let i = 2; i <= artists.length + 1; i++) {
    if (i % 2 === 0) {
      sheet.getRow(i).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    }
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename=artists-${new Date().toISOString().slice(0, 10)}.xlsx`);
  await workbook.xlsx.write(res);
}

function exportArtistsToCSV(artists, res) {
  const escape = v => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };

  const headers = ['Name', 'Nickname', 'Revenue Type', 'Artist Split %', 'Company Split %', 'Bank Fee %', 'Referrals', 'Total Revenue', 'Total Earned', 'Notes'];
  const rows = [headers.join(',')];

  artists.forEach(a => {
    const refs = (a.referrals || [])
      .map(r => `L${r.level}: ${r.referrer_name} (${r.commission_pct}%)`)
      .join('; ');
    rows.push([
      escape(a.name),
      escape(a.nickname),
      escape(a.revenue_type),
      escape(a.artist_split_pct),
      escape(a.company_split_pct),
      escape(a.bank_fee_pct),
      escape(refs),
      escape(a.total_revenue || 0),
      escape(a.total_earned || 0),
      escape(a.notes)
    ].join(','));
  });

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=artists-${new Date().toISOString().slice(0, 10)}.csv`);
  res.send('\ufeff' + rows.join('\n'));
}

module.exports = { exportRevenueToExcel, exportArtistsToExcel, exportArtistsToCSV };
