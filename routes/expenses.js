const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { start, end, category } = req.query;
    let query = req.db('expenses').orderBy('date', 'desc');
    if (start) query = query.where('date', '>=', start);
    if (end) query = query.where('date', '<=', end);
    if (category) query = query.where('category', category);
    res.json(await query);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { category, description, amount, date } = req.body;
    if (!category || !amount || !date) return res.status(400).json({ error: 'Category, amount, and date required' });
    const inserted = await req.db('expenses').insert({
      category, description, amount: parseFloat(amount), date, created_by: req.session.userId
    }).returning('id');
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    const expenseId = (first && typeof first === 'object') ? first.id : first;
    res.status(201).json(await req.db('expenses').where({ id: expenseId }).first());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { category, description, amount, date } = req.body;
    await req.db('expenses').where({ id: req.params.id }).update({
      category, description, amount: parseFloat(amount), date
    });
    res.json(await req.db('expenses').where({ id: req.params.id }).first());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    await req.db('expenses').where({ id: req.params.id }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
