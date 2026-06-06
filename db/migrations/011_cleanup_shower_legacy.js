'use strict';
// One-time cleanup of legacy Report Shower data. Runs automatically on deploy.
//
//   A) Collapse collab credits ("Miran Ali, Aziz Waisi") into the primary artist
//      ("Miran Ali") — matches the new ingest behaviour (primary artist only).
//   B) Drop undated rows (period IS NULL/'') for any artist that ALSO has dated
//      rows. These are pre-fix raw re-uploads that duplicate the dated data
//      (e.g. Kamal Fadawi's ~$115.88 undated copy of his ~$115.87 dated set).
//      Artists whose ONLY data is undated are left untouched — we never wipe a
//      whole profile on a heuristic.
//   C) Prune imports left with no rows so the admin list stays honest.
//
// Idempotent: re-running is a no-op. Not reversible (data cleanup).

function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'unknown';
}

exports.up = async function (knex) {
  // ---- A) fold collab credits into the primary artist ----
  const comboRows = await knex('royalty_rows').where('artist_name', 'like', '%,%').select('id', 'artist_name');
  const byPrimary = new Map(); // slug -> { name, ids: [] }
  for (const r of comboRows) {
    const primary = String(r.artist_name).split(',')[0].trim();
    if (!primary) continue;
    const slug = slugify(primary);
    if (!byPrimary.has(slug)) byPrimary.set(slug, { name: primary, ids: [] });
    byPrimary.get(slug).ids.push(r.id);
  }
  for (const [slug, { name, ids }] of byPrimary) {
    for (let i = 0; i < ids.length; i += 500) {
      await knex('royalty_rows').whereIn('id', ids.slice(i, i + 500)).update({ artist_name: name, artist_slug: slug });
    }
    // buildReport requires the slug in artist_slugs — make sure the primary exists
    const exists = await knex('artist_slugs').where({ slug }).first();
    if (!exists) {
      try { await knex('artist_slugs').insert({ slug, artist_name: name }); } catch (_) { /* unique race — ignore */ }
    }
  }
  // remove stale combo entries from the registry so their old URLs 404 cleanly
  await knex('artist_slugs').where('artist_name', 'like', '%,%').del();

  // ---- B) drop undated duplicates, but only where dated coverage exists ----
  const datedSlugs = await knex('royalty_rows')
    .whereNotNull('period').andWhere('period', '<>', '')
    .distinct('artist_slug').pluck('artist_slug');
  if (datedSlugs.length) {
    await knex('royalty_rows')
      .whereIn('artist_slug', datedSlugs)
      .andWhere(function () { this.whereNull('period').orWhere('period', '=', ''); })
      .del();
  }

  // ---- C) prune imports that have no rows left ----
  const liveImportIds = (await knex('royalty_rows').whereNotNull('import_id').distinct('import_id').pluck('import_id'))
    .filter((x) => x !== null && x !== undefined);
  if (liveImportIds.length) {
    await knex('royalty_imports').whereNotIn('id', liveImportIds).del();
  } else {
    await knex('royalty_imports').del();
  }
};

exports.down = async function () {
  // One-time data cleanup — intentionally not reversible.
};
