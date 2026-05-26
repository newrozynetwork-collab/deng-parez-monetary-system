const knex = require('knex');
const path = require('path');

async function makeTestDb() {
  const db = knex({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '..', 'db', 'migrations') }
  });
  await db.migrate.latest();
  return db;
}

async function seedUser(db, { role = 'admin', name = 'Tester' } = {}) {
  const [idObj] = await db('users').insert({
    username: `t_${Math.random().toString(36).slice(2, 8)}`,
    password_hash: 'unused',
    role,
    name
  }).returning('id');
  return typeof idObj === 'object' ? idObj.id : idObj;
}

module.exports = { makeTestDb, seedUser };
