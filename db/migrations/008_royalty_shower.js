exports.up = function(knex) {
  return knex.schema
    .createTable('royalty_imports', t => {
      t.increments('id').primary();
      t.string('filename').notNullable();
      t.string('period_start', 7);   // yyyy-mm
      t.string('period_end', 7);     // yyyy-mm
      t.integer('row_count').defaultTo(0);
      t.decimal('total_revenue', 14, 4).defaultTo(0);
      t.integer('uploaded_by').unsigned().references('id').inTable('users');
      t.timestamp('uploaded_at').defaultTo(knex.fn.now());
    })
    .createTable('artist_slugs', t => {
      t.increments('id').primary();
      t.string('slug').unique().notNullable();
      t.string('artist_name').unique().notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index('slug');
    })
    .createTable('royalty_rows', t => {
      t.increments('id').primary();
      t.integer('import_id').unsigned().references('id').inTable('royalty_imports').onDelete('CASCADE');
      t.string('artist_slug').notNullable();
      t.string('artist_name').notNullable();
      t.string('track');
      t.string('store');
      t.string('country');
      t.string('period', 7);  // yyyy-mm
      t.string('transaction_type');
      t.integer('quantity').defaultTo(0);
      t.decimal('net_revenue', 14, 6).defaultTo(0);
      t.index(['artist_slug', 'period']);
      t.index('artist_slug');
      t.index('period');
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('royalty_rows')
    .dropTableIfExists('artist_slugs')
    .dropTableIfExists('royalty_imports');
};
