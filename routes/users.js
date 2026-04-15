const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware/auth');

router.get('/', requireAdmin, async (req, res) => {
  try {
    const users = await req.db('users').select('id', 'username', 'role', 'name', 'created_at').orderBy('name');
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, name } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Username, password, and name required' });

    const exists = await req.db('users').where({ username }).first();
    if (exists) return res.status(409).json({ error: 'Username already exists' });

    const hash = await bcrypt.hash(password, 10);
    const inserted = await req.db('users').insert({
      username, password_hash: hash, role: role || 'viewer', name
    }).returning('id');
    const first = Array.isArray(inserted) ? inserted[0] : inserted;
    const userId = (first && typeof first === 'object') ? first.id : first;
    const user = await req.db('users').select('id', 'username', 'role', 'name', 'created_at').where({ id: userId }).first();
    res.status(201).json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const { username, password, role, name } = req.body;
    const update = {};
    if (username) update.username = username;
    if (role) update.role = role;
    if (name) update.name = name;
    if (password) update.password_hash = await bcrypt.hash(password, 10);
    await req.db('users').where({ id: req.params.id }).update(update);
    const user = await req.db('users').select('id', 'username', 'role', 'name', 'created_at').where({ id: req.params.id }).first();
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    if (parseInt(req.params.id) === req.session.userId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    await req.db('users').where({ id: req.params.id }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
