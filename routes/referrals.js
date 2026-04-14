const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const referrals = await req.db('referral_levels')
      .join('artists', 'referral_levels.artist_id', 'artists.id')
      .select(
        'referral_levels.*',
        'artists.name as artist_name',
        'artists.nickname as artist_nickname'
      )
      .orderBy(['artists.name', 'referral_levels.level']);

    // Calculate total earned per referrer
    const earnings = await req.db('revenue_distributions')
      .where('recipient_type', 'referral')
      .groupBy('recipient_name')
      .select('recipient_name')
      .sum('amount as total_earned');

    const earningsMap = {};
    earnings.forEach(e => { earningsMap[e.recipient_name] = parseFloat(e.total_earned) || 0; });

    referrals.forEach(r => {
      r.total_earned = earningsMap[r.referrer_name] || 0;
    });

    res.json(referrals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get referral tree structure
router.get('/tree', requireAuth, async (req, res) => {
  try {
    const artists = await req.db('artists').orderBy('name');
    const referrals = await req.db('referral_levels').orderBy('level');

    const tree = artists.map(a => ({
      id: a.id,
      name: a.name,
      nickname: a.nickname,
      referrals: referrals.filter(r => r.artist_id === a.id)
    }));

    res.json(tree);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
