const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

router.get('/', requireAuth, async (req, res) => {
  try {
    const { start, end, category, category_id } = req.query;
    let query = req.db('expenses')
      .leftJoin('categories', 'expenses.category_id', 'categories.id')
      .select(
        'expenses.*',
        'categories.name as category_name',
        'categories.color as category_color',
        'categories.icon as category_icon'
      )
      .orderBy('expenses.date', 'desc');
    if (start) query = query.where('expenses.date', '>=', start);
    if (end) query = query.where('expenses.date', '<=', end);
    if (category) query = query.where('expenses.category', category);
    if (category_id) query = query.where('expenses.category_id', category_id);
    res.json(await query);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { category, category_id, description, amount, date } = req.body;
    if (!amount || !date) return res.status(400).json({ error: 'Amount and date required' });

    // Derive category name from category_id if provided
    let categoryName = category;
    if (category_id && !category) {
      const cat = await req.db('categories').where({ id: category_id }).first();
      if (cat) categoryName = cat.name;
    }
    if (!categoryName) return res.status(400).json({ error: 'Category is required' });

    const inserted = await req.db('expenses').insert({
      category: categoryName,
      category_id: category_id || null,
      description,
      amount: parseFloat(amount),
      date,
      created_by: req.session.userId
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
    const { category, category_id, description, amount, date } = req.body;
    let categoryName = category;
    if (category_id && !category) {
      const cat = await req.db('categories').where({ id: category_id }).first();
      if (cat) categoryName = cat.name;
    }
    await req.db('expenses').where({ id: req.params.id }).update({
      category: categoryName,
      category_id: category_id || null,
      description,
      amount: parseFloat(amount),
      date
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
