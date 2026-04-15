const router = require('express').Router();
const { requireAuth, requireAdmin } = require('../middleware/auth');

// List categories (optional filter by type)
router.get('/', requireAuth, async (req, res) => {
  try {
    let q = req.db('categories');
    if (req.query.type) q = q.where('type', req.query.type);
    const categories = await q.orderBy(['sort_order', 'name']);

    // Attach usage counts
    const ids = categories.map(c => c.id);
    if (ids.length > 0) {
      const expCounts = await req.db('expenses').whereIn('category_id', ids)
        .groupBy('category_id').select('category_id').count('id as count');
      const incCounts = await req.db('additional_income').whereIn('category_id', ids)
        .groupBy('category_id').select('category_id').count('id as count');
      const expSums = await req.db('expenses').whereIn('category_id', ids)
        .groupBy('category_id').select('category_id').sum('amount as total');
      const incSums = await req.db('additional_income').whereIn('category_id', ids)
        .groupBy('category_id').select('category_id').sum('amount as total');

      const countMap = {};
      const sumMap = {};
      expCounts.forEach(r => { countMap[r.category_id] = parseInt(r.count); });
      incCounts.forEach(r => { countMap[r.category_id] = parseInt(r.count); });
      expSums.forEach(r => { sumMap[r.category_id] = parseFloat(r.total); });
      incSums.forEach(r => { sumMap[r.category_id] = parseFloat(r.total); });

      categories.forEach(c => {
        c.usage_count = countMap[c.id] || 0;
        c.total_amount = sumMap[c.id] || 0;
      });
    }

    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const cat = await req.db('categories').where({ id: req.params.id }).first();
    if (!cat) return res.status(404).json({ error: 'Category not found' });
    res.json(cat);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { name, type, color, icon, description, sort_order } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'Name and type required' });
    if (!['expense', 'income'].includes(type)) return res.status(400).json({ error: 'Type must be expense or income' });

    const exists = await req.db('categories').where({ name: name.trim(), type }).first();
    if (exists) return res.status(409).json({ error: 'A category with this name already exists for this type' });

    const inserted = await req.db('categories').insert({
      name: name.trim(),
      type,
      color: color || '#6b7280',
      icon: icon || 'tag',
      description: description || null,
      sort_order: sort_order || 0
    }).returning('id');
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    const id = (first && typeof first === 'object') ? first.id : first;

    res.status(201).json(await req.db('categories').where({ id }).first());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { name, color, icon, description, sort_order } = req.body;
    const update = {};
    if (name !== undefined) update.name = name.trim();
    if (color !== undefined) update.color = color;
    if (icon !== undefined) update.icon = icon;
    if (description !== undefined) update.description = description;
    if (sort_order !== undefined) update.sort_order = sort_order;
    await req.db('categories').where({ id: req.params.id }).update(update);
    res.json(await req.db('categories').where({ id: req.params.id }).first());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    // Check if category is in use
    const expCount = await req.db('expenses').where({ category_id: req.params.id }).count('id as count').first();
    const incCount = await req.db('additional_income').where({ category_id: req.params.id }).count('id as count').first();
    const total = (parseInt(expCount.count) || 0) + (parseInt(incCount.count) || 0);
    if (total > 0 && !req.query.force) {
      return res.status(409).json({
        error: `Category is used by ${total} record(s). Pass ?force=1 to unlink and delete.`,
        usage: total
      });
    }
    await req.db('categories').where({ id: req.params.id }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
