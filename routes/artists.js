const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

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

module.exports = router;
