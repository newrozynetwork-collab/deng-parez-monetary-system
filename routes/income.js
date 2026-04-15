const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { start, end } = req.query;
    let query = req.db('additional_income').orderBy('date', 'desc');
    if (start) query = query.where('date', '>=', start);
    if (end) query = query.where('date', '<=', end);
    res.json(await query);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { source, description, amount, commission_pct, commission_to, date } = req.body;
    if (!source || !amount || !date) return res.status(400).json({ error: 'Source, amount, and date required' });
    const inserted = await req.db('additional_income').insert({
      source, description, amount: parseFloat(amount),
      commission_pct: commission_pct || 0, commission_to, date,
      created_by: req.session.userId
    }).returning('id');
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    const incomeId = (first && typeof first === 'object') ? first.id : first;
    res.status(201).json(await req.db('additional_income').where({ id: incomeId }).first());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { source, description, amount, commission_pct, commission_to, date } = req.body;
    await req.db('additional_income').where({ id: req.params.id }).update({
      source, description, amount: parseFloat(amount),
      commission_pct: commission_pct || 0, commission_to, date
    });
    res.json(await req.db('additional_income').where({ id: req.params.id }).first());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await req.db('additional_income').where({ id: req.params.id }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
