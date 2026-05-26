const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const chatTools = require('../services/chatTools');
const gemini = require('../services/gemini');

const SYSTEM_PROMPT = `You are the chat assistant for the Deng Parez music label monetary system.
Be terse and precise. Help the admin add, update, query, and record records.

Rules:
- Always resolve names via list_artists or list_referrers before any artist- or referrer-targeted action.
- Never guess between candidates. If a lookup returns multiple matches, ask which one.
- When a tool auto-creates side effects (e.g. add_artist creating a new referrer), disclose it in your reply.
- For revenue: call preview_revenue_split first if the user only gives an amount, so they can see the breakdown.
- Keep replies short. The UI shows tool results separately — don't restate raw numbers when a card will render them.`;

function pickSessionKey(req) {
  return req.sessionID ? String(req.sessionID).slice(0, 64) : 'unknown';
}

async function logMessage(db, fields) {
  await db('chat_messages').insert(fields);
}

router.post('/', requireAdmin, async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array required' });
    }

    const sessionKey = pickSessionKey(req);
    const last = messages[messages.length - 1];
    if (last.role === 'user') {
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'user',
        content: String(last.content || '')
      });
    }

    const toolDefs = chatTools.listTools();
    const truncated = messages.slice(-40);

    const first = await gemini.callModel({
      systemPrompt: SYSTEM_PROMPT,
      tools: toolDefs,
      messages: truncated
    });

    if (first.kind === 'text') {
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'assistant',
        content: first.text
      });
      return res.json({ reply: first.text, actions: [] });
    }

    const tool = chatTools.getTool(first.toolName);
    if (!tool) {
      const msg = `I tried to use an unknown tool: ${first.toolName}`;
      await logMessage(req.db, { user_id: req.session.userId, session_key: sessionKey, role: 'assistant', content: msg });
      return res.json({ reply: msg, actions: [] });
    }

    if (tool.safety === 'needs_confirmation') {
      let preview = null;
      if (typeof tool.buildPreview === 'function') {
        try { preview = await tool.buildPreview({ db: req.db }, first.toolArgs); } catch (_) { /* preview optional */ }
      }

      const insertedPending = await req.db('chat_messages').insert({
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'tool',
        tool_name: first.toolName,
        tool_args: JSON.stringify(first.toolArgs),
        status: 'pending_confirm'
      }).returning('id');
      const pendingId = Array.isArray(insertedPending)
        ? (typeof insertedPending[0] === 'object' ? insertedPending[0].id : insertedPending[0])
        : insertedPending;

      const replyText = `Please confirm: ${tool.confirmationLabel || first.toolName}`;
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'assistant',
        content: replyText
      });

      return res.json({
        reply: replyText,
        actions: [{
          type: 'confirm',
          pending_id: pendingId,
          tool: first.toolName,
          safety: tool.safety,
          args: first.toolArgs,
          preview
        }]
      });
    }

    let toolResult;
    try {
      toolResult = await tool.execute({ db: req.db, session: req.session }, first.toolArgs);
    } catch (err) {
      toolResult = { error: 'execution_failed', message: err.message };
    }

    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: sessionKey,
      role: 'tool',
      tool_name: first.toolName,
      tool_args: JSON.stringify(first.toolArgs),
      tool_result: JSON.stringify(toolResult),
      status: (toolResult && toolResult.error) ? 'failed' : 'executed'
    });

    let replyText;
    try {
      const second = await gemini.callModel({
        systemPrompt: SYSTEM_PROMPT,
        tools: toolDefs,
        messages: [
          ...truncated,
          { role: 'assistant', parts: [{ functionCall: { name: first.toolName, args: first.toolArgs } }] },
          { role: 'tool', parts: [{ functionResponse: { name: first.toolName, response: toolResult } }] }
        ]
      });
      replyText = second.kind === 'text' ? second.text : '(unexpected tool call — stopping for this turn)';
    } catch (narrationErr) {
      console.error('Chat narration call failed:', narrationErr);
      replyText = (toolResult && toolResult.error)
        ? `Tool ran into a problem: ${toolResult.message || toolResult.error}`
        : `Done. (Narration unavailable: ${narrationErr.message})`;
    }

    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: sessionKey,
      role: 'assistant',
      content: replyText
    });

    return res.json({
      reply: replyText,
      actions: [{
        type: 'executed',
        tool: first.toolName,
        safety: tool.safety,
        args: first.toolArgs,
        result: toolResult
      }]
    });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/execute', requireAdmin, async (req, res) => {
  try {
    const { pending_id, decision } = req.body;
    if (!pending_id || !['confirm', 'cancel'].includes(decision)) {
      return res.status(400).json({ error: 'pending_id and decision (confirm|cancel) required' });
    }

    const row = await req.db('chat_messages').where({ id: pending_id }).first();
    if (!row) return res.status(404).json({ error: 'pending row not found' });
    if (row.user_id !== req.session.userId) return res.status(403).json({ error: 'not your pending action' });
    if (row.status !== 'pending_confirm') return res.status(400).json({ error: 'pending action no longer valid', status: row.status });

    if (decision === 'cancel') {
      await req.db('chat_messages').where({ id: pending_id }).update({ status: 'cancelled' });
      const msg = 'Cancelled.';
      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: row.session_key,
        role: 'assistant',
        content: msg
      });
      return res.json({ reply: msg, actions: [{ type: 'cancelled', pending_id }] });
    }

    const tool = chatTools.getTool(row.tool_name);
    if (!tool) return res.status(500).json({ error: 'tool no longer registered' });

    const args = row.tool_args ? JSON.parse(row.tool_args) : {};
    let toolResult;
    try {
      toolResult = await tool.execute({ db: req.db, session: req.session }, args);
    } catch (err) {
      toolResult = { error: 'execution_failed', message: err.message };
    }

    await req.db('chat_messages').where({ id: pending_id }).update({
      tool_result: JSON.stringify(toolResult),
      status: (toolResult && toolResult.error) ? 'failed' : 'executed'
    });

    const msg = toolResult && toolResult.error
      ? `Tried but ran into a problem: ${toolResult.message || toolResult.error}`
      : 'Done.';
    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: row.session_key,
      role: 'assistant',
      content: msg
    });

    return res.json({
      reply: msg,
      actions: [{ type: 'executed', tool: row.tool_name, safety: tool.safety, args, result: toolResult }]
    });
  } catch (err) {
    console.error('Chat execute error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
