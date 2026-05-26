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

defineTool({
  name: 'add_referrer',
  description: 'Create a referrer in the registry. If an inactive referrer with the same name exists, reactivate it. If an active one exists, return the existing record (idempotent).',
  safety: 'safe_write',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      phone: { type: 'string' },
      email: { type: 'string' },
      social: { type: 'string' },
      notes: { type: 'string' }
    }
  },
  async execute({ db }, args) {
    const name = String(args.name || '').trim();
    if (!name) return { error: 'validation', field: 'name', message: 'name is required' };

    const existing = await db('referrers').where({ name }).first();
    if (existing) {
      if (existing.is_active) {
        return { id: existing.id, name: existing.name, reactivated: false, already_existed: true };
      }
      await db('referrers').where({ id: existing.id }).update({
        is_active: true,
        phone: args.phone || existing.phone,
        email: args.email || existing.email,
        social: args.social || existing.social,
        notes: args.notes || existing.notes,
        updated_at: db.fn.now()
      });
      return { id: existing.id, name: existing.name, reactivated: true, already_existed: false };
    }

    const inserted = await db('referrers').insert({
      name,
      phone: args.phone || null,
      email: args.email || null,
      social: args.social || null,
      notes: args.notes || null
    }).returning('id');
    const id = Array.isArray(inserted)
      ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
      : inserted;
    return { id, name, reactivated: false, already_existed: false };
  }
});

defineTool({
  name: 'add_artist',
  description: 'Create a new artist record, optionally with a referral chain. If any referral.referrer_name is not yet in the registry, this tool creates the referrer first and reports it via referrers_auto_created. The assistant MUST disclose any auto-created referrers in its reply.',
  safety: 'safe_write',
  parameters: {
    type: 'object',
    required: ['name'],
    properties: {
      name: { type: 'string' },
      nickname: { type: 'string' },
      revenue_type: { type: 'string', enum: ['youtube', 'platform', 'both'] },
      artist_split_pct: { type: 'number' },
      company_split_pct: { type: 'number' },
      bank_fee_pct: { type: 'number' },
      phone: { type: 'string' },
      phone2: { type: 'string' },
      beneficiary: { type: 'string' },
      contract_start: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      contract_end: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      contract_years: { type: 'number' },
      notes: { type: 'string' },
      referrals: {
        type: 'array',
        description: 'Ordered referral chain. Each item gets a level (1, 2, 3...) automatically if not provided.',
        items: {
          type: 'object',
          required: ['referrer_name', 'commission_pct'],
          properties: {
            level: { type: 'integer' },
            referrer_name: { type: 'string' },
            commission_pct: { type: 'number' }
          }
        }
      }
    }
  },
  async execute({ db }, args) {
    const name = String(args.name || '').trim();
    if (!name) return { error: 'validation', field: 'name', message: 'name is required' };

    const inserted = await db('artists').insert({
      name,
      nickname: args.nickname || null,
      revenue_type: args.revenue_type || 'both',
      artist_split_pct: (args.artist_split_pct !== undefined) ? args.artist_split_pct : 60,
      company_split_pct: (args.company_split_pct !== undefined) ? args.company_split_pct : 40,
      bank_fee_pct: (args.bank_fee_pct !== undefined) ? args.bank_fee_pct : 2.5,
      phone: args.phone || null,
      phone2: args.phone2 || null,
      beneficiary: args.beneficiary || null,
      contract_start: args.contract_start || null,
      contract_end: args.contract_end || null,
      contract_years: args.contract_years || null,
      notes: args.notes || null
    }).returning('id');
    const artistId = Array.isArray(inserted)
      ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0])
      : inserted;

    const autoCreated = [];
    const referralsToInsert = [];
    const referrals = Array.isArray(args.referrals) ? args.referrals : [];

    for (let i = 0; i < referrals.length; i++) {
      const ref = referrals[i];
      const refName = String(ref.referrer_name || '').trim();
      if (!refName) continue;

      let row = await db('referrers').where({ name: refName }).first();
      if (!row) {
        const ins = await db('referrers').insert({ name: refName }).returning('id');
        const newId = Array.isArray(ins) ? (typeof ins[0] === 'object' ? ins[0].id : ins[0]) : ins;
        row = { id: newId, name: refName };
        autoCreated.push(refName);
      } else if (!row.is_active) {
        await db('referrers').where({ id: row.id }).update({ is_active: true, updated_at: db.fn.now() });
      }

      referralsToInsert.push({
        artist_id: artistId,
        level: ref.level || i + 1,
        referrer_id: row.id,
        referrer_name: refName,
        commission_pct: ref.commission_pct
      });
    }

    if (referralsToInsert.length > 0) {
      await db('referral_levels').insert(referralsToInsert);
    }

    return {
      id: artistId,
      name,
      referrals_created: referralsToInsert.length,
      referrers_auto_created: autoCreated
    };
  }
});

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
