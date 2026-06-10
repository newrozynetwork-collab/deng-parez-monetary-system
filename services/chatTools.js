const crypto = require('crypto');
const { calculate } = require('./calculator');
const royaltyShower = require('./royaltyShower');

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

// Tokens 2+ chars long. Avoids matching every row on "a", "of", etc.
function _tokenize(s) {
  return String(s).toLowerCase().split(/[\s,;.\-_/]+/).filter(t => t.length >= 2);
}

async function resolveArtist(db, idOrName) {
  if (idOrName === undefined || idOrName === null || idOrName === '') {
    return { error: 'not_found', query: '' };
  }
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const a = await db('artists').where({ id: parseInt(idOrName, 10) }).first();
    return a ? { artist: a } : { error: 'not_found', query: String(idOrName) };
  }
  const q = String(idOrName).trim();
  const qLower = q.toLowerCase();

  // Pass 1: full string substring match.
  let rows = await db('artists')
    .whereRaw('LOWER(name) LIKE ?', [`%${qLower}%`])
    .orWhereRaw('LOWER(COALESCE(nickname, \'\')) LIKE ?', [`%${qLower}%`])
    .orderBy('name');

  // Pass 2: token fallback — split query into words, match if ANY token is in
  // the name or nickname. Catches spelling/transliteration variants (Mahmud /
  // Mahmood), reversed word order, and trailing whitespace cases.
  if (rows.length === 0) {
    const tokens = _tokenize(q);
    if (tokens.length > 0) {
      rows = await db('artists').where(function () {
        const self = this;
        tokens.forEach(t => {
          self.orWhereRaw('LOWER(name) LIKE ?', [`%${t}%`])
              .orWhereRaw('LOWER(COALESCE(nickname, \'\')) LIKE ?', [`%${t}%`]);
        });
      }).orderBy('name');
    }
  }

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
  const qLower = q.toLowerCase();

  let rows = await db('referrers')
    .whereRaw('LOWER(name) LIKE ?', [`%${qLower}%`])
    .orderBy('name');

  if (rows.length === 0) {
    const tokens = _tokenize(q);
    if (tokens.length > 0) {
      rows = await db('referrers').where(function () {
        const self = this;
        tokens.forEach(t => {
          self.orWhereRaw('LOWER(name) LIKE ?', [`%${t}%`]);
        });
      }).orderBy('name');
    }
  }

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

defineTool({
  name: 'record_revenue',
  description: 'Record a revenue entry for an artist. ALWAYS confirms (money in). The confirmation card shows the full calculator preview.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save this revenue entry?',
  parameters: {
    type: 'object',
    required: ['artist', 'amount', 'period_start', 'period_end'],
    properties: {
      artist: { type: 'string' },
      amount: { type: 'number' },
      period_start: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      period_end: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      source: { type: 'string', enum: ['youtube', 'platform', 'both'] },
      notes: { type: 'string' }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveArtist(db, args.artist);
    if (r.error) return { error: r };
    const refs = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    const calc = calculate({
      grossRevenue: parseFloat(args.amount),
      bankFeePct: parseFloat(r.artist.bank_fee_pct),
      artistSplitPct: parseFloat(r.artist.artist_split_pct),
      companySplitPct: parseFloat(r.artist.company_split_pct),
      referralLevels: refs.map(rl => ({ level: rl.level, referrerName: rl.referrer_name, commissionPct: parseFloat(rl.commission_pct) }))
    });
    return { artist_name: r.artist.name, ...calc, period_start: args.period_start, period_end: args.period_end, source: args.source || r.artist.revenue_type || 'both' };
  },
  async execute({ db, session }, args) {
    const r = await resolveArtist(db, args.artist);
    if (r.error) return r;
    const refs = await db('referral_levels').where({ artist_id: r.artist.id }).orderBy('level');
    const calc = calculate({
      grossRevenue: parseFloat(args.amount),
      bankFeePct: parseFloat(r.artist.bank_fee_pct),
      artistSplitPct: parseFloat(r.artist.artist_split_pct),
      companySplitPct: parseFloat(r.artist.company_split_pct),
      referralLevels: refs.map(rl => ({ level: rl.level, referrerName: rl.referrer_name, commissionPct: parseFloat(rl.commission_pct) }))
    });

    const inserted = await db('revenue_entries').insert({
      artist_id: r.artist.id,
      amount: parseFloat(args.amount),
      source: args.source || r.artist.revenue_type || 'both',
      period_start: args.period_start,
      period_end: args.period_end,
      notes: args.notes || null,
      created_by: session && session.userId
    }).returning('id');
    const id = Array.isArray(inserted) ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]) : inserted;

    const distributions = [
      { revenue_entry_id: id, recipient_type: 'artist', recipient_name: r.artist.name, amount: calc.artistShare },
      { revenue_entry_id: id, recipient_type: 'company', recipient_name: 'Company', amount: calc.companyNet }
    ];
    calc.referralBreakdown.forEach(rl => {
      distributions.push({ revenue_entry_id: id, recipient_type: 'referral', recipient_name: rl.referrerName, amount: rl.amount });
    });
    distributions.push({ revenue_entry_id: id, recipient_type: 'bank_fee', recipient_name: 'Bank Fee', amount: calc.bankFee });

    await db('revenue_distributions').insert(distributions);

    return { revenue_entry_id: id, artist_name: r.artist.name, calculation: calc };
  }
});

defineTool({
  name: 'update_artist',
  description: 'Update fields on an existing artist. Confirmation required because splits/fees affect future revenue. If changes include `referrals`, replaces the entire referral chain (matches existing route semantics).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save these artist changes?',
  parameters: {
    type: 'object',
    required: ['id_or_name', 'changes'],
    properties: {
      id_or_name: { type: 'string' },
      changes: {
        type: 'object',
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
          contract_start: { type: 'string' },
          contract_end: { type: 'string' },
          contract_years: { type: 'number' },
          notes: { type: 'string' },
          referrals: {
            type: 'array',
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
      }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return { error: r };
    return { current: r.artist, changes: args.changes };
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return r;
    const changes = args.changes || {};
    const { referrals, ...rawFieldChanges } = changes;
    const ARTIST_FIELDS = ['name', 'nickname', 'revenue_type', 'artist_split_pct', 'company_split_pct', 'bank_fee_pct', 'phone', 'phone2', 'beneficiary', 'contract_start', 'contract_end', 'contract_years', 'notes'];
    const fieldChanges = {};
    for (const k of ARTIST_FIELDS) {
      if (rawFieldChanges[k] !== undefined) fieldChanges[k] = rawFieldChanges[k];
    }
    if (Object.keys(fieldChanges).length > 0) {
      await db('artists').where({ id: r.artist.id }).update(fieldChanges);
    }
    if (Array.isArray(referrals)) {
      await db('referral_levels').where({ artist_id: r.artist.id }).del();
      const inserts = [];
      const autoCreated = [];
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
        inserts.push({
          artist_id: r.artist.id,
          level: ref.level || i + 1,
          referrer_id: row.id,
          referrer_name: refName,
          commission_pct: ref.commission_pct
        });
      }
      if (inserts.length > 0) await db('referral_levels').insert(inserts);
      return { id: r.artist.id, updated: true, referrals_replaced: inserts.length, referrers_auto_created: autoCreated };
    }
    return { id: r.artist.id, updated: true };
  }
});

defineTool({
  name: 'update_referrer',
  description: 'Update a referrer record. A name change cascades to referral_levels.referrer_name for future payouts; historical revenue_distributions rows are NOT rewritten (matches existing route semantics).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save these referrer changes?',
  parameters: {
    type: 'object',
    required: ['id_or_name', 'changes'],
    properties: {
      id_or_name: { type: 'string' },
      changes: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          phone: { type: 'string' },
          email: { type: 'string' },
          social: { type: 'string' },
          notes: { type: 'string' }
        }
      }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return { error: r };
    const c = await db('referral_levels').where({ referrer_id: r.referrer.id }).count('* as count').first();
    return { current: r.referrer, changes: args.changes, cascade_rows: parseInt(c.count, 10) };
  },
  async execute({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return r;
    const REFERRER_FIELDS = ['name', 'phone', 'email', 'social', 'notes'];
    const rawChanges = args.changes || {};
    const changes = {};
    for (const k of REFERRER_FIELDS) {
      if (rawChanges[k] !== undefined) changes[k] = rawChanges[k];
    }
    if (Object.keys(changes).length === 0) return { id: r.referrer.id, updated: false };

    await db('referrers').where({ id: r.referrer.id }).update({ ...changes, updated_at: db.fn.now() });

    if (changes.name && changes.name !== r.referrer.name) {
      await db('referral_levels').where({ referrer_id: r.referrer.id }).update({ referrer_name: changes.name });
    }
    return { id: r.referrer.id, updated: true };
  }
});

defineTool({
  name: 'delete_artist',
  description: 'Delete an artist. Cascades to referral_levels and revenue_entries. Confirmation required.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this artist and ALL related revenue and referrals?',
  parameters: {
    type: 'object',
    required: ['id_or_name'],
    properties: { id_or_name: { type: 'string' } }
  },
  async buildPreview({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return { error: r };
    const revs = await db('revenue_entries').where({ artist_id: r.artist.id }).count('* as c').first();
    const lvls = await db('referral_levels').where({ artist_id: r.artist.id }).count('* as c').first();
    return {
      artist: { id: r.artist.id, name: r.artist.name },
      cascade: {
        revenue_entries: parseInt(revs.c, 10),
        referral_levels: parseInt(lvls.c, 10)
      }
    };
  },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.id_or_name);
    if (r.error) return r;
    await db('artists').where({ id: r.artist.id }).del();
    return { id: r.artist.id, deleted: true };
  }
});

defineTool({
  name: 'delete_referrer',
  description: 'Delete a referrer. Soft-deletes (is_active=false) if any referral_levels reference them; hard-deletes otherwise. Confirmation required.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this referrer?',
  parameters: {
    type: 'object',
    required: ['id_or_name'],
    properties: { id_or_name: { type: 'string' } }
  },
  async buildPreview({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return { error: r };
    const c = await db('referral_levels').where({ referrer_id: r.referrer.id }).count('* as c').first();
    const inUse = parseInt(c.c, 10);
    return { referrer: r.referrer, in_use_on_artists: inUse, mode: inUse > 0 ? 'soft' : 'hard' };
  },
  async execute({ db }, args) {
    const r = await resolveReferrer(db, args.id_or_name);
    if (r.error) return r;
    const c = await db('referral_levels').where({ referrer_id: r.referrer.id }).count('* as c').first();
    if (parseInt(c.c, 10) > 0) {
      await db('referrers').where({ id: r.referrer.id }).update({ is_active: false, updated_at: db.fn.now() });
      return { id: r.referrer.id, deleted: true, soft: true, artists_affected: parseInt(c.c, 10) };
    }
    await db('referrers').where({ id: r.referrer.id }).del();
    return { id: r.referrer.id, deleted: true, soft: false };
  }
});

// ════════════════════════════════════════════════════════════════
// FULL-SYSTEM TOOLS — income, expenses, categories, reports,
// payments, users (read-only), Report Shower, YouTube (server-side)
// ════════════════════════════════════════════════════════════════

const today = () => new Date().toISOString().slice(0, 10);
const num = (v) => Math.round((parseFloat(v) || 0) * 100) / 100;

async function resolveCategory(db, idOrName, type) {
  if (idOrName === undefined || idOrName === null || idOrName === '') {
    return { error: 'not_found', query: '' };
  }
  if (typeof idOrName === 'number' || /^\d+$/.test(String(idOrName))) {
    const c = await db('categories').where({ id: parseInt(idOrName, 10), type }).first();
    return c ? { category: c } : { error: 'not_found', query: String(idOrName) };
  }
  const q = String(idOrName).trim().toLowerCase();
  let rows = await db('categories').where({ type }).whereRaw('LOWER(name) = ?', [q]);
  if (rows.length === 0) rows = await db('categories').where({ type }).whereRaw('LOWER(name) LIKE ?', [`%${q}%`]);
  // Reverse containment: the user's words contain the category name —
  // "others" → "Other", "consulting fees" → "Consulting".
  if (rows.length === 0) rows = await db('categories').where({ type }).whereRaw("? LIKE '%' || LOWER(name) || '%'", [q]);
  if (rows.length === 0) return { error: 'not_found', query: String(idOrName) };
  if (rows.length > 1) return { error: 'ambiguous', candidates: rows.map(r => ({ id: r.id, name: r.name })) };
  return { category: rows[0] };
}

// ─── Additional income ───

defineTool({
  name: 'add_additional_income',
  description: 'Record company additional income (consulting, sponsorship, licensing, other non-artist money). Commission is OFF unless the user explicitly gives a commission percentage and recipient. Date defaults to today.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save this additional income?',
  parameters: {
    type: 'object',
    required: ['amount', 'category'],
    properties: {
      amount: { type: 'number', description: 'Amount in dollars' },
      category: { type: 'string', description: 'Income category name or id (e.g. Others, Consulting). Use list_categories type=income if unsure.' },
      source: { type: 'string', description: 'Short label of where the money came from. Defaults to the category name.' },
      description: { type: 'string' },
      commission_pct: { type: 'number', description: 'ONLY when the user explicitly asks for a commission. Defaults to 0 (no commissions).' },
      commission_to: { type: 'string', description: 'Recipient name for the commission, when commission_pct > 0.' },
      date: { type: 'string', description: 'ISO date YYYY-MM-DD. Defaults to today.' }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveCategory(db, args.category, 'income');
    if (r.error) return { error: r };
    const amount = num(args.amount);
    const pct = num(args.commission_pct || 0);
    return {
      amount,
      category_name: r.category.name,
      source: args.source || args.description || r.category.name,
      description: args.description || null,
      commission_pct: pct,
      commission_to: pct > 0 ? (args.commission_to || null) : null,
      commission_amount: num(amount * pct / 100),
      date: args.date || today()
    };
  },
  async execute({ db, session }, args) {
    const r = await resolveCategory(db, args.category, 'income');
    if (r.error) return r;
    const amount = parseFloat(args.amount);
    if (!isFinite(amount) || amount <= 0) return { error: 'validation', field: 'amount', message: 'amount must be a positive number' };
    const pct = parseFloat(args.commission_pct) || 0;
    const inserted = await db('additional_income').insert({
      source: args.source || args.description || r.category.name,
      category_id: r.category.id,
      description: args.description || null,
      amount,
      commission_pct: pct,
      commission_to: pct > 0 ? (args.commission_to || null) : null,
      date: args.date || today(),
      created_by: session && session.userId
    }).returning('id');
    const id = Array.isArray(inserted) ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]) : inserted;
    return { id, amount: num(amount), category_name: r.category.name, commission_pct: pct, date: args.date || today() };
  }
});

defineTool({
  name: 'list_additional_income',
  description: 'List additional income entries, optionally filtered by date range or category.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'ISO date — entries on/after this' },
      end: { type: 'string', description: 'ISO date — entries on/before this' },
      category: { type: 'string' },
      limit: { type: 'integer', description: 'Default 20' }
    }
  },
  async execute({ db }, args) {
    let q = db('additional_income')
      .leftJoin('categories', 'additional_income.category_id', 'categories.id')
      .select('additional_income.*', 'categories.name as category_name')
      .orderBy('additional_income.date', 'desc')
      .limit(Math.min(Math.max(parseInt(args.limit || 20, 10), 1), 100));
    if (args.start) q = q.where('additional_income.date', '>=', args.start);
    if (args.end) q = q.where('additional_income.date', '<=', args.end);
    if (args.category) {
      const r = await resolveCategory(db, args.category, 'income');
      if (r.error) return r;
      q = q.where('additional_income.category_id', r.category.id);
    }
    const rows = await q;
    return {
      entries: rows.map(r => ({
        id: r.id, amount: num(r.amount), source: r.source, description: r.description,
        category_name: r.category_name, commission_pct: num(r.commission_pct || 0),
        commission_to: r.commission_to, date: r.date
      })),
      total: num(rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0))
    };
  }
});

defineTool({
  name: 'update_additional_income',
  description: 'Update an additional income entry by id (get the id from list_additional_income first).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save these income changes?',
  parameters: {
    type: 'object',
    required: ['id', 'changes'],
    properties: {
      id: { type: 'integer' },
      changes: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          source: { type: 'string' },
          description: { type: 'string' },
          date: { type: 'string' },
          commission_pct: { type: 'number' },
          commission_to: { type: 'string' },
          category: { type: 'string' }
        }
      }
    }
  },
  async buildPreview({ db }, args) {
    const row = await db('additional_income').where({ id: args.id }).first();
    if (!row) return { error: { error: 'not_found', query: String(args.id) } };
    return { current: { id: row.id, amount: num(row.amount), source: row.source, date: row.date }, changes: args.changes };
  },
  async execute({ db }, args) {
    const row = await db('additional_income').where({ id: args.id }).first();
    if (!row) return { error: 'not_found', query: String(args.id) };
    const c = args.changes || {};
    const upd = {};
    for (const k of ['amount', 'source', 'description', 'date', 'commission_pct', 'commission_to']) {
      if (c[k] !== undefined) upd[k] = c[k];
    }
    if (c.category !== undefined) {
      const r = await resolveCategory(db, c.category, 'income');
      if (r.error) return r;
      upd.category_id = r.category.id;
    }
    if (Object.keys(upd).length === 0) return { id: row.id, updated: false };
    await db('additional_income').where({ id: row.id }).update(upd);
    return { id: row.id, updated: true };
  }
});

defineTool({
  name: 'delete_additional_income',
  description: 'Delete an additional income entry by id.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this income entry?',
  parameters: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  async buildPreview({ db }, args) {
    const row = await db('additional_income').where({ id: args.id }).first();
    if (!row) return { error: { error: 'not_found', query: String(args.id) } };
    return { id: row.id, amount: num(row.amount), source: row.source, date: row.date };
  },
  async execute({ db }, args) {
    const n = await db('additional_income').where({ id: args.id }).del();
    return n > 0 ? { id: args.id, deleted: true } : { error: 'not_found', query: String(args.id) };
  }
});

// ─── Expenses ───

defineTool({
  name: 'add_expense',
  description: 'Record a company expense. Date defaults to today. Category must be an existing expense category (use list_categories type=expense if unsure).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save this expense?',
  parameters: {
    type: 'object',
    required: ['amount', 'category'],
    properties: {
      amount: { type: 'number' },
      category: { type: 'string' },
      description: { type: 'string' },
      date: { type: 'string', description: 'ISO date YYYY-MM-DD. Defaults to today.' }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveCategory(db, args.category, 'expense');
    if (r.error) return { error: r };
    return { amount: num(args.amount), category_name: r.category.name, description: args.description || null, date: args.date || today() };
  },
  async execute({ db, session }, args) {
    const r = await resolveCategory(db, args.category, 'expense');
    if (r.error) return r;
    const amount = parseFloat(args.amount);
    if (!isFinite(amount) || amount <= 0) return { error: 'validation', field: 'amount', message: 'amount must be a positive number' };
    const inserted = await db('expenses').insert({
      category: r.category.name,
      category_id: r.category.id,
      description: args.description || null,
      amount,
      date: args.date || today(),
      created_by: session && session.userId
    }).returning('id');
    const id = Array.isArray(inserted) ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]) : inserted;
    return { id, amount: num(amount), category_name: r.category.name, date: args.date || today() };
  }
});

defineTool({
  name: 'list_expenses',
  description: 'List expenses, optionally filtered by date range or category.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'string' }, end: { type: 'string' }, category: { type: 'string' },
      limit: { type: 'integer', description: 'Default 20' }
    }
  },
  async execute({ db }, args) {
    let q = db('expenses')
      .leftJoin('categories', 'expenses.category_id', 'categories.id')
      .select('expenses.*', 'categories.name as category_name')
      .orderBy('expenses.date', 'desc')
      .limit(Math.min(Math.max(parseInt(args.limit || 20, 10), 1), 100));
    if (args.start) q = q.where('expenses.date', '>=', args.start);
    if (args.end) q = q.where('expenses.date', '<=', args.end);
    if (args.category) {
      const r = await resolveCategory(db, args.category, 'expense');
      if (r.error) return r;
      q = q.where('expenses.category_id', r.category.id);
    }
    const rows = await q;
    return {
      entries: rows.map(r => ({
        id: r.id, amount: num(r.amount), category_name: r.category_name || r.category,
        description: r.description, date: r.date
      })),
      total: num(rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0))
    };
  }
});

defineTool({
  name: 'update_expense',
  description: 'Update an expense by id (get the id from list_expenses first).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Save these expense changes?',
  parameters: {
    type: 'object',
    required: ['id', 'changes'],
    properties: {
      id: { type: 'integer' },
      changes: {
        type: 'object',
        properties: {
          amount: { type: 'number' }, description: { type: 'string' },
          date: { type: 'string' }, category: { type: 'string' }
        }
      }
    }
  },
  async buildPreview({ db }, args) {
    const row = await db('expenses').where({ id: args.id }).first();
    if (!row) return { error: { error: 'not_found', query: String(args.id) } };
    return { current: { id: row.id, amount: num(row.amount), category: row.category, date: row.date }, changes: args.changes };
  },
  async execute({ db }, args) {
    const row = await db('expenses').where({ id: args.id }).first();
    if (!row) return { error: 'not_found', query: String(args.id) };
    const c = args.changes || {};
    const upd = {};
    for (const k of ['amount', 'description', 'date']) {
      if (c[k] !== undefined) upd[k] = c[k];
    }
    if (c.category !== undefined) {
      const r = await resolveCategory(db, c.category, 'expense');
      if (r.error) return r;
      upd.category = r.category.name;
      upd.category_id = r.category.id;
    }
    if (Object.keys(upd).length === 0) return { id: row.id, updated: false };
    await db('expenses').where({ id: row.id }).update(upd);
    return { id: row.id, updated: true };
  }
});

defineTool({
  name: 'delete_expense',
  description: 'Delete an expense by id.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this expense?',
  parameters: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  async buildPreview({ db }, args) {
    const row = await db('expenses').where({ id: args.id }).first();
    if (!row) return { error: { error: 'not_found', query: String(args.id) } };
    return { id: row.id, amount: num(row.amount), category: row.category, date: row.date };
  },
  async execute({ db }, args) {
    const n = await db('expenses').where({ id: args.id }).del();
    return n > 0 ? { id: args.id, deleted: true } : { error: 'not_found', query: String(args.id) };
  }
});

// ─── Categories ───

defineTool({
  name: 'list_categories',
  description: 'List expense/income categories. Use before adding income or expenses when the category is unclear.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: { type: { type: 'string', enum: ['expense', 'income'], description: 'Omit for both types' } }
  },
  async execute({ db }, args) {
    let q = db('categories').orderBy(['type', 'sort_order', 'name']);
    if (args.type) q = q.where({ type: args.type });
    const rows = await q;
    return { categories: rows.map(r => ({ id: r.id, name: r.name, type: r.type, color: r.color, description: r.description })) };
  }
});

defineTool({
  name: 'add_category',
  description: 'Create a new expense or income category.',
  safety: 'safe_write',
  parameters: {
    type: 'object',
    required: ['name', 'type'],
    properties: {
      name: { type: 'string' },
      type: { type: 'string', enum: ['expense', 'income'] },
      color: { type: 'string', description: 'Hex color, optional' },
      description: { type: 'string' }
    }
  },
  async execute({ db }, args) {
    const name = String(args.name || '').trim();
    if (!name) return { error: 'validation', field: 'name', message: 'name is required' };
    if (!['expense', 'income'].includes(args.type)) return { error: 'validation', field: 'type', message: 'type must be expense or income' };
    const dup = await db('categories').where({ type: args.type }).whereRaw('LOWER(name) = ?', [name.toLowerCase()]).first();
    if (dup) return { error: 'duplicate', existing: { id: dup.id, name: dup.name } };
    const inserted = await db('categories').insert({
      name, type: args.type, color: args.color || '#e3b458', description: args.description || null
    }).returning('id');
    const id = Array.isArray(inserted) ? (typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]) : inserted;
    return { id, name, type: args.type };
  }
});

defineTool({
  name: 'update_category',
  description: 'Rename or restyle a category. Identify it by name or id plus its type.',
  safety: 'safe_write',
  parameters: {
    type: 'object',
    required: ['id_or_name', 'type', 'changes'],
    properties: {
      id_or_name: { type: 'string' },
      type: { type: 'string', enum: ['expense', 'income'] },
      changes: {
        type: 'object',
        properties: { name: { type: 'string' }, color: { type: 'string' }, description: { type: 'string' } }
      }
    }
  },
  async execute({ db }, args) {
    const r = await resolveCategory(db, args.id_or_name, args.type);
    if (r.error) return r;
    const c = args.changes || {};
    const upd = {};
    for (const k of ['name', 'color', 'description']) {
      if (c[k] !== undefined) upd[k] = c[k];
    }
    if (upd.name) {
      const dup = await db('categories').where({ type: args.type }).whereNot({ id: r.category.id })
        .whereRaw('LOWER(name) = ?', [String(upd.name).toLowerCase()]).first();
      if (dup) return { error: 'duplicate', existing: { id: dup.id, name: dup.name } };
    }
    if (Object.keys(upd).length === 0) return { id: r.category.id, updated: false };
    await db('categories').where({ id: r.category.id }).update(upd);
    // keep the legacy string column on expenses in sync with a rename
    if (upd.name && args.type === 'expense') {
      await db('expenses').where({ category_id: r.category.id }).update({ category: upd.name });
    }
    return { id: r.category.id, updated: true };
  }
});

defineTool({
  name: 'delete_category',
  description: 'Delete a category. Refuses if records use it unless force=true (force unlinks those records, it does NOT delete them).',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this category?',
  parameters: {
    type: 'object',
    required: ['id_or_name', 'type'],
    properties: {
      id_or_name: { type: 'string' },
      type: { type: 'string', enum: ['expense', 'income'] },
      force: { type: 'boolean', description: 'Unlink in-use records and delete anyway' }
    }
  },
  async buildPreview({ db }, args) {
    const r = await resolveCategory(db, args.id_or_name, args.type);
    if (r.error) return { error: r };
    const exp = await db('expenses').where({ category_id: r.category.id }).count('* as c').first();
    const inc = await db('additional_income').where({ category_id: r.category.id }).count('* as c').first();
    return { category: { id: r.category.id, name: r.category.name, type: r.category.type }, in_use: parseInt(exp.c, 10) + parseInt(inc.c, 10), force: !!args.force };
  },
  async execute({ db }, args) {
    const r = await resolveCategory(db, args.id_or_name, args.type);
    if (r.error) return r;
    const exp = await db('expenses').where({ category_id: r.category.id }).count('* as c').first();
    const inc = await db('additional_income').where({ category_id: r.category.id }).count('* as c').first();
    const inUse = parseInt(exp.c, 10) + parseInt(inc.c, 10);
    if (inUse > 0 && !args.force) {
      return { error: 'in_use', records: inUse, message: `Category "${r.category.name}" is used by ${inUse} record(s). Re-run with force=true to unlink them and delete it.` };
    }
    if (inUse > 0) {
      await db('expenses').where({ category_id: r.category.id }).update({ category_id: null });
      await db('additional_income').where({ category_id: r.category.id }).update({ category_id: null });
    }
    await db('categories').where({ id: r.category.id }).del();
    return { id: r.category.id, deleted: true, unlinked_records: inUse };
  }
});

// ─── Revenue delete + financial reports + payments ───

defineTool({
  name: 'delete_revenue_entry',
  description: 'Delete a revenue entry and its distributions. Get the id from list_recent_revenue first.',
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this revenue entry and its payout records?',
  parameters: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
  async buildPreview({ db }, args) {
    const row = await db('revenue_entries')
      .leftJoin('artists', 'revenue_entries.artist_id', 'artists.id')
      .where('revenue_entries.id', args.id)
      .select('revenue_entries.*', 'artists.name as artist_name').first();
    if (!row) return { error: { error: 'not_found', query: String(args.id) } };
    const d = await db('revenue_distributions').where({ revenue_entry_id: args.id }).count('* as c').first();
    return { id: row.id, artist_name: row.artist_name, amount: num(row.amount), period_start: row.period_start, period_end: row.period_end, distributions: parseInt(d.c, 10) };
  },
  async execute({ db }, args) {
    const row = await db('revenue_entries').where({ id: args.id }).first();
    if (!row) return { error: 'not_found', query: String(args.id) };
    await db('revenue_distributions').where({ revenue_entry_id: args.id }).del();
    await db('revenue_entries').where({ id: args.id }).del();
    return { id: args.id, deleted: true };
  }
});

defineTool({
  name: 'get_financial_summary',
  description: 'Company financial summary: total revenue, payouts, fees, expenses, additional income and net profit. Optionally for a date range. Use for "how did we do", "profit this month", etc.',
  safety: 'read',
  parameters: {
    type: 'object',
    properties: {
      start: { type: 'string', description: 'ISO date — include revenue periods / expenses / income from this date' },
      end: { type: 'string', description: 'ISO date — up to this date' }
    }
  },
  async execute({ db }, args) {
    const revQ = db('revenue_entries');
    if (args.start) revQ.where('period_start', '>=', args.start);
    if (args.end) revQ.where('period_start', '<=', args.end);
    const rev = await revQ.clone().sum('amount as s').first();

    const distQ = db('revenue_distributions').join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id');
    if (args.start) distQ.where('revenue_entries.period_start', '>=', args.start);
    if (args.end) distQ.where('revenue_entries.period_start', '<=', args.end);
    const dist = await distQ.select('revenue_distributions.recipient_type').sum('revenue_distributions.amount as s').groupBy('revenue_distributions.recipient_type');
    const by = {};
    dist.forEach(d => { by[d.recipient_type] = parseFloat(d.s) || 0; });

    const expQ = db('expenses');
    if (args.start) expQ.where('date', '>=', args.start);
    if (args.end) expQ.where('date', '<=', args.end);
    const exp = await expQ.sum('amount as s').first();

    const incQ = db('additional_income');
    if (args.start) incQ.where('date', '>=', args.start);
    if (args.end) incQ.where('date', '<=', args.end);
    const inc = await incQ.sum('amount as s').first();

    const companyRevenue = num(by.company || 0);
    const totalExpenses = num(exp.s || 0);
    const totalAdditionalIncome = num(inc.s || 0);
    return {
      start: args.start || null,
      end: args.end || null,
      totalRevenue: num(rev.s || 0),
      totalArtistPayouts: num(by.artist || 0),
      totalReferralPayouts: num(by.referral || 0),
      totalBankFees: num(by.bank_fee || 0),
      companyRevenue,
      totalExpenses,
      totalAdditionalIncome,
      netCompanyProfit: num(companyRevenue + totalAdditionalIncome - totalExpenses)
    };
  }
});

defineTool({
  name: 'get_payments_summary',
  description: 'Who has been paid what: per-recipient totals across artist payouts, referral commissions and additional-income commissions. Use for "who is owed", "payment status".',
  safety: 'read',
  parameters: { type: 'object', properties: {} },
  async execute({ db }) {
    const dist = await db('revenue_distributions')
      .whereIn('recipient_type', ['artist', 'referral'])
      .select('recipient_name', 'recipient_type')
      .sum('amount as total').count('* as n').max('created_at as last')
      .groupBy('recipient_name', 'recipient_type');

    const recipients = dist.map(d => ({
      name: d.recipient_name,
      type: d.recipient_type,
      totalPaid: num(d.total),
      paymentCount: parseInt(d.n, 10),
      lastPaid: d.last
    }));

    const incs = await db('additional_income').whereNotNull('commission_to').where('commission_pct', '>', 0);
    const byName = {};
    incs.forEach(r => {
      const amt = (parseFloat(r.amount) || 0) * (parseFloat(r.commission_pct) || 0) / 100;
      if (!byName[r.commission_to]) byName[r.commission_to] = { total: 0, n: 0, last: null };
      byName[r.commission_to].total += amt;
      byName[r.commission_to].n += 1;
      if (!byName[r.commission_to].last || String(r.date) > String(byName[r.commission_to].last)) byName[r.commission_to].last = r.date;
    });
    Object.entries(byName).forEach(([name, v]) => {
      recipients.push({ name, type: 'additional', totalPaid: num(v.total), paymentCount: v.n, lastPaid: v.last });
    });

    recipients.sort((a, b) => String(a.lastPaid || '') < String(b.lastPaid || '') ? -1 : 1);
    return { recipients };
  }
});

defineTool({
  name: 'get_payment_history',
  description: 'Full payment history for one person (artist, referrer, or commission recipient) by exact name.',
  safety: 'read',
  parameters: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
  async execute({ db }, args) {
    const name = String(args.name || '').trim();
    if (!name) return { error: 'validation', field: 'name', message: 'name is required' };

    const dist = await db('revenue_distributions')
      .join('revenue_entries', 'revenue_distributions.revenue_entry_id', 'revenue_entries.id')
      .leftJoin('artists', 'revenue_entries.artist_id', 'artists.id')
      .whereIn('revenue_distributions.recipient_type', ['artist', 'referral'])
      .whereRaw('LOWER(revenue_distributions.recipient_name) = ?', [name.toLowerCase()])
      .select(
        'revenue_distributions.amount', 'revenue_distributions.recipient_type',
        'revenue_distributions.created_at as paid_at',
        'revenue_entries.period_start', 'revenue_entries.period_end',
        'artists.name as for_artist'
      ).orderBy('revenue_distributions.created_at', 'desc');

    const payments = dist.map(d => ({
      amount: num(d.amount), kind: d.recipient_type, paidAt: d.paid_at,
      period_start: d.period_start, period_end: d.period_end, for_artist: d.for_artist
    }));

    const incs = await db('additional_income')
      .whereRaw('LOWER(COALESCE(commission_to, \'\')) = ?', [name.toLowerCase()])
      .where('commission_pct', '>', 0).orderBy('date', 'desc');
    incs.forEach(r => {
      payments.push({
        amount: num((parseFloat(r.amount) || 0) * (parseFloat(r.commission_pct) || 0) / 100),
        kind: 'additional_commission', paidAt: r.date, context: r.source || r.description
      });
    });

    return { name, payments, totalPaid: num(payments.reduce((s, p) => s + p.amount, 0)) };
  }
});

// ─── Users (READ-ONLY by design) ───
// Account creation, role changes and passwords stay in Settings → User
// Management. Chat arguments are logged to the database, so a password sent
// through chat would be stored in plaintext — never add such a tool.

defineTool({
  name: 'list_users',
  description: 'List system user accounts (read-only). The chat can NOT create, modify or delete accounts — that happens in Settings → User Management.',
  safety: 'read',
  parameters: { type: 'object', properties: {} },
  async execute({ db }) {
    const rows = await db('users').select('id', 'username', 'role', 'name', 'created_at').orderBy('id');
    return { users: rows };
  }
});

// ─── Report Shower ───

async function resolveShowerArtist(db, q) {
  const s = String(q || '').trim().toLowerCase();
  if (!s) return { error: 'not_found', query: '' };
  let rows = await db('artist_slugs').whereRaw('LOWER(slug) = ?', [s]);
  if (rows.length === 0) {
    rows = await db('artist_slugs').where(function () {
      this.whereRaw('LOWER(slug) LIKE ?', [`%${s}%`]).orWhereRaw('LOWER(artist_name) LIKE ?', [`%${s}%`]);
    });
  }
  if (rows.length === 0) return { error: 'not_found', query: String(q) };
  if (rows.length > 1) return { error: 'ambiguous', candidates: rows.map(r => ({ id: r.id, name: r.artist_name })) };
  return { row: rows[0] };
}

defineTool({
  name: 'list_shower_artists',
  description: 'List the artists published in the public Report Shower with their all-time totals. (Uploading new royalty files happens on the /shower/admin page, not in chat.)',
  safety: 'read',
  parameters: { type: 'object', properties: {} },
  async execute({ db }) {
    const rows = await royaltyShower.listArtists(db);
    return {
      artists: rows.map(r => ({
        slug: r.artist_slug || r.slug,
        name: r.artist_name || r.name,
        total_revenue: num(r.total_rev !== undefined ? r.total_rev : r.totalRevenue)
      }))
    };
  }
});

defineTool({
  name: 'get_shower_link',
  description: "Get an artist's permanent public Report Shower link (their full earnings history page).",
  safety: 'read',
  parameters: { type: 'object', required: ['artist'], properties: { artist: { type: 'string', description: 'Artist name or slug' } } },
  async execute({ db }, args) {
    const r = await resolveShowerArtist(db, args.artist);
    if (r.error) return r;
    return { slug: r.row.slug, name: r.row.artist_name, url: `/shower/${r.row.slug}`, note: 'Prefix with the site origin, e.g. https://dp.tt-social.com' };
  }
});

defineTool({
  name: 'delete_shower_artist',
  description: "Delete ALL of an artist's data from the public Report Shower (rows + their public page).",
  safety: 'needs_confirmation',
  confirmationLabel: 'Delete this artist from the Report Shower entirely?',
  parameters: { type: 'object', required: ['artist'], properties: { artist: { type: 'string' } } },
  async buildPreview({ db }, args) {
    const r = await resolveShowerArtist(db, args.artist);
    if (r.error) return { error: r };
    const c = await db('royalty_rows').where({ artist_slug: r.row.slug }).count('* as c').sum('net_revenue as s').first();
    return { slug: r.row.slug, name: r.row.artist_name, rows: parseInt(c.c, 10), total_revenue: num(c.s || 0) };
  },
  async execute({ db }, args) {
    const r = await resolveShowerArtist(db, args.artist);
    if (r.error) return r;
    const res = await royaltyShower.deleteArtist(db, r.row.slug);
    return { slug: r.row.slug, deleted: true, rows_removed: res.deletedRows };
  }
});

// ─── YouTube (server-side; OAuth connect + revenue sync live in the YouTube page) ───

defineTool({
  name: 'youtube_overview',
  description: 'Overview of YouTube channels: linked channels, pending (unmatched) connections, and total synced revenue. (Connecting channels and syncing revenue happen on the YouTube page — OAuth needs a browser.)',
  safety: 'read',
  parameters: { type: 'object', properties: {} },
  async execute({ db }) {
    const linked = await db('youtube_accounts')
      .leftJoin('artists', 'youtube_accounts.artist_id', 'artists.id')
      .select('youtube_accounts.channel_id', 'youtube_accounts.channel_title', 'artists.name as artist_name', 'youtube_accounts.last_synced_at');
    const pending = await db('youtube_pending_connections')
      .select('channel_id', 'channel_title', 'subscriber_count', 'connected_at');
    const rev = await db('youtube_revenue_history')
      .select('channel_id').sum('estimated_revenue as s').groupBy('channel_id');
    const byChannel = {};
    rev.forEach(r => { byChannel[r.channel_id] = num(r.s); });
    return {
      linked_channels: linked,
      pending_channels: pending,
      revenue_by_channel: byChannel,
      total_synced_revenue: num(Object.values(byChannel).reduce((s, v) => s + v, 0))
    };
  }
});

defineTool({
  name: 'youtube_share_link',
  description: "Generate a fresh 30-day YouTube connect link for an artist to authorize their channel themselves. Replaces any previous unused link for that artist.",
  safety: 'safe_write',
  parameters: { type: 'object', required: ['artist'], properties: { artist: { type: 'string', description: 'Artist id or name' } } },
  async execute({ db }, args) {
    const r = await resolveArtist(db, args.artist);
    if (r.error) return r;
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db('youtube_connect_tokens').where({ artist_id: r.artist.id }).whereNull('used_at').del();
    await db('youtube_connect_tokens').insert({ artist_id: r.artist.id, token, expires_at: expiresAt });
    return {
      artist_name: r.artist.name,
      token,
      url_path: `/connect/${token}`,
      expires_at: expiresAt.toISOString(),
      note: 'Prefix with the site origin, e.g. https://dp.tt-social.com/connect/<token>'
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
