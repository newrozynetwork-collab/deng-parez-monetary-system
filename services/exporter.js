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

module.exports = { exportRevenueToExcel };
