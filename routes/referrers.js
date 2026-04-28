const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

// ─── GET /api/referrers ────────────────────────────────────
// List all referrers with usage counts and total earned (from revenue_distributions).
router.get('/', requireAuth, async (req, res) => {
  try {
    const db = req.db;
    const referrers = await db('referrers')
      .where({ is_active: true })
      .orderBy('name');

    // Count how many artists each referrer is on
    const usage = await db('referral_levels')
      .whereNotNull('referrer_id')
      .groupBy('referrer_id')
      .select('referrer_id')
      .count('* as artist_count');
    const usageMap = {};
    usage.forEach(u => { usageMap[u.referrer_id] = parseInt(u.artist_count, 10); });

    // Total earned per referrer (matched by name in revenue_distributions)
    const earnings = await db('revenue_distributions')
      .where('recipient_type', 'referral')
      .groupBy('recipient_name')
      .select('recipient_name')
      .sum('amount as total_earned');
    const earningsMap = {};
    earnings.forEach(e => { earningsMap[e.recipient_name] = parseFloat(e.total_earned) || 0; });

    referrers.forEach(r => {
      r.artist_count = usageMap[r.id] || 0;
      r.total_earned = earningsMap[r.name] || 0;
    });

    res.json(referrers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/referrers ───────────────────────────────────
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, phone, email, social, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const trimmed = name.trim();

    // If an inactive one with the same name exists, reactivate it instead of failing
    const existing = await req.db('referrers').where({ name: trimmed }).first();
    if (existing) {
      if (existing.is_active) {
        return res.status(400).json({ error: 'A referrer with that name already exists' });
      }
      await req.db('referrers').where({ id: existing.id }).update({
        is_active: true, phone, email, social, notes, updated_at: req.db.fn.now()
      });
      const row = await req.db('referrers').where({ id: existing.id }).first();
      return res.status(201).json(row);
    }

    const inserted = await req.db('referrers').insert({
      name: trimmed, phone: phone || null, email: email || null,
      social: social || null, notes: notes || null
    }).returning('id');
    const id = Array.isArray(inserted)
      ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
      : inserted;
    const row = await req.db('referrers').where({ id }).first();
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUT /api/referrers/:id ─────────────────────────────────
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, phone, email, social, notes } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });

    const oldRow = await req.db('referrers').where({ id: req.params.id }).first();
    if (!oldRow) return res.status(404).json({ error: 'Referrer not found' });

    await req.db('referrers').where({ id: req.params.id }).update({
      name: name.trim(),
      phone: phone || null,
      email: email || null,
      social: social || null,
      notes: notes || null,
      updated_at: req.db.fn.now()
    });

    // If the name changed, sync referrer_name on referral_levels so old aggregates
    // (payments by name, revenue distributions) keep matching going forward.
    if (oldRow.name !== name.trim()) {
      await req.db('referral_levels')
        .where({ referrer_id: req.params.id })
        .update({ referrer_name: name.trim() });
    }

    const row = await req.db('referrers').where({ id: req.params.id }).first();
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── DELETE /api/referrers/:id ──────────────────────────────
// Soft delete (preserves historical referral_levels rows)
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    const row = await req.db('referrers').where({ id: req.params.id }).first();
    if (!row) return res.status(404).json({ error: 'Referrer not found' });

    const inUse = await req.db('referral_levels')
      .where({ referrer_id: req.params.id })
      .count('* as c').first();

    if (parseInt(inUse.c, 10) > 0) {
      // Soft delete so existing artist links still resolve
      await req.db('referrers').where({ id: req.params.id }).update({
        is_active: false, updated_at: req.db.fn.now()
      });
      return res.json({ ok: true, softDeleted: true, artistsAffected: parseInt(inUse.c, 10) });
    }

    await req.db('referrers').where({ id: req.params.id }).del();
    res.json({ ok: true, softDeleted: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
