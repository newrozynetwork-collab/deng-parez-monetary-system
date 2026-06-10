(function () {
  let messages = [];

  App.init(function () {
    bindEvents();
    renderThread();
  });

  function bindEvents() {
    $('#chat-form').on('submit', function (e) {
      e.preventDefault();
      sendUser();
    });
    $('#chat-input').on('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendUser();
      }
    });
    $('#chat-clear').on('click', clearThread);
    setupMic();
  }

  function setupMic() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      $('#chat-mic').hide();
      return;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';
    let active = false;
    rec.onresult = function (e) {
      let text = '';
      for (let i = e.resultIndex; i < e.results.length; i++) text += e.results[i][0].transcript;
      $('#chat-input').val(text);
    };
    rec.onend = function () { active = false; $('#chat-mic').removeClass('btn-danger').addClass('btn-outline-secondary'); };
    $('#chat-mic').on('click', function () {
      if (active) { rec.stop(); return; }
      try {
        rec.start();
        active = true;
        $('#chat-mic').removeClass('btn-outline-secondary').addClass('btn-danger');
      } catch (err) {
        App.showError('Mic could not start: ' + err.message);
      }
    });
  }

  function sendUser() {
    const text = String($('#chat-input').val() || '').trim();
    if (!text) return;
    $('#chat-input').val('').prop('disabled', true);
    $('#chat-send').prop('disabled', true);
    messages.push({ role: 'user', content: text });
    renderThread();
    showThinking(true);

    App.api('POST', '/api/chat', { messages: lastN(messages, 40) })
      .then(handleAssistantResponse)
      .catch(err => {
        showThinking(false);
        renderError(err && err.responseJSON && err.responseJSON.error || String(err));
      })
      .always(function () {
        $('#chat-input').prop('disabled', false).focus();
        $('#chat-send').prop('disabled', false);
      });
  }

  function lastN(arr, n) { return arr.slice(Math.max(0, arr.length - n)); }

  function handleAssistantResponse(resp) {
    showThinking(false);
    if (resp.reply) {
      messages.push({ role: 'assistant', content: resp.reply, actions: resp.actions || [] });
    }
    renderThread();
  }

  function clearThread() {
    messages = [];
    renderThread();
  }

  function showThinking(on) {
    $('#chat-thinking').remove();
    if (on) {
      $('#chat-thread').append('<div id="chat-thinking" class="chat-msg chat-msg-assistant">…</div>');
      scrollBottom();
    }
  }

  function renderError(msg) {
    $('#chat-thread').append('<div class="chat-msg chat-msg-error">' + esc(msg) + '</div>');
    scrollBottom();
  }

  function renderThread() {
    const $t = $('#chat-thread').empty();
    messages.forEach(m => {
      if (m.role === 'user') {
        $t.append('<div class="chat-msg chat-msg-user">' + esc(m.content) + '</div>');
      } else {
        $t.append('<div class="chat-msg chat-msg-assistant">' + esc(m.content) + '</div>');
        (m.actions || []).forEach(a => $t.append(renderAction(a)));
      }
    });
    if (window.feather) feather.replace();
    scrollBottom();
  }

  function renderAction(a) {
    if (a.type === 'executed') return renderExecuted(a);
    if (a.type === 'confirm') return renderConfirm(a);
    if (a.type === 'cancelled') return $('<div class="chat-card"><span class="chat-tool-name">' + esc(a.tool || 'cancelled') + '</span><div>Cancelled.</div></div>');
    if (a.type === 'preview_failed') return renderPreviewFailed(a);
    return $('<div class="chat-card"><span class="chat-tool-name">' + esc(a.type) + '</span></div>');
  }

  function renderPreviewFailed(a) {
    const $card = $('<div class="chat-card"></div>');
    $card.append('<div class="chat-tool-name">' + esc(a.tool) + ' — couldn\'t prepare</div>');
    const err = a.error || {};
    const label = err.error === 'not_found'
      ? 'No record matches "' + esc(err.query || '') + '".'
      : err.error === 'ambiguous'
        ? 'Multiple matches for "' + esc(err.query || '') + '". Reply with the one you mean.'
        : esc(err.message || err.error || 'Preview failed');
    $card.append('<div style="color:#a02525">' + label + '</div>');
    if (Array.isArray(err.candidates) && err.candidates.length) {
      const $ul = $('<ul></ul>');
      err.candidates.forEach(c => $ul.append('<li>' + esc(c.name) + ' (id ' + c.id + ')</li>'));
      $card.append($ul);
    }
    return $card;
  }

  function renderExecuted(a) {
    const $card = $('<div class="chat-card"></div>');
    $card.append('<div class="chat-tool-name">' + esc(a.tool) + '</div>');
    if (a.result && a.result.error) {
      $card.append('<div style="color:#a02525">' + esc(a.result.message || a.result.error) + '</div>');
      if (a.result.candidates) {
        const $ul = $('<ul></ul>');
        a.result.candidates.forEach(c => $ul.append('<li>' + esc(c.name) + ' (id ' + c.id + ')</li>'));
        $card.append($ul);
      }
      return $card;
    }
    if (a.tool === 'list_artists' || a.tool === 'list_referrers') {
      const matches = (a.result && a.result.matches) || [];
      if (matches.length === 0) { $card.append('<div>No matches.</div>'); return $card; }
      const $ul = $('<ul></ul>');
      matches.forEach(m => $ul.append('<li>' + esc(m.name) + (m.nickname ? ' (' + esc(m.nickname) + ')' : '') + '</li>'));
      $card.append($ul);
      return $card;
    }
    if (a.tool === 'list_recent_revenue') {
      const entries = (a.result && a.result.entries) || [];
      const $tbl = $('<table><thead><tr><th>Artist</th><th>Amount</th><th>Period</th><th>Source</th></tr></thead><tbody></tbody></table>');
      entries.forEach(e => {
        $tbl.find('tbody').append('<tr><td>' + esc(e.artist_name) + '</td><td>' + App.formatCurrency(e.amount) + '</td><td>' + esc(e.period_start || '') + ' → ' + esc(e.period_end || '') + '</td><td>' + esc(e.source || '') + '</td></tr>');
      });
      $card.append($tbl);
      return $card;
    }
    if (a.tool === 'preview_revenue_split') {
      $card.append(buildSplitTable(a.result));
      return $card;
    }
    if (a.tool === 'list_expenses' || a.tool === 'list_additional_income') {
      const entries = (a.result && a.result.entries) || [];
      if (!entries.length) { $card.append('<div>No entries.</div>'); return $card; }
      const $tbl = $('<table><thead><tr><th>Date</th><th>Category</th><th>Details</th><th style="text-align:right">Amount</th></tr></thead><tbody></tbody></table>');
      entries.forEach(e => {
        $tbl.find('tbody').append('<tr><td>' + esc(e.date || '') + '</td><td>' + esc(e.category_name || '') + '</td><td>' + esc(e.description || e.source || '') + '</td><td style="text-align:right">' + App.formatCurrency(e.amount) + '</td></tr>');
      });
      $card.append($tbl);
      $card.append('<div style="text-align:right; margin-top:4px;"><strong>Total: ' + App.formatCurrency(a.result.total) + '</strong></div>');
      return $card;
    }
    if (a.tool === 'get_financial_summary') {
      const s = a.result || {};
      const $tbl = $('<table></table>');
      const row = (k, v, strong) => $tbl.append('<tr><td>' + (strong ? '<strong>' + k + '</strong>' : k) + '</td><td style="text-align:right">' + (strong ? '<strong>' + App.formatCurrency(v) + '</strong>' : App.formatCurrency(v)) + '</td></tr>');
      row('Total revenue', s.totalRevenue);
      row('Artist payouts', s.totalArtistPayouts);
      row('Referral payouts', s.totalReferralPayouts);
      row('Bank fees', s.totalBankFees);
      row('Company revenue', s.companyRevenue);
      row('Additional income', s.totalAdditionalIncome);
      row('Expenses', s.totalExpenses);
      row('Net company profit', s.netCompanyProfit, true);
      $card.append($tbl);
      return $card;
    }
    if (a.tool === 'get_payments_summary') {
      const recips = (a.result && a.result.recipients) || [];
      if (!recips.length) { $card.append('<div>No payments recorded yet.</div>'); return $card; }
      const $tbl = $('<table><thead><tr><th>Name</th><th>Type</th><th style="text-align:right">Total paid</th><th>Payments</th><th>Last paid</th></tr></thead><tbody></tbody></table>');
      recips.forEach(r => {
        $tbl.find('tbody').append('<tr><td>' + esc(r.name) + '</td><td>' + esc(r.type) + '</td><td style="text-align:right">' + App.formatCurrency(r.totalPaid) + '</td><td>' + r.paymentCount + '</td><td>' + esc(String(r.lastPaid || '—').slice(0, 10)) + '</td></tr>');
      });
      $card.append($tbl);
      return $card;
    }
    if (a.tool === 'get_shower_link' || a.tool === 'youtube_share_link') {
      const url = (a.result && (a.result.url || a.result.url_path)) || '';
      const full = location.origin + url;
      $card.append('<div><a href="' + esc(full) + '" target="_blank" style="word-break:break-all;">' + esc(full) + '</a></div>');
      if (a.result && a.result.expires_at) $card.append('<div style="font-size:11px; opacity:.7;">Expires: ' + esc(String(a.result.expires_at).slice(0, 10)) + '</div>');
      return $card;
    }
    // Generic: show JSON
    $card.append('<pre style="font-size:11px; white-space:pre-wrap;">' + esc(JSON.stringify(a.result, null, 2)) + '</pre>');
    return $card;
  }

  function renderConfirm(a) {
    const $card = $('<div class="chat-card"></div>');
    $card.append('<div class="chat-tool-name">Confirm: ' + esc(a.tool) + '</div>');
    // Defense in depth: server should short-circuit preview errors before
    // ever sending a confirm action, but if one slips through, show the
    // error instead of a meaningless all-zero table.
    if (a.preview && a.preview.error) {
      const e = a.preview.error;
      $card.append('<div style="color:#a02525">' + esc(e.message || e.error || 'Preview failed') + '</div>');
      return $card;
    }
    if (a.preview) {
      if (a.tool === 'record_revenue') {
        $card.append(buildSplitTable(a.preview));
      } else {
        $card.append('<pre style="font-size:11px; white-space:pre-wrap;">' + esc(JSON.stringify(a.preview, null, 2)) + '</pre>');
      }
    }
    const $actions = $('<div class="chat-confirm-actions"></div>');
    const $yes = $('<button class="btn btn-success btn-sm">Confirm & save</button>');
    const $no = $('<button class="btn btn-outline-secondary btn-sm">Cancel</button>');
    $yes.on('click', () => decideConfirm(a.pending_id, 'confirm', $card));
    $no.on('click', () => decideConfirm(a.pending_id, 'cancel', $card));
    $actions.append($yes).append($no);
    $card.append($actions);
    return $card;
  }

  function decideConfirm(pendingId, decision, $card) {
    $card.find('button').prop('disabled', true);
    App.api('POST', '/api/chat/execute', { pending_id: pendingId, decision })
      .then(resp => {
        if (resp.reply) messages.push({ role: 'assistant', content: resp.reply, actions: resp.actions || [] });
        renderThread();
      })
      .catch(err => {
        renderError(err && err.responseJSON && err.responseJSON.error || String(err));
      });
  }

  function buildSplitTable(c) {
    const $tbl = $('<table></table>');
    if (c.artist_name) $tbl.append('<tr><td colspan=2><strong>Artist:</strong> ' + esc(c.artist_name) + '</td></tr>');
    $tbl.append(row('Gross', App.formatCurrency(c.grossRevenue)));
    $tbl.append(row('Bank fee (' + (c.bankFeePct || 0) + '%)', '-' + App.formatCurrency(c.bankFee || 0)));
    $tbl.append(row('Net', App.formatCurrency(c.netRevenue)));
    $tbl.append(row('Artist (' + (c.artistSplitPct || 0) + '%)', App.formatCurrency(c.artistShare)));
    $tbl.append(row('Company gross (' + (c.companySplitPct || 0) + '%)', App.formatCurrency(c.companyGross)));
    (c.referralBreakdown || []).forEach(r => {
      $tbl.append(row('→ ' + esc(r.referrerName) + ' L' + esc(r.level) + ' (' + esc(r.commissionPct) + '%)', App.formatCurrency(r.amount)));
    });
    $tbl.append(row('<strong>Company net</strong>', '<strong>' + App.formatCurrency(c.companyNet) + '</strong>'));
    return $tbl;
    function row(k, v) { return '<tr><td>' + k + '</td><td style="text-align:right">' + v + '</td></tr>'; }
  }

  function scrollBottom() {
    const t = document.getElementById('chat-thread');
    if (t) t.scrollTop = t.scrollHeight;
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
})();
