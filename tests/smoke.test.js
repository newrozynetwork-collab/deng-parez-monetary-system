const test = require('node:test');
const assert = require('node:assert/strict');
const { makeTestDb } = require('./setup');

test('smoke: in-memory db boots and has chat_messages table', async () => {
  const db = await makeTestDb();
  const exists = await db.schema.hasTable('chat_messages');
  assert.equal(exists, true);
  await db.destroy();
});
