exports.up = async function(knex) {
  const hasPhone = await knex.schema.hasColumn('artists', 'phone');
  if (!hasPhone) {
    await knex.schema.alterTable('artists', t => {
      t.string('phone');
      t.string('phone2');
      t.string('beneficiary');
      t.date('contract_start');
      t.date('contract_end');
      t.integer('contract_years');
      t.string('contract_status').defaultTo('Active');
    });
  }
};

exports.down = async function(knex) {
  const hasPhone = await knex.schema.hasColumn('artists', 'phone');
  if (hasPhone) {
    await knex.schema.alterTable('artists', t => {
      t.dropColumn('phone');
      t.dropColumn('phone2');
      t.dropColumn('beneficiary');
      t.dropColumn('contract_start');
      t.dropColumn('contract_end');
      t.dropColumn('contract_years');
      t.dropColumn('contract_status');
    });
  }
};
