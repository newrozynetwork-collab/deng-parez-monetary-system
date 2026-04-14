const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { exportRevenueToExcel } = require('../services/exporter');

router.get('/dashboard', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const db = req.db;

    // Total revenue
    let revQuery = db('revenue_entries');
    if (start) revQuery = revQuery.where('period_start', '>=', start);
    if (end) revQuery = revQuery.where('period_end', '<=', end);
    const totalRevResult = await revQuery.sum('amount as total').first();
    const totalRevenue = parseFloat(totalRevResult.total) || 0;

    // Distributions breakdown
    let distQuery = db('revenue_distributions').join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id');
    if (start) distQuery = distQuery.where('revenue_entries.period_start', '>=', start);
    if (end) distQuery = distQuery.where('revenue_entries.period_end', '<=', end);

    const distSums = await distQuery
      .groupBy('revenue_distributions.recipient_type')
      .select('revenue_distributions.recipient_type')
      .sum('revenue_distributions.amount as total');

    const distMap = {};
    distSums.forEach(d => { distMap[d.recipient_type] = parseFloat(d.total) || 0; });

    // Expenses
    let expQuery = db('expenses');
    if (start) expQuery = expQuery.where('date', '>=', start);
    if (end) expQuery = expQuery.where('date', '<=', end);
    const expResult = await expQuery.sum('amount as total').first();
    const totalExpenses = parseFloat(expResult.total) || 0;

    // Additional income
    let incQuery = db('additional_income');
    if (start) incQuery = incQuery.where('date', '>=', start);
    if (end) incQuery = incQuery.where('date', '<=', end);
    const incResult = await incQuery.sum('amount as total').first();
    const totalAdditionalIncome = parseFloat(incResult.total) || 0;

    // Active artists count
    const artistCount = await db('artists').count('id as count').first();

    // Revenue by source
    let srcQuery = db('revenue_entries');
    if (start) srcQuery = srcQuery.where('period_start', '>=', start);
    if (end) srcQuery = srcQuery.where('period_end', '<=', end);
    const revenueBySource = await srcQuery.groupBy('source').select('source').sum('amount as total');

    // Monthly revenue trend (last 12 months)
    const monthlyRevenue = await db.raw(`
      SELECT
        ${process.env.DATABASE_URL
          ? `TO_CHAR(period_start, 'YYYY-MM') as month`
          : `strftime('%Y-%m', period_start) as month`
        },
        SUM(amount) as total
      FROM revenue_entries
      WHERE period_start IS NOT NULL
      GROUP BY month
      ORDER BY month DESC
      LIMIT 12
    `);

    const totalPayouts = (distMap.artist || 0) + (distMap.referral || 0);
    const netProfit = (distMap.company || 0) + totalAdditionalIncome - totalExpenses;

    res.json({
      totalRevenue,
      totalPayouts,
      netProfit,
      totalExpenses,
      totalAdditionalIncome,
      totalBankFees: distMap.bank_fee || 0,
      totalArtistPayouts: distMap.artist || 0,
      totalReferralPayouts: distMap.referral || 0,
      companyGross: distMap.company || 0,
      activeArtists: parseInt(artistCount.count) || 0,
      revenueBySource: revenueBySource.map(r => ({ source: r.source, total: parseFloat(r.total) })),
      monthlyRevenue: (monthlyRevenue.rows || monthlyRevenue).map(r => ({
        month: r.month,
        total: parseFloat(r.total)
      })).reverse()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/financial-summary', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const db = req.db;

    const buildQuery = (table, dateCol) => {
      let q = db(table);
      if (start) q = q.where(dateCol, '>=', start);
      if (end) q = q.where(dateCol, '<=', end);
      return q;
    };

    const [revResult, expResult, incResult] = await Promise.all([
      buildQuery('revenue_entries', 'period_start').sum('amount as total').first(),
      buildQuery('expenses', 'date').sum('amount as total').first(),
      buildQuery('additional_income', 'date').sum('amount as total').first()
    ]);

    // Get distribution totals
    let distQuery = db('revenue_distributions')
      .join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id');
    if (start) distQuery = distQuery.where('revenue_entries.period_start', '>=', start);
    if (end) distQuery = distQuery.where('revenue_entries.period_end', '<=', end);
    const distSums = await distQuery
      .groupBy('revenue_distributions.recipient_type')
      .select('revenue_distributions.recipient_type')
      .sum('revenue_distributions.amount as total');
    const distMap = {};
    distSums.forEach(d => { distMap[d.recipient_type] = parseFloat(d.total) || 0; });

    const totalRevenue = parseFloat(revResult.total) || 0;
    const totalExpenses = parseFloat(expResult.total) || 0;
    const totalAdditionalIncome = parseFloat(incResult.total) || 0;

    res.json({
      totalRevenue,
      totalBankFees: distMap.bank_fee || 0,
      totalArtistPayouts: distMap.artist || 0,
      totalReferralPayouts: distMap.referral || 0,
      companyRevenue: distMap.company || 0,
      totalExpenses,
      totalAdditionalIncome,
      netCompanyProfit: (distMap.company || 0) + totalAdditionalIncome - totalExpenses
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// User breakdown
router.get('/user/:name', requireAuth, async (req, res) => {
  try {
    const name = decodeURIComponent(req.params.name);
    const db = req.db;

    // Check if it's an artist
    const artist = await db('artists').where('name', name).first();

    // Get all distributions for this name
    const distributions = await db('revenue_distributions')
      .join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id')
      .join('artists', 'revenue_entries.artist_id', 'artists.id')
      .where('revenue_distributions.recipient_name', name)
      .select(
        'revenue_distributions.*',
        'revenue_entries.amount as entry_amount',
        'revenue_entries.period_start',
        'revenue_entries.period_end',
        'revenue_entries.source',
        'artists.name as artist_name'
      )
      .orderBy('revenue_entries.period_start', 'desc');

    const totalEarned = distributions.reduce((s, d) => s + parseFloat(d.amount), 0);

    // Monthly timeline
    const monthlyData = {};
    distributions.forEach(d => {
      const month = d.period_start ? d.period_start.toString().slice(0, 7) : 'unknown';
      if (!monthlyData[month]) monthlyData[month] = 0;
      monthlyData[month] += parseFloat(d.amount);
    });

    const timeline = Object.entries(monthlyData)
      .map(([month, total]) => ({ month, total: Math.round(total * 100) / 100 }))
      .sort((a, b) => a.month.localeCompare(b.month));

    res.json({
      name,
      isArtist: !!artist,
      artistInfo: artist || null,
      totalEarned: Math.round(totalEarned * 100) / 100,
      distributions,
      timeline
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all unique recipient names for dropdown
router.get('/recipients', requireAuth, async (req, res) => {
  try {
    const recipients = await req.db('revenue_distributions')
      .distinct('recipient_name', 'recipient_type')
      .orderBy('recipient_name');
    res.json(recipients);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export to Excel
router.get('/export', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    const db = req.db;

    let entryQuery = db('revenue_entries')
      .join('artists', 'revenue_entries.artist_id', 'artists.id')
      .select('revenue_entries.*', 'artists.name as artist_name');
    if (start) entryQuery = entryQuery.where('period_start', '>=', start);
    if (end) entryQuery = entryQuery.where('period_end', '<=', end);
    const entries = await entryQuery.orderBy('revenue_entries.created_at', 'desc');

    const entryIds = entries.map(e => e.id);
    const allDists = await db('revenue_distributions').whereIn('revenue_entry_id', entryIds);

    // Enrich entries with calculated fields
    entries.forEach(e => {
      const dists = allDists.filter(d => d.revenue_entry_id === e.id);
      const bankFee = dists.find(d => d.recipient_type === 'bank_fee');
      const artistD = dists.find(d => d.recipient_type === 'artist');
      const companyD = dists.find(d => d.recipient_type === 'company');
      const referralDs = dists.filter(d => d.recipient_type === 'referral');
      e.bank_fee = bankFee ? parseFloat(bankFee.amount) : 0;
      e.net_revenue = parseFloat(e.amount) - e.bank_fee;
      e.artist_share = artistD ? parseFloat(artistD.amount) : 0;
      e.company_gross = e.artist_share + (companyD ? parseFloat(companyD.amount) : 0) + referralDs.reduce((s, d) => s + parseFloat(d.amount), 0);
      e.company_gross = parseFloat(e.amount) - e.bank_fee - e.artist_share;
      e.total_referrals = referralDs.reduce((s, d) => s + parseFloat(d.amount), 0);
      e.company_net = companyD ? parseFloat(companyD.amount) : 0;
    });

    // Build distributions with artist names
    const distributions = allDists.map(d => {
      const entry = entries.find(e => e.id === d.revenue_entry_id);
      return { ...d, artist_name: entry ? entry.artist_name : '' };
    });

    // Financial summary
    const distSums = {};
    allDists.forEach(d => {
      if (!distSums[d.recipient_type]) distSums[d.recipient_type] = 0;
      distSums[d.recipient_type] += parseFloat(d.amount);
    });

    let expQuery = db('expenses');
    if (start) expQuery = expQuery.where('date', '>=', start);
    if (end) expQuery = expQuery.where('date', '<=', end);
    const expResult = await expQuery.sum('amount as total').first();

    let incQuery = db('additional_income');
    if (start) incQuery = incQuery.where('date', '>=', start);
    if (end) incQuery = incQuery.where('date', '<=', end);
    const incResult = await incQuery.sum('amount as total').first();

    const summary = {
      totalRevenue: entries.reduce((s, e) => s + parseFloat(e.amount), 0),
      totalBankFees: distSums.bank_fee || 0,
      totalArtistPayouts: distSums.artist || 0,
      totalReferralPayouts: distSums.referral || 0,
      totalExpenses: parseFloat(expResult.total) || 0,
      totalAdditionalIncome: parseFloat(incResult.total) || 0,
      netCompanyProfit: (distSums.company || 0) + (parseFloat(incResult.total) || 0) - (parseFloat(expResult.total) || 0)
    };

    await exportRevenueToExcel({ entries, distributions, summary }, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
