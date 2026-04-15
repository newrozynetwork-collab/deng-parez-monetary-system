const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { start, end, category_id } = req.query;
    let query = req.db('additional_income')
      .leftJoin('categories', 'additional_income.category_id', 'categories.id')
      .select(
        'additional_income.*',
        'categories.name as category_name',
        'categories.color as category_color',
        'categories.icon as category_icon'
      )
      .orderBy('additional_income.date', 'desc');
    if (start) query = query.where('additional_income.date', '>=', start);
    if (end) query = query.where('additional_income.date', '<=', end);
    if (category_id) query = query.where('additional_income.category_id', category_id);
    res.json(await query);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { source, category_id, description, amount, commission_pct, commission_to, date } = req.body;
    if (!source || !amount || !date) return res.status(400).json({ error: 'Source, amount, and date required' });
    const inserted = await req.db('additional_income').insert({
      source,
      category_id: category_id || null,
      description,
      amount: parseFloat(amount),
      commission_pct: commission_pct || 0,
      commission_to,
      date,
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
    const { source, category_id, description, amount, commission_pct, commission_to, date } = req.body;
    await req.db('additional_income').where({ id: req.params.id }).update({
      source,
      category_id: category_id || null,
      description,
      amount: parseFloat(amount),
      commission_pct: commission_pct || 0,
      commission_to,
      date
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
