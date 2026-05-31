exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('chat_messages'))) {
    await knex.schema.createTable('chat_messages', (t) => {
      t.increments('id').primary();
      t.integer('user_id').references('id').inTable('users').onDelete('CASCADE');
      t.string('session_key', 64);
      t.string('role', 16).notNullable();
      t.text('content');
      t.string('tool_name', 64);
      t.json('tool_args');
      t.json('tool_result');
      t.string('status', 16);
      t.timestamp('created_at').defaultTo(knex.fn.now());
      t.index(['user_id', 'created_at']);
      t.index(['session_key']);
    });
  }
};

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('chat_messages');
};
