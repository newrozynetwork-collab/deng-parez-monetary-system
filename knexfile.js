require('dotenv').config();
const path = require('path');

const commonConfig = {
  migrations: { directory: path.join(__dirname, 'db', 'migrations') },
  seeds: { directory: path.join(__dirname, 'db', 'seeds') }
};

module.exports = process.env.DATABASE_URL
  ? {
      client: 'pg',
      connection: { connectionString: process.env.DATABASE_URL, ssl: false },
      ...commonConfig
    }
  : {
      client: 'sqlite3',
      connection: { filename: path.join(__dirname, 'data', 'database.sqlite') },
      useNullAsDefault: true,
      ...commonConfig
    };
