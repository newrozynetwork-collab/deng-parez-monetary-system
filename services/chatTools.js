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
