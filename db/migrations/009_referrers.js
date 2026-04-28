/**
 * Adds a registry of referrers (people who get paid commission across artists),
 * and links existing referral_levels rows to the new registry by name.
 *
 * - Creates `referrers` table
 * - Backfills it with one row per distinct existing referrer_name
 * - Adds a nullable `referrer_id` FK on referral_levels (referrer_name is kept
 *   for backward compatibility — payment history etc. still aggregate by name).
 */
exports.up = async function (knex) {
  await knex.schema.createTable('referrers', t => {
    t.increments('id').primary();
    t.string('name').notNullable();
    t.string('phone');
    t.string('email');
    t.string('social');           // optional handle / link
    t.text('notes');
    t.boolean('is_active').defaultTo(true).notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.timestamp('updated_at').defaultTo(knex.fn.now());
    t.unique(['name']);           // names are unique in the registry
  });

  // Add referrer_id FK to referral_levels (nullable, kept in sync with name on save)
  await knex.schema.alterTable('referral_levels', t => {
    t.integer('referrer_id')
      .unsigned()
      .references('id')
      .inTable('referrers')
      .onDelete('SET NULL');
  });

  // Backfill: one referrer per distinct name currently used
  const distinct = await knex('referral_levels')
    .distinct('referrer_name')
    .whereNotNull('referrer_name')
    .where('referrer_name', '!=', '');

  for (const row of distinct) {
    const [r] = await knex('referrers')
      .insert({ name: row.referrer_name })
      .onConflict('name')
      .ignore()
      .returning('id');

    // Link existing referral_levels rows by name
    const inserted = r && (typeof r === 'object' ? r.id : r);
    let referrerId = inserted;
    if (!referrerId) {
      const existing = await knex('referrers')
        .where({ name: row.referrer_name })
        .first('id');
      referrerId = existing && existing.id;
    }
    if (referrerId) {
      await knex('referral_levels')
        .where({ referrer_name: row.referrer_name })
        .update({ referrer_id: referrerId });
    }
  }
};

exports.down = async function (knex) {
  await knex.schema.alterTable('referral_levels', t => {
    t.dropColumn('referrer_id');
  });
  await knex.schema.dropTableIfExists('referrers');
};
