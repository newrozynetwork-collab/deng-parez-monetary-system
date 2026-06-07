'use strict';
// Remove artist_slugs entries that no longer have any rows — orphans left behind by
// deleting all of an artist's imports. Fixes empty profiles such as the ghost
// /shower/miran-ali that renders a blank page instead of a 404. Idempotent.

exports.up = async function (knex) {
  const liveSlugs = await knex('royalty_rows').distinct('artist_slug').pluck('artist_slug');
  const q = knex('artist_slugs');
  if (liveSlugs.length) q.whereNotIn('slug', liveSlugs);
  await q.del();
};

exports.down = async function () {
  // data cleanup — not reversible
};
