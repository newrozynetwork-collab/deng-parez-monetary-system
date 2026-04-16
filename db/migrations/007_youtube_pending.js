exports.up = async function(knex) {
  const has = await knex.schema.hasTable('youtube_pending_connections');
  if (!has) {
    await knex.schema.createTable('youtube_pending_connections', t => {
      t.increments('id').primary();
      t.string('channel_id').unique();
      t.string('channel_title');
      t.string('channel_thumbnail');
      t.string('custom_url');
      t.text('refresh_token_encrypted');
      t.bigInteger('subscriber_count').defaultTo(0);
      t.bigInteger('view_count').defaultTo(0);
      t.bigInteger('video_count').defaultTo(0);
      t.timestamp('connected_at').defaultTo(knex.fn.now());
      t.timestamp('matched_at');
      t.integer('matched_artist_id').unsigned().references('id').inTable('artists').onDelete('SET NULL');
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('youtube_pending_connections');
};
