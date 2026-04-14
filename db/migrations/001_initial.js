exports.up = function(knex) {
  return knex.schema
    .createTable('users', t => {
      t.increments('id').primary();
      t.string('username').unique().notNullable();
      t.string('password_hash').notNullable();
      t.string('role').defaultTo('viewer'); // admin or viewer
      t.string('name').notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
    })
    .createTable('artists', t => {
      t.increments('id').primary();
      t.string('name').notNullable();
      t.string('nickname');
      t.string('revenue_type').defaultTo('both'); // youtube, platform, both
      t.decimal('artist_split_pct', 5, 2).defaultTo(60);
      t.decimal('company_split_pct', 5, 2).defaultTo(40);
      t.decimal('bank_fee_pct', 5, 2).defaultTo(2.5);
      t.text('notes');
      t.timestamp('created_at').defaultTo(knex.fn.now());
    })
    .createTable('referral_levels', t => {
      t.increments('id').primary();
      t.integer('artist_id').unsigned().references('id').inTable('artists').onDelete('CASCADE');
      t.integer('level').notNullable();
      t.string('referrer_name').notNullable();
      t.decimal('commission_pct', 5, 2).notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
    })
    .createTable('revenue_entries', t => {
      t.increments('id').primary();
      t.integer('artist_id').unsigned().references('id').inTable('artists').onDelete('CASCADE');
      t.decimal('amount', 12, 2).notNullable();
      t.string('source').defaultTo('both'); // youtube, platform, both
      t.date('period_start');
      t.date('period_end');
      t.text('notes');
      t.integer('created_by').unsigned().references('id').inTable('users');
      t.timestamp('created_at').defaultTo(knex.fn.now());
    })
    .createTable('revenue_distributions', t => {
      t.increments('id').primary();
      t.integer('revenue_entry_id').unsigned().references('id').inTable('revenue_entries').onDelete('CASCADE');
      t.string('recipient_type').notNullable(); // artist, company, referral
      t.string('recipient_name').notNullable();
      t.decimal('amount', 12, 2).notNullable();
      t.timestamp('created_at').defaultTo(knex.fn.now());
    })
    .createTable('expenses', t => {
      t.increments('id').primary();
      t.string('category').notNullable();
      t.string('description');
      t.decimal('amount', 12, 2).notNullable();
      t.date('date').notNullable();
      t.integer('created_by').unsigned().references('id').inTable('users');
      t.timestamp('created_at').defaultTo(knex.fn.now());
    })
    .createTable('additional_income', t => {
      t.increments('id').primary();
      t.string('source').notNullable();
      t.string('description');
      t.decimal('amount', 12, 2).notNullable();
      t.decimal('commission_pct', 5, 2).defaultTo(0);
      t.string('commission_to');
      t.date('date').notNullable();
      t.integer('created_by').unsigned().references('id').inTable('users');
      t.timestamp('created_at').defaultTo(knex.fn.now());
    });
};

exports.down = function(knex) {
  return knex.schema
    .dropTableIfExists('additional_income')
    .dropTableIfExists('expenses')
    .dropTableIfExists('revenue_distributions')
    .dropTableIfExists('revenue_entries')
    .dropTableIfExists('referral_levels')
    .dropTableIfExists('artists')
    .dropTableIfExists('users');
};
