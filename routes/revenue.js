const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { calculate } = require('../services/calculator');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { start, end, artist_id } = req.query;
    let query = req.db('revenue_entries')
      .join('artists', 'revenue_entries.artist_id', 'artists.id')
      .select(
        'revenue_entries.*',
        'artists.name as artist_name',
        'artists.nickname as artist_nickname'
      )
      .orderBy('revenue_entries.created_at', 'desc');

    if (start) query = query.where('revenue_entries.period_start', '>=', start);
    if (end) query = query.where('revenue_entries.period_end', '<=', end);
    if (artist_id) query = query.where('revenue_entries.artist_id', artist_id);

    const entries = await query;

    // Attach distributions
    const entryIds = entries.map(e => e.id);
    const distributions = await req.db('revenue_distributions').whereIn('revenue_entry_id', entryIds);
    const distMap = {};
    distributions.forEach(d => {
      if (!distMap[d.revenue_entry_id]) distMap[d.revenue_entry_id] = [];
      distMap[d.revenue_entry_id].push(d);
    });

    entries.forEach(e => {
      const dists = distMap[e.id] || [];
      e.distributions = dists;
      const artistDist = dists.find(d => d.recipient_type === 'artist');
      const companyDist = dists.find(d => d.recipient_type === 'company');
      const referralDists = dists.filter(d => d.recipient_type === 'referral');
      e.artist_share = artistDist ? parseFloat(artistDist.amount) : 0;
      e.company_net = companyDist ? parseFloat(companyDist.amount) : 0;
      e.total_referrals = referralDists.reduce((s, d) => s + parseFloat(d.amount), 0);
    });

    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const entry = await req.db('revenue_entries')
      .join('artists', 'revenue_entries.artist_id', 'artists.id')
      .select('revenue_entries.*', 'artists.name as artist_name')
      .where('revenue_entries.id', req.params.id)
      .first();
    if (!entry) return res.status(404).json({ error: 'Not found' });
    entry.distributions = await req.db('revenue_distributions').where({ revenue_entry_id: entry.id });
    res.json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Preview calculation without saving
router.post('/calculate', requireAuth, async (req, res) => {
  try {
    const { artist_id, amount } = req.body;
    const artist = await req.db('artists').where({ id: artist_id }).first();
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const referrals = await req.db('referral_levels').where({ artist_id }).orderBy('level');
    const result = calculate({
      grossRevenue: parseFloat(amount),
      bankFeePct: parseFloat(artist.bank_fee_pct),
      artistSplitPct: parseFloat(artist.artist_split_pct),
      companySplitPct: parseFloat(artist.company_split_pct),
      referralLevels: referrals.map(r => ({
        level: r.level,
        referrerName: r.referrer_name,
        commissionPct: parseFloat(r.commission_pct)
      }))
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create revenue entry and auto-calculate distributions
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { artist_id, amount, source, period_start, period_end, notes } = req.body;
    if (!artist_id || !amount) return res.status(400).json({ error: 'Artist and amount required' });

    const artist = await req.db('artists').where({ id: artist_id }).first();
    if (!artist) return res.status(404).json({ error: 'Artist not found' });

    const referrals = await req.db('referral_levels').where({ artist_id }).orderBy('level');
    const calc = calculate({
      grossRevenue: parseFloat(amount),
      bankFeePct: parseFloat(artist.bank_fee_pct),
      artistSplitPct: parseFloat(artist.artist_split_pct),
      companySplitPct: parseFloat(artist.company_split_pct),
      referralLevels: referrals.map(r => ({
        level: r.level,
        referrerName: r.referrer_name,
        commissionPct: parseFloat(r.commission_pct)
      }))
    });

    const insertedRev = await req.db('revenue_entries').insert({
      artist_id,
      amount: parseFloat(amount),
      source: source || artist.revenue_type || 'both',
      period_start, period_end, notes,
      created_by: req.session.userId
    }).returning('id');

    const firstRev = Array.isArray(insertedRev) ? insertedRev[0] : insertedRev;
    const id = (firstRev && typeof firstRev === 'object') ? firstRev.id : firstRev;

    // Insert distributions
    const distributions = [
      { revenue_entry_id: id, recipient_type: 'artist', recipient_name: artist.name, amount: calc.artistShare },
      { revenue_entry_id: id, recipient_type: 'company', recipient_name: 'Company', amount: calc.companyNet }
    ];
    calc.referralBreakdown.forEach(r => {
      distributions.push({
        revenue_entry_id: id,
        recipient_type: 'referral',
        recipient_name: r.referrerName,
        amount: r.amount
      });
    });
    // Also store bank fee as a distribution for tracking
    distributions.push({
      revenue_entry_id: id,
      recipient_type: 'bank_fee',
      recipient_name: 'Bank Fee',
      amount: calc.bankFee
    });

    await req.db('revenue_distributions').insert(distributions);

    const entry = await req.db('revenue_entries').where({ id }).first();
    entry.distributions = await req.db('revenue_distributions').where({ revenue_entry_id: id });
    entry.calculation = calc;
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await req.db('revenue_entries').where({ id: req.params.id }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
