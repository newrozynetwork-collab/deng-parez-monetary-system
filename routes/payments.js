const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');

// ─── GET /api/payments/summary ──────────────────────────────────
// One row per recipient (artists + referrals + additional-income recipients)
// with: total paid, last paid date, days since last paid, # of payments.
router.get('/summary', requireAuth, async (req, res) => {
  try {
    const db = req.db;

    // 1. Recipients from revenue_distributions (artists + referrals)
    const distRows = await db('revenue_distributions')
      .join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id')
      .select(
        'revenue_distributions.recipient_name as name',
        'revenue_distributions.recipient_type as type',
        'revenue_distributions.amount',
        'revenue_distributions.created_at as paid_at'
      )
      .whereIn('revenue_distributions.recipient_type', ['artist', 'referral']);

    // 2. Recipients from additional_income (commission_to)
    //    The artist isn't a "recipient" here per se, but commission_to is.
    const incRows = await db('additional_income')
      .whereNotNull('commission_to')
      .where('commission_to', '!=', '')
      .select(
        'commission_to as name',
        'amount',
        'commission_pct',
        'date as paid_at'
      );

    // Aggregate
    const map = new Map(); // key = type|name → row

    for (const r of distRows) {
      const key = r.type + '|' + r.name;
      const amt = parseFloat(r.amount) || 0;
      const t = new Date(r.paid_at).getTime();
      let agg = map.get(key);
      if (!agg) { agg = { name: r.name, type: r.type, totalPaid: 0, lastPaidAt: 0, paymentCount: 0 }; map.set(key, agg); }
      agg.totalPaid += amt;
      agg.paymentCount += 1;
      if (t > agg.lastPaidAt) agg.lastPaidAt = t;
    }

    for (const r of incRows) {
      const key = 'additional|' + r.name;
      // The commission goes to commission_to as a percentage of amount
      const cut = (parseFloat(r.amount) || 0) * ((parseFloat(r.commission_pct) || 0) / 100);
      const t = new Date(r.paid_at).getTime();
      let agg = map.get(key);
      if (!agg) { agg = { name: r.name, type: 'additional', totalPaid: 0, lastPaidAt: 0, paymentCount: 0 }; map.set(key, agg); }
      agg.totalPaid += cut;
      agg.paymentCount += 1;
      if (t > agg.lastPaidAt) agg.lastPaidAt = t;
    }

    const now = Date.now();
    const out = [...map.values()].map(r => ({
      name: r.name,
      type: r.type, // 'artist' | 'referral' | 'additional'
      totalPaid: Math.round(r.totalPaid * 100) / 100,
      paymentCount: r.paymentCount,
      lastPaidAt: r.lastPaidAt ? new Date(r.lastPaidAt).toISOString() : null,
      daysSinceLastPaid: r.lastPaidAt ? Math.floor((now - r.lastPaidAt) / 86400000) : null
    }));

    // Default sort: most-overdue first (most days since paid → top)
    out.sort((a, b) => (b.daysSinceLastPaid || 0) - (a.daysSinceLastPaid || 0));

    res.json(out);
  } catch (err) {
    console.error('payments/summary error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/payments/history?name=X&type=Y ────────────────────
// Full payment history for one person (most recent first)
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { name, type } = req.query;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const db = req.db;
    const rows = [];

    if (!type || type === 'artist' || type === 'referral') {
      const dists = await db('revenue_distributions')
        .join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id')
        .leftJoin('artists', 'revenue_entries.artist_id', 'artists.id')
        .where('revenue_distributions.recipient_name', name)
        .modify(q => { if (type) q.andWhere('revenue_distributions.recipient_type', type); else q.whereIn('revenue_distributions.recipient_type', ['artist','referral']); })
        .select(
          'revenue_distributions.id',
          'revenue_distributions.recipient_type as type',
          'revenue_distributions.amount',
          'revenue_distributions.created_at as paid_at',
          'revenue_entries.source',
          'revenue_entries.period_start',
          'revenue_entries.period_end',
          'revenue_entries.amount as gross_amount',
          'artists.name as for_artist',
          'revenue_entries.id as revenue_entry_id'
        );
      for (const d of dists) {
        rows.push({
          id: 'd' + d.id,
          type: d.type,
          amount: parseFloat(d.amount) || 0,
          paidAt: d.paid_at,
          source: d.source || 'revenue',
          periodStart: d.period_start,
          periodEnd: d.period_end,
          forArtist: d.for_artist,
          context: 'Revenue entry · ' + (d.source || 'mixed') + ' · ' + (d.period_start || '?') + ' → ' + (d.period_end || '?'),
          revenueEntryId: d.revenue_entry_id
        });
      }
    }

    if (!type || type === 'additional') {
      const incs = await db('additional_income')
        .where('commission_to', name)
        .select('id', 'source', 'description', 'amount', 'commission_pct', 'date');
      for (const i of incs) {
        const cut = (parseFloat(i.amount) || 0) * ((parseFloat(i.commission_pct) || 0) / 100);
        rows.push({
          id: 'i' + i.id,
          type: 'additional',
          amount: Math.round(cut * 100) / 100,
          paidAt: i.date,
          source: i.source,
          context: 'Additional income · ' + i.source + (i.description ? ' · ' + i.description : ''),
          additionalIncomeId: i.id
        });
      }
    }

    rows.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt));
    res.json(rows);
  } catch (err) {
    console.error('payments/history error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
