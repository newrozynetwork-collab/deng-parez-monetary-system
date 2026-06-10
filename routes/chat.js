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

// A single user message may legitimately need several tool steps (look up a
// category, then record the income). The loop runs read/safe_write tools
// inline and stops at: a text reply, a needs_confirmation card, or the cap.
const MAX_STEPS = 5;

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
    const convo = messages.slice(-40);
    const actions = [];
    let replyText = null;

    for (let step = 0; step < MAX_STEPS && replyText === null; step++) {
      let result;
      try {
        result = await gemini.callModel({ systemPrompt: SYSTEM_PROMPT, tools: toolDefs, messages: convo });
      } catch (err) {
        if (step === 0) throw err; // nothing happened yet — outer catch turns this into a friendly error
        console.error('Chat mid-turn model call failed:', err);
        const lastAct = actions[actions.length - 1];
        replyText = (lastAct && lastAct.result && lastAct.result.error)
          ? `Tool ran into a problem: ${lastAct.result.message || lastAct.result.error}`
          : `Done. (Narration unavailable: ${err.message})`;
        break;
      }

      if (result.kind === 'text') { replyText = result.text; break; }

      const tool = chatTools.getTool(result.toolName);
      if (!tool) { replyText = `I tried to use an unknown tool: ${result.toolName}`; break; }

      if (tool.safety === 'needs_confirmation') {
        let preview = null;
        if (typeof tool.buildPreview === 'function') {
          try { preview = await tool.buildPreview({ db: req.db }, result.toolArgs); } catch (_) { /* preview optional */ }
        }

        // If the preview itself surfaced an error (e.g. resolver returned
        // not_found / ambiguous), short-circuit — don't open a confirmation
        // card for an action that can't possibly succeed.
        if (preview && preview.error) {
          const inner = preview.error;
          const failText = inner.error === 'not_found'
            ? `I couldn't find "${inner.query || 'that record'}". Want me to add it first?`
            : inner.error === 'ambiguous'
              ? `Multiple matches for "${inner.query}". Which one did you mean?`
              : `Can't prepare the action: ${inner.message || inner.error}`;
          await logMessage(req.db, {
            user_id: req.session.userId,
            session_key: sessionKey,
            role: 'tool',
            tool_name: result.toolName,
            tool_args: JSON.stringify(result.toolArgs),
            tool_result: JSON.stringify({ preview_error: inner }),
            status: 'failed'
          });
          await logMessage(req.db, {
            user_id: req.session.userId,
            session_key: sessionKey,
            role: 'assistant',
            content: failText
          });
          return res.json({
            reply: failText,
            actions: [...actions, {
              type: 'preview_failed',
              tool: result.toolName,
              safety: tool.safety,
              args: result.toolArgs,
              error: inner
            }]
          });
        }

        const insertedPending = await req.db('chat_messages').insert({
          user_id: req.session.userId,
          session_key: sessionKey,
          role: 'tool',
          tool_name: result.toolName,
          tool_args: JSON.stringify(result.toolArgs),
          status: 'pending_confirm'
        }).returning('id');
        const pendingId = Array.isArray(insertedPending)
          ? (typeof insertedPending[0] === 'object' ? insertedPending[0].id : insertedPending[0])
          : insertedPending;

        const confirmText = `Please confirm: ${tool.confirmationLabel || result.toolName}`;
        await logMessage(req.db, {
          user_id: req.session.userId,
          session_key: sessionKey,
          role: 'assistant',
          content: confirmText
        });

        return res.json({
          reply: confirmText,
          actions: [...actions, {
            type: 'confirm',
            pending_id: pendingId,
            tool: result.toolName,
            safety: tool.safety,
            args: result.toolArgs,
            preview
          }]
        });
      }

      // read / safe_write tools run inline and feed the next model step
      let toolResult;
      try {
        toolResult = await tool.execute({ db: req.db, session: req.session }, result.toolArgs);
      } catch (err) {
        toolResult = { error: 'execution_failed', message: err.message };
      }

      await logMessage(req.db, {
        user_id: req.session.userId,
        session_key: sessionKey,
        role: 'tool',
        tool_name: result.toolName,
        tool_args: JSON.stringify(result.toolArgs),
        tool_result: JSON.stringify(toolResult),
        status: (toolResult && toolResult.error) ? 'failed' : 'executed'
      });

      actions.push({
        type: 'executed',
        tool: result.toolName,
        safety: tool.safety,
        args: result.toolArgs,
        result: toolResult
      });
      convo.push({ role: 'assistant', parts: [{ functionCall: { name: result.toolName, args: result.toolArgs } }] });
      convo.push({ role: 'tool', parts: [{ functionResponse: { name: result.toolName, response: toolResult } }] });
    }

    if (replyText === null) {
      replyText = `I used my ${MAX_STEPS}-step limit for one message. Here's what I found so far — tell me how to continue.`;
    }

    await logMessage(req.db, {
      user_id: req.session.userId,
      session_key: sessionKey,
      role: 'assistant',
      content: replyText
    });

    return res.json({ reply: replyText, actions });
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
