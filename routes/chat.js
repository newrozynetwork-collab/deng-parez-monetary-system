const router = require('express').Router();
const { requireAdmin } = require('../middleware/auth');
const chatTools = require('../services/chatTools');
const gemini = require('../services/gemini');

const SYSTEM_PROMPT = `You are the chat assistant for the Deng Parez music label monetary system.
Be terse and precise. You command the WHOLE back office: artists, referrers, revenue, additional income, expenses, categories, financial reports, payment history, the public Report Shower, and YouTube channels.

Rules:
- BEFORE any artist-targeted action (record_revenue, update_artist, delete_artist, preview_revenue_split), call list_artists FIRST to verify the artist exists, unless this turn's history already shows that. If they don't exist, ask the user whether to add them — do NOT proceed to record_revenue / update / delete on a name you haven't confirmed.
- Same rule for referrers: call list_referrers before update_referrer or delete_referrer.
- Never guess between candidates. If a lookup returns multiple matches, ask which one.
- When a tool auto-creates side effects (e.g. add_artist creating a new referrer), disclose it in your reply.
- Keep replies short. The UI shows tool results separately — don't restate raw numbers when a card will render them.

Money that is NOT artist revenue:
- "additional income" (consulting, sponsorship, misc money in) → add_additional_income. Commission is 0 unless the user explicitly gives a percentage and recipient. Dates default to today.
- company spending → add_expense.
- Both need an existing category. The tools fuzzy-match category names ("others" → "Other"); call list_categories when the category is unclear, and ask rather than guess.
- To change or remove entries, find the id with list_additional_income / list_expenses / list_recent_revenue first.

Questions like "how did we do", "profit this month", "who is owed money":
- get_financial_summary (optionally with start/end dates), get_payments_summary, get_payment_history.

User accounts: list_users is READ-ONLY by design. You cannot create, modify or delete accounts or passwords — direct the user to Settings → User Management.

Report Shower: list_shower_artists, get_shower_link (the artist's permanent public page), delete_shower_artist. Uploading royalty files happens on the /shower/admin page, not in chat.

YouTube: youtube_overview for channel status, youtube_share_link to mint a connect link an artist can open themselves. Connecting via OAuth and syncing revenue happen on the YouTube page (they need a browser).`;

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

      // If the preview itself surfaced an error (e.g. resolveArtist returned
      // not_found / ambiguous), short-circuit — don't open a confirmation card
      // for an action that can't possibly succeed.
      if (preview && preview.error) {
        const inner = preview.error;
        const replyText = inner.error === 'not_found'
          ? `I couldn't find "${inner.query || 'that record'}". Want me to add it first?`
          : inner.error === 'ambiguous'
            ? `Multiple matches for "${inner.query}". Which one did you mean?`
            : `Can't prepare the action: ${inner.message || inner.error}`;
        await logMessage(req.db, {
          user_id: req.session.userId,
          session_key: sessionKey,
          role: 'tool',
          tool_name: first.toolName,
          tool_args: JSON.stringify(first.toolArgs),
          tool_result: JSON.stringify({ preview_error: inner }),
          status: 'failed'
        });
        await logMessage(req.db, {
          user_id: req.session.userId,
          session_key: sessionKey,
          role: 'assistant',
          content: replyText
        });
        return res.json({
          reply: replyText,
          actions: [{
            type: 'preview_failed',
            tool: first.toolName,
            safety: tool.safety,
            args: first.toolArgs,
            error: inner
          }]
        });
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
    const friendly = gemini.friendlyError(err);
    if (friendly) return res.status(friendly.status).json({ error: friendly.message });
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

    const args = row.tool_args
      ? (typeof row.tool_args === 'string' ? JSON.parse(row.tool_args) : row.tool_args)
      : {};
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
    const friendly = gemini.friendlyError(err);
    if (friendly) return res.status(friendly.status).json({ error: friendly.message });
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
