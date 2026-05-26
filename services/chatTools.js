const { calculate } = require('./calculator');

const tools = {};

function defineTool(spec) {
  tools[spec.name] = spec;
}

defineTool({
  name: 'list_artists',
  description: 'Search or list artists. Use this to find an artist by partial name before any other artist-targeted action. Returns matches with id, name, splits, and referral count.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional case-insensitive substring filter on name or nickname. Omit to list all artists.' }
    }
  },
  async execute({ db }, args) {
    const q = (args && args.query) ? String(args.query).trim() : '';
    let query = db('artists')
      .select(
        'artists.id', 'artists.name', 'artists.nickname',
        'artists.artist_split_pct', 'artists.company_split_pct', 'artists.bank_fee_pct',
        'artists.contract_status'
      )
      .leftJoin('referral_levels', 'referral_levels.artist_id', 'artists.id')
      .count('referral_levels.id as referrals_count')
      .groupBy('artists.id', 'artists.name', 'artists.nickname', 'artists.artist_split_pct', 'artists.company_split_pct', 'artists.bank_fee_pct', 'artists.contract_status')
      .orderBy('artists.name');

    if (q) {
      query = query.where(function () {
        this.whereRaw('LOWER(artists.name) LIKE ?', [`%${q.toLowerCase()}%`])
          .orWhereRaw('LOWER(COALESCE(artists.nickname, \'\')) LIKE ?', [`%${q.toLowerCase()}%`]);
      });
    }

    const rows = await query;
    return {
      matches: rows.map(r => ({
        id: r.id,
        name: r.name,
        nickname: r.nickname,
        artist_split_pct: parseFloat(r.artist_split_pct),
        company_split_pct: parseFloat(r.company_split_pct),
        bank_fee_pct: parseFloat(r.bank_fee_pct),
        contract_status: r.contract_status,
        referrals_count: parseInt(r.referrals_count, 10)
      }))
    };
  }
});

defineTool({
  name: 'get_artist',
  description: 'Get a single artist with their full referral chain. Use after list_artists when the user has picked one.',
  safety: 'read',
  parameters: {
    type: 'object',
    required: ['id_or_name'],
    properties: {
      id_or_name: { type: 'string', description: 'Artist id (numeric string) or name (exact or fuzzy).' }
    }
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return r;
    const referrals = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    return {
      id: r.artist.id,
      name: r.artist.name,
      nickname: r.artist.nickname,
      artist_split_pct: parseFloat(r.artist.artist_split_pct),
      company_split_pct: parseFloat(r.artist.company_split_pct),
      bank_fee_pct: parseFloat(r.artist.bank_fee_pct),
      contract_status: r.artist.contract_status,
      referrals: referrals.map(rl => ({
        level: rl.level,
        referrer_id: rl.referrer_id,
        referrer_name: rl.referrer_name,
        commission_pct: parseFloat(rl.commission_pct)
      }))
    };
  }
});

defineTool({
  name: 'list_referrers',
  description: 'Search or list referrers from the registry.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      include_inactive: { type: 'boolean' }
    }
  },
  async execute({ db }, args) {
    let q = db('referrers').orderBy('name');
    if (!args.include_inactive) q = q.where({ is_active: true });
    if (args.query) {
      const t = String(args.query).trim().toLowerCase();
      q = q.whereRaw('LOWER(name) LIKE ?', [`%${t}%`]);
    }
    const rows = await q;
    return { matches: rows.map(r => ({ id: r.id, name: r.name, phone: r.phone, email: r.email, is_active: !!r.is_active })) };
  }
});

defineTool({
  name: 'list_recent_revenue',
  description: 'List recent revenue entries. Optionally filter by artist or by date.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      artist: { type: 'string', description: 'Artist id or name to filter by' },
      limit: { type: 'integer', description: 'Max rows to return (default 10)' },
      since: { type: 'string', description: 'ISO date — only entries with period_start >= this' }
    }
  },
  async execute({ db }, args) {
    const limit = Math.min(Math.max(parseInt(args.limit || 10, 10), 1), 100);
    let q = db('revenue_entries')
      .join('artists', 'revenue_entries.artist_id', 'artists.id')
      .select(
        'revenue_entries.id',
        'artists.name as artist_name',
        'revenue_entries.amount',
        'revenue_entries.source',
        'revenue_entries.period_start',
        'revenue_entries.period_end',
        'revenue_entries.created_at'
      )
      .orderBy('revenue_entries.created_at', 'desc')
      .limit(limit);

    if (args.artist) {
      const r = await resolveArtist(db, args.artist);
      if (r.error) return r;
      q = q.where('revenue_entries.artist_id', r.artist.id);
    }
    if (args.since) q = q.where('revenue_entries.period_start', '>=', args.since);

    const rows = await q;
    return {
      entries: rows.map(r => ({
        id: r.id,
        artist_name: r.artist_name,
        amount: parseFloat(r.amount),
        source: r.source,
        period_start: r.period_start,
        period_end: r.period_end,
        created_at: r.created_at
      }))
    };
  }
});

defineTool({
  name: 'preview_revenue_split',
  description: 'Compute the revenue split for an artist and a gross amount, without saving. Use whenever the user wants to see what a recorded amount would distribute as.',
  safety: 'read',
  parameters: {
    type: 'object',
    required: ['artist', 'amount'],
    properties: {
      artist: { type: 'string', description: 'Artist id or name' },
      amount: { type: 'number', description: 'Gross revenue amount in dollars' }
    }
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.artist);
    if (r.error) return r;
    const amount = parseFloat(args.amount);
    if (!isFinite(amount) || amount < 0) return { error: 'validation', field: 'amount', message: 'amount must be a non-negative number' };

    const refs = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    const result = calculate({
      grossRevenue: amount,
      bankFeePct: parseFloat(r.artist.bank_fee_pct),
      artistSplitPct: parseFloat(r.artist.artist_split_pct),
      companySplitPct: parseFloat(r.artist.company_split_pct),
      referralLevels: refs.map(rl => ({
        level: rl.level,
        referrerName: rl.referrer_name,
        commissionPct: parseFloat(rl.commission_pct)
      }))
    });
    return { artist_id: r.artist.id, artist_name: r.artist.name, ...result };
  }
});

async function resolveArtist(db, idOrName) {
  if (idOrName === undefined || idOrName === null || idOrName === '') {
    return { error: 'not_found', query: '' };
  }
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const a = await db('artists').where({ id: parseInt(idOrName, 10) }).first();
    return a ? { artist: a } : { error: 'not_found', query: String(idOrName) };
  }
  const q = String(idOrName).trim();
  const rows = await db('artists')
    .whereRaw('LOWER(name) LIKE ?', [`%${q.toLowerCase()}%`])
    .orWhereRaw('LOWER(COALESCE(nickname, \'\')) LIKE ?', [`%${q.toLowerCase()}%`])
    .orderBy('name');
  if (rows.length === 0) return { error: 'not_found', query: q };
  if (rows.length > 1) return { error: 'ambiguous', candidates: rows.map(r => ({ id: r.id, name: r.name })) };
  return { artist: rows[0] };
}

async function resolveReferrer(db, idOrName) {
  if (idOrName === undefined || idOrName === null || idOrName === '') {
    return { error: 'not_found', query: '' };
  }
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const r = await db('referrers').where({ id: parseInt(idOrName, 10) }).first();
    return r ? { referrer: r } : { error: 'not_found', query: String(idOrName) };
  }
  const q = String(idOrName).trim();
  const rows = await db('referrers')
    .whereRaw('LOWER(name) LIKE ?', [`%${q.toLowerCase()}%`])
    .orderBy('name');
  if (rows.length === 0) return { error: 'not_found', query: q };
  if (rows.length > 1) return { error: 'ambiguous', candidates: rows.map(r => ({ id: r.id, name: r.name })) };
  return { referrer: rows[0] };
}

function getTool(name) { return tools[name]; }
function listTools() {
  return Object.values(tools).map(t => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    safety: t.safety
  }));
}

module.exports = { getTool, listTools, _tools: tools };
