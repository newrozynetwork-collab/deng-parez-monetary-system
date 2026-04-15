exports.up = async function(knex) {
  const exists = await knex.schema.hasTable('categories');
  if (!exists) {
    await knex.schema.createTable('categories', t => {
      t.increments('id').primary();
      t.string('name').notNullable();
      t.string('type').notNullable(); // 'expense' or 'income'
      t.string('color').defaultTo('#6b7280'); // hex color for label
      t.string('icon').defaultTo('tag'); // feather icon name
      t.text('description');
      t.integer('sort_order').defaultTo(0);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.unique(['name', 'type']);
    });
  }

  // Add category_id foreign keys
  const hasExpCat = await knex.schema.hasColumn('expenses', 'category_id');
  if (!hasExpCat) {
    await knex.schema.alterTable('expenses', t => {
      t.integer('category_id').unsigned().references('id').inTable('categories').onDelete('SET NULL');
    });
  }

  const hasIncCat = await knex.schema.hasColumn('additional_income', 'category_id');
  if (!hasIncCat) {
    await knex.schema.alterTable('additional_income', t => {
      t.integer('category_id').unsigned().references('id').inTable('categories').onDelete('SET NULL');
    });
  }

  // Seed default categories
  const count = await knex('categories').count('id as count').first();
  if (parseInt(count.count) === 0) {
    await knex('categories').insert([
      // Expense categories
      { name: 'Operations', type: 'expense', color: '#3b82f6', icon: 'settings', sort_order: 1 },
      { name: 'Marketing', type: 'expense', color: '#ec4899', icon: 'megaphone', sort_order: 2 },
      { name: 'Software', type: 'expense', color: '#8b5cf6', icon: 'code', sort_order: 3 },
      { name: 'Equipment', type: 'expense', color: '#f59e0b', icon: 'hard-drive', sort_order: 4 },
      { name: 'Legal', type: 'expense', color: '#6b7280', icon: 'briefcase', sort_order: 5 },
      { name: 'Travel', type: 'expense', color: '#10b981', icon: 'map-pin', sort_order: 6 },
      { name: 'Office', type: 'expense', color: '#06b6d4', icon: 'home', sort_order: 7 },
      { name: 'Salaries', type: 'expense', color: '#ef4444', icon: 'users', sort_order: 8 },
      { name: 'Utilities', type: 'expense', color: '#14b8a6', icon: 'zap', sort_order: 9 },
      { name: 'Other', type: 'expense', color: '#64748b', icon: 'more-horizontal', sort_order: 99 },
      // Income categories
      { name: 'Consulting', type: 'income', color: '#3b82f6', icon: 'briefcase', sort_order: 1 },
      { name: 'Licensing', type: 'income', color: '#10b981', icon: 'award', sort_order: 2 },
      { name: 'Sponsorship', type: 'income', color: '#f59e0b', icon: 'gift', sort_order: 3 },
      { name: 'Royalties', type: 'income', color: '#8b5cf6', icon: 'music', sort_order: 4 },
      { name: 'Investments', type: 'income', color: '#14b8a6', icon: 'trending-up', sort_order: 5 },
      { name: 'Other', type: 'income', color: '#64748b', icon: 'more-horizontal', sort_order: 99 }
    ]);
  }
};

exports.down = async function(knex) {
  const hasIncCat = await knex.schema.hasColumn('additional_income', 'category_id');
  if (hasIncCat) {
    await knex.schema.alterTable('additional_income', t => { t.dropColumn('category_id'); });
  }
  const hasExpCat = await knex.schema.hasColumn('expenses', 'category_id');
  if (hasExpCat) {
    await knex.schema.alterTable('expenses', t => { t.dropColumn('category_id'); });
  }
  await knex.schema.dropTableIfExists('categories');
};
