const router = require('express').Router();
const multer = require('multer');
const { requireAdmin } = require('../middleware/auth');
const service = require('../services/royaltyShower');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

// ─── ADMIN: upload a CSV → DB ─────────────────────────
router.post('/ingest', requireAdmin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    if (!['csv', 'tsv', 'txt'].includes(ext)) {
      return res.status(400).json({ error: 'Please upload a CSV file (raw distribution data)' });
    }
    const result = await service.ingestCsv({
      db: req.db,
      filename: req.file.originalname,
      buffer: req.file.buffer,
      uploadedBy: req.session.userId
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('Royalty ingest error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ─── ADMIN: list imports ──────────────────────────────
router.get('/imports', requireAdmin, async (req, res) => {
  try {
    const imports = await req.db('royalty_imports').select('*').orderBy('uploaded_at', 'desc');
    res.json(imports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN: delete an import ──────────────────────────
router.delete('/imports/:id', requireAdmin, async (req, res) => {
  try {
    await req.db('royalty_imports').where({ id: req.params.id }).del();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUBLIC: list all artists ─────────────────────────
router.get('/public/artists', async (req, res) => {
  try {
    const artists = await service.listArtists(req.db);
    res.json(artists);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUBLIC: get artist report ────────────────────────
router.get('/public/:slug/:period?', async (req, res) => {
  try {
    const report = await service.buildReport(req.db, req.params.slug, req.params.period);
    if (!report) return res.status(404).json({ error: 'Artist not found' });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
