exports.up = async function(knex) {
  // Add YouTube fields to artists
  const hasYtChannel = await knex.schema.hasColumn('artists', 'youtube_channel_id');
  if (!hasYtChannel) {
    await knex.schema.alterTable('artists', t => {
      t.string('youtube_channel_id');
      t.string('youtube_channel_url');
      t.string('youtube_channel_title');
      t.timestamp('youtube_last_sync');
    });
  }

  // OAuth tokens table (per-artist YouTube authorization)
  const hasTable = await knex.schema.hasTable('youtube_accounts');
  if (!hasTable) {
    await knex.schema.createTable('youtube_accounts', t => {
      t.increments('id').primary();
      t.integer('artist_id').unsigned().references('id').inTable('artists').onDelete('CASCADE');
      t.string('channel_id');
      t.string('channel_title');
      t.text('refresh_token_encrypted');  // encrypted at rest
      t.timestamp('connected_at').defaultTo(knex.fn.now());
      t.timestamp('last_synced_at');
      t.string('sync_status').defaultTo('pending');
      t.text('last_error');
      t.unique('artist_id');
    });
  }

  // Cached channel stats (so we don't hit API on every page load)
  const hasStats = await knex.schema.hasTable('youtube_channel_stats');
  if (!hasStats) {
    await knex.schema.createTable('youtube_channel_stats', t => {
      t.increments('id').primary();
      t.integer('artist_id').unsigned().references('id').inTable('artists').onDelete('CASCADE');
      t.string('channel_id');
      t.bigInteger('subscriber_count').defaultTo(0);
      t.bigInteger('view_count').defaultTo(0);
      t.bigInteger('video_count').defaultTo(0);
      t.string('channel_thumbnail');
      t.text('channel_description');
      t.timestamp('fetched_at').defaultTo(knex.fn.now());
      t.unique('artist_id');
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('youtube_channel_stats');
  await knex.schema.dropTableIfExists('youtube_accounts');
  const hasYtChannel = await knex.schema.hasColumn('artists', 'youtube_channel_id');
  if (hasYtChannel) {
    await knex.schema.alterTable('artists', t => {
      t.dropColumn('youtube_channel_id');
      t.dropColumn('youtube_channel_url');
      t.dropColumn('youtube_channel_title');
      t.dropColumn('youtube_last_sync');
    });
  }
};
