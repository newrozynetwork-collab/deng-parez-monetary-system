const bcrypt = require('bcryptjs');

exports.seed = async function(knex) {
  const hash = await bcrypt.hash('admin123', 10);
  await knex('users').insert([
    { username: 'admin', password_hash: hash, role: 'admin', name: 'Administrator' }
  ]);
};
