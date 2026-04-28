const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { exportArtistsToExcel, exportArtistsToCSV } = require('../services/exporter');

router.get('/', requireAuth, async (req, res) => {
  try {
    const artists = await req.db('artists').orderBy('name');
    // Attach referral levels for each artist
    const artistIds = artists.map(a => a.id);
    const referrals = await req.db('referral_levels').whereIn('artist_id', artistIds).orderBy('level');
    const referralMap = {};
    referrals.forEach(r => {
      if (!referralMap[r.artist_id]) referralMap[r.artist_id] = [];
      referralMap[r.artist_id].push(r);
    });
    artists.forEach(a => { a.referrals = referralMap[a.id] || []; });
    res.json(artists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const artist = await req.db('artists').where({ id: req.params.id }).first();
    if (!artist) return res.status(404).json({ error: 'Artist not found' });
    artist.referrals = await req.db('referral_levels').where({ artist_id: artist.id }).orderBy('level');
    res.json(artist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, nickname, revenue_type, artist_split_pct, company_split_pct, bank_fee_pct, notes, referrals } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });

    const inserted = await req.db('artists').insert({
      name, nickname, revenue_type,
      artist_split_pct: artist_split_pct || 60,
      company_split_pct: company_split_pct || 40,
      bank_fee_pct: bank_fee_pct || 2.5,
      notes
    }).returning('id');

    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    const artistId = (first && typeof first === 'object') ? first.id : first;

    if (referrals && referrals.length > 0) {
      const refs = referrals.map((r, i) => ({
        artist_id: artistId,
        level: r.level || i + 1,
        referrer_id: r.referrer_id || null,
        referrer_name: r.referrer_name,
        commission_pct: r.commission_pct
      }));
      await req.db('referral_levels').insert(refs);
    }

    const artist = await req.db('artists').where({ id: artistId }).first();
    artist.referrals = await req.db('referral_levels').where({ artist_id: artistId }).orderBy('level');
    res.status(201).json(artist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, nickname, revenue_type, artist_split_pct, company_split_pct, bank_fee_pct, notes, referrals } = req.body;
    await req.db('artists').where({ id: req.params.id }).update({
      name, nickname, revenue_type, artist_split_pct, company_split_pct, bank_fee_pct, notes
    });

    // Replace referral levels
    if (referrals !== undefined) {
      await req.db('referral_levels').where({ artist_id: req.params.id }).del();
      if (referrals && referrals.length > 0) {
        const refs = referrals.map((r, i) => ({
          artist_id: parseInt(req.params.id),
          level: r.level || i + 1,
          referrer_id: r.referrer_id || null,
          referrer_name: r.referrer_name,
          commission_pct: r.commission_pct
        }));
        await req.db('referral_levels').insert(refs);
      }
    }

    const artist = await req.db('artists').where({ id: req.params.id }).first();
    artist.referrals = await req.db('referral_levels').where({ artist_id: req.params.id }).orderBy('level');
    res.json(artist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await req.db('artists').where({ id: req.params.id }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Export artists (format=xlsx|csv)
router.get('/export/download', requireAuth, async (req, res) => {
  try {
    const format = (req.query.format || 'xlsx').toLowerCase();
    const artists = await req.db('artists').orderBy('name');
    const artistIds = artists.map(a => a.id);

    // Attach referrals
    const referrals = await req.db('referral_levels').whereIn('artist_id', artistIds).orderBy('level');
    const refMap = {};
    referrals.forEach(r => {
      if (!refMap[r.artist_id]) refMap[r.artist_id] = [];
      refMap[r.artist_id].push(r);
    });

    // Compute total revenue per artist
    const revTotals = await req.db('revenue_entries')
      .whereIn('artist_id', artistIds)
      .groupBy('artist_id')
      .select('artist_id')
      .sum('amount as total');
    const revMap = {};
    revTotals.forEach(r => { revMap[r.artist_id] = parseFloat(r.total) || 0; });

    // Compute total earned per artist (from distributions)
    const earnTotals = await req.db('revenue_distributions')
      .join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id')
      .where('revenue_distributions.recipient_type', 'artist')
      .whereIn('revenue_entries.artist_id', artistIds)
      .groupBy('revenue_entries.artist_id')
      .select('revenue_entries.artist_id')
      .sum('revenue_distributions.amount as total');
    const earnMap = {};
    earnTotals.forEach(r => { earnMap[r.artist_id] = parseFloat(r.total) || 0; });

    artists.forEach(a => {
      a.referrals = refMap[a.id] || [];
      a.total_revenue = revMap[a.id] || 0;
      a.total_earned = earnMap[a.id] || 0;
    });

    if (format === 'csv') {
      return exportArtistsToCSV(artists, res);
    }
    return await exportArtistsToExcel(artists, res);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
