exports.up = async function(knex) {
  const has = await knex.schema.hasTable('youtube_connect_tokens');
  if (!has) {
    await knex.schema.createTable('youtube_connect_tokens', t => {
      t.increments('id').primary();
      t.integer('artist_id').unsigned().references('id').inTable('artists').onDelete('CASCADE');
      t.string('token').unique().notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.timestamp('expires_at');
      t.timestamp('used_at');
      t.string('used_channel_id');
      t.index('token');
    });
  }
};

exports.down = async function(knex) {
  await knex.schema.dropTableIfExists('youtube_connect_tokens');
};
