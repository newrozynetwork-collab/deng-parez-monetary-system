exports.up = async function(knex) {
  const has = await knex.schema.hasTable('youtube_revenue_history');
  if (!has) {
    await knex.schema.createTable('youtube_revenue_history', t => {
      t.increments('id').primary();
      t.integer('artist_id').unsigned().references('id').inTable('artists').onDelete('CASCADE');
      t.string('channel_id');
      t.string('month'); // YYYY-MM
      t.bigInteger('views').defaultTo(0);
      t.decimal('estimated_revenue', 14, 2).defaultTo(0);
      t.decimal('estimated_ad_revenue', 14, 2).defaultTo(0);
      t.decimal('gross_revenue', 14, 2).defaultTo(0);
      t.decimal('cpm', 10, 2).defaultTo(0);
      t.bigInteger('monetized_playbacks').defaultTo(0);
      t.timestamp('synced_at').defaultTo(knex.fn.now());
      t.unique(['artist_id', 'month']);
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('youtube_revenue_history');
};
