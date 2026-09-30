/* ============================================================================
   NEXA BOT — ADVANCED LAYER v2
   Appended AFTER the original nexa.js so every existing global is preserved.
   Overrides: nexaSend, nexaAskAI, nexaBotSay, toggleNexa, nexaOpenSetup,
              nexaSaveSetup, nexaUpdateAIDot, nexaTestKey
   Adds: streaming SSE, multi-turn memory, markdown+code rendering, chips,
         voice input, copy/regenerate/edit, retry+backoff, persistent history,
         model fallback chain, usage/timing info.
   ========================================================================== */
(function () {
  'use strict';

  var CHAT_PREFIX = 'utsav_nexa_chat_';
  var MODEL_PREFIX = 'utsav_nexa_model_';
  var MAX_TURNS = 12;          // turns of history sent to the model
  var MAX_STORED = 60;         // messages kept in localStorage
  var RETRY_MAX = 3;

  /* ---------------------------------------------------------------- utils */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function wsId() {
    try { return (typeof currentWorkspaceId !== 'undefined' && currentWorkspaceId) ? String(currentWorkspaceId) : 'default'; }
    catch (e) { return 'default'; }
  }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function money(n) { return '\u20b9' + Math.round(Number(n) || 0).toLocaleString('en-IN'); }
  function nowTs() { return Date.now(); }
  function fmtClock(ts) {
    try { return new Date(ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function uid() { return 'm' + nowTs().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ------------------------------------------------------- syntax highlight */
  var KW = {
    js: 'var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|this|typeof|instanceof|class|extends|super|try|catch|finally|throw|async|await|yield|import|export|from|default|null|undefined|true|false|of|in|delete|void',
    py: 'def|return|if|elif|else|for|while|import|from|as|class|try|except|finally|raise|with|lambda|None|True|False|and|or|not|in|is|pass|break|continue|yield|async|await|global|nonlocal|assert|del',
    json: 'true|false|null',
    css: '',
    html: ''
  };
  function highlight(code, lang) {
    var l = String(lang || '').toLowerCase();
    if (l === 'html' || l === 'xml') {
      return esc(code)
        .replace(/(&lt;\/?)([a-zA-Z][\w-]*)/g, '$1<span class="nx-tag">$2</span>')
        .replace(/([a-zA-Z-]+)=(&quot;.*?&quot;)/g, '<span class="nx-attr">$1</span>=<span class="nx-str">$2</span>');
    }
    if (l === 'css') {
      return esc(code)
        .replace(/([\w-]+)\s*:/g, '<span class="nx-attr">$1</span>:')
        .replace(/(#[0-9a-fA-F]{3,8}|\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms)?)/g, '<span class="nx-num">$1</span>');
    }
    var out = esc(code);
    // strings first (protect them), then comments, then keywords/numbers
    out = out.replace(/(&quot;[^&]*?&quot;|&#39;[^&]*?&#39;|'[^'\n]*'|"[^"\n]*")/g, '\u0001$1\u0002');
    out = out.replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span class="nx-com">$1</span>');
    var kws = KW[l] || KW.js;
    if (kws) out = out.replace(new RegExp('\\b(' + kws + ')\\b', 'g'), '<span class="nx-kw">$1</span>');
    out = out.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="nx-num">$1</span>');
    out = out.replace(/\u0001([\s\S]*?)\u0002/g, '<span class="nx-str">$1</span>');
    return out;
  }

  /* ------------------------------------------------------------ markdown */
  function inlineMd(s) {
    return s
      .replace(/`([^`\n]+)`/g, '<code class="nx-ic">$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?]|$)/g, '$1<em>$2</em>')
      .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }

  function nexaMd(src) {
    var text = String(src == null ? '' : src);
    var blocks = [];
    // 1. pull fenced code blocks out
    text = text.replace(/```([a-zA-Z0-9+#-]*)\n?([\s\S]*?)```/g, function (m, lang, code) {
      blocks.push({ lang: lang, code: code.replace(/\n$/, '') });
      return '\u0000CB' + (blocks.length - 1) + '\u0000';
    });
    // 2. escape everything else
    text = esc(text);
    // 3. block level, line by line
    var lines = text.split('\n');
    var out = [], i, m;
    var listOpen = null, tableBuf = [];
    function closeList() { if (listOpen) { out.push('</' + listOpen + '>'); listOpen = null; } }
    function flushTable() {
      if (!tableBuf.length) return;
      var rows = tableBuf.filter(function (r) { return !/^\s*\|?[\s:|-]+\|?\s*$/.test(r); });
      if (rows.length) {
        var html = '<div class="nx-tw"><table class="nx-tbl">';
        rows.forEach(function (r, idx) {
          var cells = r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|');
          html += '<tr>' + cells.map(function (c) {
            var t = inlineMd(c.trim());
            return idx === 0 ? '<th>' + t + '</th>' : '<td>' + t + '</td>';
          }).join('') + '</tr>';
        });
        html += '</table></div>';
        out.push(html);
      }
      tableBuf = [];
    }
    for (i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^\s*\|.*\|\s*$/.test(ln)) { closeList(); tableBuf.push(ln); continue; }
      flushTable();
      if (/^\u0000CB\d+\u0000\s*$/.test(ln.trim())) { closeList(); out.push(ln.trim()); continue; }
      if (/^\s*$/.test(ln)) { closeList(); continue; }
      if ((m = ln.match(/^(#{1,4})\s+(.*)$/))) { closeList(); out.push('<h' + m[1].length + ' class="nx-h">' + inlineMd(m[2]) + '</h' + m[1].length + '>'); continue; }
      if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(ln)) { closeList(); out.push('<hr class="nx-hr">'); continue; }
      if ((m = ln.match(/^\s*&gt;\s?(.*)$/))) { closeList(); out.push('<blockquote class="nx-bq">' + inlineMd(m[1]) + '</blockquote>'); continue; }
      if ((m = ln.match(/^\s*[-*+]\s+(.*)$/))) {
        if (listOpen !== 'ul') { closeList(); out.push('<ul class="nx-ul">'); listOpen = 'ul'; }
        out.push('<li>' + inlineMd(m[1]) + '</li>'); continue;
      }
      if ((m = ln.match(/^\s*\d+[.)]\s+(.*)$/))) {
        if (listOpen !== 'ol') { closeList(); out.push('<ol class="nx-ol">'); listOpen = 'ol'; }
        out.push('<li>' + inlineMd(m[1]) + '</li>'); continue;
      }
      closeList();
      out.push('<p class="nx-p">' + inlineMd(ln) + '</p>');
    }
    closeList(); flushTable();
    var html = out.join('');
    // 4. restore code blocks
    html = html.replace(/\u0000CB(\d+)\u0000/g, function (mm, n) {
      var b = blocks[+n] || { lang: '', code: '' };
      var label = b.lang ? '<span class="nx-lang">' + esc(b.lang) + '</span>' : '';
      return '<div class="nx-cb">' + label +
        '<button class="nx-copy-code" onclick="nexaCopyCode(this)" title="Copy code">\u29c9</button>' +
        '<pre class="nx-pre"><code>' + highlight(b.code, b.lang) + '</code></pre></div>';
    });
    return html;
  }
  window.nexaMd = nexaMd;

  window.nexaCopyCode = function (btn) {
    try {
      var pre = btn.parentNode.querySelector('pre');
      var txt = pre ? pre.innerText : '';
      navigator.clipboard.writeText(txt).then(function () {
        btn.innerText = '\u2713';
        setTimeout(function () { btn.innerText = '\u29c9'; }, 1200);
      });
    } catch (e) {}
  };

  /* --------------------------------------------------------- chat history */
  window.nexaHistory = [];

  function histKey() { return CHAT_PREFIX + wsId(); }
  window.nexaSaveHistory = function () {
    try {
      var h = window.nexaHistory.slice(-MAX_STORED);
      lsSet(histKey(), JSON.stringify(h));
    } catch (e) {}
  };
  window.nexaLoadHistory = function () {
    try {
      var raw = lsGet(histKey());
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  };
  window.nexaClearChat = function () {
    window.nexaHistory = [];
    lsDel(histKey());
    var box = document.getElementById('nexa-msgs');
    if (box) box.innerHTML = '';
    nexaBotSay('Chat cleared \u2728 Ask me anything about your events, clients, invoices, dues, expenses, tasks or profit & loss.', [], nexaChipsFor());
    if (typeof showToast === 'function') showToast('Chat history cleared', 'success');
  };

  /* ------------------------------------------------------------ rendering */
  function scrollBottom() {
    var box = document.getElementById('nexa-msgs');
    if (box) box.scrollTop = box.scrollHeight;
  }
  window.nexaScrollBottom = scrollBottom;

  function actionsHtml(id, role) {
    if (role === 'user') {
      return '<div class="nexa-macts"><button class="nexa-mact" onclick="nexaEditMsg(\'' + id + '\')" title="Edit & resend">\u270e Edit</button></div>';
    }
    return '<div class="nexa-macts">' +
      '<button class="nexa-mact" onclick="nexaCopyMsg(\'' + id + '\')" title="Copy reply">\u29c9 Copy</button>' +
      '<button class="nexa-mact" onclick="nexaRegenerate(\'' + id + '\')" title="Regenerate">\u21bb Retry</button>' +
      '<button class="nexa-mact" onclick="nexaSpeak(\'' + id + '\')" title="Read aloud">\ud83d\udd0a</button>' +
      '</div>';
  }

  function bubbleEl(role, id) {
    var box = document.getElementById('nexa-msgs');
    if (!box) return null;
    var d = document.createElement('div');
    d.className = 'nexa-bubble nexa-' + (role === 'user' ? 'user' : 'bot');
    d.setAttribute('data-mid', id);
    box.appendChild(d);
    scrollBottom();
    return d;
  }

  function renderBot(el, text, meta) {
    if (!el) return;
    el.innerHTML = '<div class="nexa-md">' + nexaMd(text) + '</div>' +
      actionsHtml(el.getAttribute('data-mid'), 'model') +
      (meta ? '<div class="nexa-ai-src">' + meta + '</div>' : '');
  }
  function renderUser(el, text) {
    if (!el) return;
    el.innerHTML = '<div class="nexa-md">' + esc(text).replace(/\n/g, '<br>') + '</div>' +
      actionsHtml(el.getAttribute('data-mid'), 'user');
  }

  window.nexaRenderHistory = function () {
    var box = document.getElementById('nexa-msgs');
    if (!box) return;
    box.innerHTML = '';
    var h = window.nexaHistory;
    if (!h.length) return;
    h.forEach(function (m) {
      var el = bubbleEl(m.role, m.id || uid());
      if (!el) return;
      if (m.role === 'user') renderUser(el, m.text);
      else renderBot(el, m.text, m.meta || '');
    });
    scrollBottom();
  };

  /* ------------------------------------------------------- message actions */
  window.nexaCopyMsg = function (id) {
    var m = window.nexaHistory.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    try {
      navigator.clipboard.writeText(m.text).then(function () {
        if (typeof showToast === 'function') showToast('Copied to clipboard', 'success');
      });
    } catch (e) {}
  };
  window.nexaSpeak = function (id) {
    var m = window.nexaHistory.filter(function (x) { return x.id === id; })[0];
    if (!m || !('speechSynthesis' in window)) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(m.text.replace(/[*#`_>|-]/g, ' ').slice(0, 600));
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  };
  window.nexaEditMsg = function (id) {
    var m = window.nexaHistory.filter(function (x) { return x.id === id; })[0];
    if (!m) return;
    var inp = document.getElementById('nexa-input');
    if (inp) { inp.value = m.text; inp.focus(); }
  };
  window.nexaRegenerate = function (id) {
    var h = window.nexaHistory;
    var idx = -1;
    for (var i = h.length - 1; i >= 0; i--) { if (h[i].id === id) { idx = i; break; } }
    if (idx < 0) return;
    var userMsg = null;
    for (var j = idx; j >= 0; j--) { if (h[j].role === 'user') { userMsg = h[j]; break; } }
    if (!userMsg) return;
    // drop everything from the user turn onward, then re-ask
    window.nexaHistory = h.slice(0, h.indexOf(userMsg));
    window.nexaRenderHistory();
    nexaAskAI(userMsg.text);
  };

  /* ------------------------------------------------------------- chips */
  window.nexaChipsFor = function () {
    var chips = [];
    try {
      var today = new Date(); today.setHours(0, 0, 0, 0);
      var evToday = 0, upcoming = 0;
      Object.values(leadsDB || {}).forEach(function (l) {
        var ds = (l.dates && l.dates.length ? l.dates : l.events || []);
        ds.forEach(function (d) {
          if (!d.date) return;
          var dt = new Date(d.date);
          if (isNaN(dt.getTime())) return;
          dt.setHours(0, 0, 0, 0);
          if (dt.getTime() === today.getTime()) evToday++;
          else if (dt >= today) upcoming++;
        });
      });
      var pend = 0;
      Object.values(globalTasksDB || {}).forEach(function (t) { if (!t.status || /pending/i.test(t.status)) pend++; });
      var due = 0, dueN = 0;
      Object.values(salesDB || {}).forEach(function (s) { if (s.type === 'Invoice' && (s.balanceDue || 0) > 0) { due += s.balanceDue; dueN++; } });

      if (evToday) chips.push('\ud83d\udcc5 Aaj ke events dikhao');
      if (dueN) chips.push('\ud83d\udd34 Pending dues batao');
      if (pend) chips.push('\u2705 Pending tasks batao');
      chips.push('\ud83d\udcc8 Revenue summary');
      if (upcoming) chips.push('\ud83d\udcc6 Upcoming events');
      chips.push('\ud83d\udcca P&L status');
      if (dueN) chips.push('\ud83d\udc64 Sabse zyada kaun owe karta hai?');
    } catch (e) {}
    if (!chips.length) chips = ['\ud83d\udcc5 Today\u2019s events', '\ud83e\uddfe Unpaid invoices', '\ud83d\udcc8 Total revenue', '\u2705 Pending tasks'];
    return chips.slice(0, 5);
  };

  function renderChips(container, chips) {
    if (!container || !chips || !chips.length) return;
    var wrap = document.createElement('div');
    wrap.className = 'nexa-chips';
    chips.forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'nexa-chip';
      b.innerText = c;
      b.onclick = function () { window.nexaSend(c); };
      wrap.appendChild(b);
    });
    container.appendChild(wrap);
  }

  /* --------------------------------------------------------- bot message */
  window.nexaBotSay = function (html, actions, chips) {
    var id = uid();
    var el = bubbleEl('model', id);
    if (!el) return null;
    el.innerHTML = '<div class="nexa-md">' + html + '</div>';
    if (actions && actions.length) {
      var a = document.createElement('div');
      a.className = 'nexa-actions';
      actions.forEach(function (act) {
        var b = document.createElement('button');
        b.className = 'nexa-act' + (act.primary ? ' primary' : '');
        b.innerText = act.label;
        b.onclick = function () { window.nexaAction(act.type, act.a, act.b); };
        a.appendChild(b);
      });
      el.appendChild(a);
    }
    renderChips(el, chips);
    scrollBottom();
    return el;
  };

  /* ------------------------------------------------------------ voice in */
  var recog = null, listening = false;
  window.nexaVoice = function () {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    var btn = document.getElementById('nexa-mic');
    if (!SR) {
      if (typeof showToast === 'function') showToast('Voice input is not supported in this browser', 'error');
      return;
    }
    if (listening && recog) { try { recog.stop(); } catch (e) {} return; }
    try {
      recog = new SR();
      recog.lang = 'en-IN';
      recog.interimResults = true;
      recog.continuous = false;
      listening = true;
      if (btn) btn.classList.add('rec');
      var inp = document.getElementById('nexa-input');
      recog.onresult = function (ev) {
        var txt = '';
        for (var i = ev.resultIndex; i < ev.results.length; i++) txt += ev.results[i][0].transcript;
        if (inp) inp.value = txt;
      };
      recog.onerror = function () {
        listening = false;
        if (btn) btn.classList.remove('rec');
        if (typeof showToast === 'function') showToast('Could not hear that \u2014 try again', 'error');
      };
      recog.onend = function () {
        listening = false;
        if (btn) btn.classList.remove('rec');
        if (inp && inp.value.trim()) window.nexaSend();
      };
      recog.start();
    } catch (e) {
      listening = false;
      if (btn) btn.classList.remove('rec');
    }
  };

  /* --------------------------------------------------------- model chain */
  window.nexaAIModels = ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-flash-latest', 'gemini-2.5-flash'];
  function modelChain() {
    var out = [];
    var saved = lsGet(MODEL_PREFIX + wsId());
    if (saved) out.push(saved);
    window.nexaAIModels.forEach(function (m) { if (out.indexOf(m) < 0) out.push(m); });
    return out;
  }
  function rememberModel(m) { lsSet(MODEL_PREFIX + wsId(), m); }

  /* --------------------------------------------------------- system prompt */
  function systemPrompt() {
    return 'You are "Nexa Bot", the built-in assistant of UTSAVhq, an Indian event-management ERP. ' +
      'The user is the business owner. You are given a snapshot of their workspace data below.\n' +
      'RULES:\n' +
      '1. Reply in the SAME language the user asked in: Hinglish (Roman Hindi + English mix) gets Hinglish, ' +
      'Gujarati in Roman letters gets Gujarati Roman, English gets English, Devanagari gets Devanagari.\n' +
      '2. Be concise but complete. Use markdown: **bold** for key numbers, "-" bullet lists, and tables when ' +
      'comparing 3+ items. Money in \u20b9 with Indian digit grouping (e.g. \u20b91,50,000). Dates as dd MMM yyyy.\n' +
      '3. Base every number ONLY on the provided data. Never invent clients, events, amounts or dates. ' +
      'If the data does not contain the answer, say so plainly.\n' +
      '4. When the user asks for analysis, comparisons, suggestions or forecasts, reason over the provided ' +
      'data and give a short, practical recommendation.\n' +
      '5. For actions (open report, call, WhatsApp) tell the user where to go in the app.';
  }

  function buildContents(question) {
    var contents = [];
    var h = window.nexaHistory.slice(-MAX_TURNS * 2);
    h.forEach(function (m) {
      if (!m.text) return;
      contents.push({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] });
    });
    contents.push({ role: 'user', parts: [{ text: question }] });
    return contents;
  }

  /* ------------------------------------------------------------- streaming */
  var activeAbort = null;
  window.nexaStop = function () {
    if (activeAbort) { try { activeAbort.abort(); } catch (e) {} activeAbort = null; }
    var b = document.getElementById('nexa-stop');
    if (b) b.style.display = 'none';
  };

  function setStatus(txt) {
    var s = document.getElementById('nexa-status');
    if (s) s.innerText = txt || '';
  }

  function usageLine(model, ms, usage) {
    var parts = ['\u2728 ' + model];
    if (ms) parts.push((ms / 1000).toFixed(1) + 's');
    if (usage && usage.totalTokenCount) parts.push(usage.totalTokenCount + ' tokens');
    parts.push('free tier');
    return parts.join(' \u00b7 ');
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* Core: stream one model. Returns {ok, text, usage, status, err} */
  function streamModel(model, question, onDelta, signal) {
    var key = nexaGetApiKey();
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model +
      ':streamGenerateContent?alt=sse';
    var body = {
      systemInstruction: { parts: [{ text: systemPrompt() }] },
      contents: buildContents(question),
      generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
    };
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var j = null; try { j = JSON.parse(t); } catch (e) {}
          return { ok: false, status: res.status, err: j, text: '' };
        });
      }
      if (!res.body || !res.body.getReader) {
        // no streaming support -> fall back to whole-body JSON
        return res.text().then(function (t) {
          var txt = '', usage = null;
          t.split('\n').forEach(function (line) {
            var s = line.replace(/^data:\s*/, '').trim();
            if (!s || s === '[DONE]') return;
            try {
              var j = JSON.parse(s);
              var c = j.candidates && j.candidates[0];
              if (c && c.content && c.content.parts) txt += c.content.parts.map(function (p) { return p.text || ''; }).join('');
              if (j.usageMetadata) usage = j.usageMetadata;
            } catch (e) {}
          });
          if (txt) onDelta(txt, true);
          return { ok: true, status: 200, text: txt, usage: usage };
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder('utf-8');
      var buf = '', full = '', usage = null;
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return { ok: true, status: 200, text: full, usage: usage };
          buf += dec.decode(r.value, { stream: true });
          var parts = buf.split('\n');
          buf = parts.pop();
          parts.forEach(function (line) {
            var s = line.replace(/^data:\s*/, '').trim();
            if (!s || s === '[DONE]') return;
            try {
              var j = JSON.parse(s);
              var c = j.candidates && j.candidates[0];
              if (c && c.content && c.content.parts) {
                var chunk = c.content.parts.map(function (p) { return p.text || ''; }).join('');
                if (chunk) { full += chunk; onDelta(full, false); }
              }
              if (j.usageMetadata) usage = j.usageMetadata;
            } catch (e) {}
          });
          return pump();
        });
      }
      return pump();
    });
  }

  /* Ask with model fallback + retry/backoff + streaming render */
  window.nexaAskAI = function (question, targetEl) {
    var key = nexaGetApiKey();
    if (!key) {
      var el0 = targetEl || bubbleEl('model', uid());
      if (el0) el0.innerHTML = '\u26a0\ufe0f No Gemini API key saved. Tap \u2699 to add one.';
      return;
    }
    var el = targetEl || bubbleEl('model', uid());
    if (!el) return;
    var mid = el.getAttribute('data-mid') || uid();
    el.setAttribute('data-mid', mid);
    el.innerHTML = '<span class="nexa-typing"><span></span><span></span><span></span></span>';
    setStatus('Thinking\u2026');

    var chain = modelChain();
    var t0 = nowTs();
    var lastErr = null;

    function tryModel(i, attempt) {
      if (i >= chain.length) {
        // all models failed
        var msg = '\u26a0\ufe0f Advanced AI could not answer right now.';
        if (lastErr && lastErr.status === 401) {
          msg = '\u26a0\ufe0f <b>Google rejected the key (401).</b><br>Your key is probably fine \u2014 Google is currently ' +
            'rejecting the new <code>AQ.</code> auth keys on this API for many accounts.<br><b>What to try:</b> create a ' +
            'standard <code>AIza</code> key in Google Cloud Console with the Generative Language API enabled.';
        } else if (lastErr && (lastErr.status === 400 || lastErr.status === 403)) {
          msg = '\u26a0\ufe0f <b>API key problem.</b> Please check your Gemini key in settings.';
        } else if (lastErr && lastErr.status === 429) {
          msg = '\u23f3 Free-tier limit reached. Please try again in a minute.';
        } else if (lastErr && lastErr.offline) {
          msg = '\ud83d\udce1 You seem offline \u2014 Advanced AI needs internet. Local answers still work!';
        }
        el.innerHTML = '<div class="nexa-md">' + msg + '</div>' +
          '<div class="nexa-macts"><button class="nexa-mact" onclick="nexaRetryLast()">\u21bb Retry</button>' +
          '<button class="nexa-mact" onclick="nexaOpenSetup()">\u2699 Key</button></div>';
        setStatus('');
        scrollBottom();
        return;
      }
      var model = chain[i];
      var ctrl = ('AbortController' in window) ? new AbortController() : null;
      activeAbort = ctrl;
      var stopBtn = document.getElementById('nexa-stop');
      if (stopBtn) stopBtn.style.display = 'flex';
      var lastPaint = 0;

      streamModel(model, question, function (partial, done) {
        var t = nowTs();
        if (done || t - lastPaint > 60) {
          lastPaint = t;
          el.innerHTML = '<div class="nexa-md">' + nexaMd(partial) + '</div>';
          scrollBottom();
        }
      }, ctrl ? ctrl.signal : undefined).then(function (r) {
        if (stopBtn) stopBtn.style.display = 'none';
        activeAbort = null;
        if (r.ok && r.text) {
          rememberModel(model);
          var ms = nowTs() - t0;
          var meta = usageLine(model, ms, r.usage);
          renderBot(el, r.text, meta);
          renderChips(el, nexaChipsFor());
          window.nexaHistory.push({ id: mid, role: 'model', text: r.text, ts: nowTs(), meta: meta });
          window.nexaSaveHistory();
          setStatus('');
          scrollBottom();
          return;
        }
        lastErr = r;
        // 404 / empty -> next model immediately; 429/5xx -> backoff retry
        var retriable = r.status === 429 || r.status >= 500 || r.status === 0;
        if (retriable && attempt < RETRY_MAX) {
          var wait = Math.min(8000, 600 * Math.pow(2, attempt));
          setStatus('Retrying in ' + Math.round(wait / 1000) + 's\u2026');
          return sleep(wait).then(function () { return tryModel(i, attempt + 1); });
        }
        return tryModel(i + 1, 0);
      }).catch(function (e) {
        if (stopBtn) stopBtn.style.display = 'none';
        activeAbort = null;
        if (e && e.name === 'AbortError') { setStatus(''); return; }
        lastErr = { status: 0, offline: true };
        if (attempt < RETRY_MAX) {
          var wait = Math.min(8000, 600 * Math.pow(2, attempt));
          setStatus('Network issue \u2014 retrying in ' + Math.round(wait / 1000) + 's\u2026');
          return sleep(wait).then(function () { return tryModel(i, attempt + 1); });
        }
        return tryModel(i + 1, 0);
      });
    }
    tryModel(0, 0);
  };

  window.nexaRetryLast = function () {
    var h = window.nexaHistory;
    for (var i = h.length - 1; i >= 0; i--) {
      if (h[i].role === 'user') { window.nexaSend(h[i].text); return; }
    }
  };

  /* ------------------------------------------------------------- send */
  window.nexaSend = function (preset) {
    var inp = document.getElementById('nexa-input');
    var q = String(preset || (inp && inp.value) || '').trim();
    if (!q) return;
    if (inp) inp.value = '';

    var uidUser = uid();
    var uEl = bubbleEl('user', uidUser);
    renderUser(uEl, q);
    window.nexaHistory.push({ id: uidUser, role: 'user', text: q, ts: nowTs() });
    window.nexaSaveHistory();

    var botId = uid();
    var bEl = bubbleEl('model', botId);
    bEl.innerHTML = '<span class="nexa-typing"><span></span><span></span><span></span></span>';

    setTimeout(function () {
      var local = null;
      try { local = nexaThink(q); } catch (e) { local = null; }

      // The local engine returns {fallback:true} for "I don't understand".
      // Before workspace hydration it returns a "still loading" notice with NO
      // fallback flag — that must also route to the AI when a key is present.
      var isFallback = !local || local.fallback === true ||
        (!local.actions || !local.actions.length) && /still loading/i.test(String(local.html || ''));

      if (local && !isFallback) {
        // deterministic local answer (fast, offline, exact numbers).
        // local.html is ALREADY html -> render raw, never through the markdown escaper.
        var meta = '\u26a1 instant \u00b7 local data engine';
        bEl.innerHTML = '<div class="nexa-md">' + local.html + '</div>' +
          actionsHtml(botId, 'model') + '<div class="nexa-ai-src">' + meta + '</div>';
        if (local.actions && local.actions.length) {
          var a = document.createElement('div');
          a.className = 'nexa-actions';
          local.actions.forEach(function (act) {
            var b = document.createElement('button');
            b.className = 'nexa-act' + (act.primary ? ' primary' : '');
            b.innerText = act.label;
            b.onclick = function () { window.nexaAction(act.type, act.a, act.b); };
            a.appendChild(b);
          });
          bEl.appendChild(a);
        }
        renderChips(bEl, (local.chips && local.chips.length) ? local.chips : nexaChipsFor());
        window.nexaHistory.push({ id: botId, role: 'model', text: local.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), ts: nowTs(), meta: meta });
        window.nexaSaveHistory();
        scrollBottom();
        return;
      }

      if (nexaGetApiKey()) {
        window.nexaAskAI(q, bEl);
        return;
      }

      // no key -> local fallback + upsell
      var html = (local && local.html ? local.html : '\ud83e\udd14 I didn\u2019t quite get that.') +
        '<br><br>\u2728 <b>Tip:</b> turn on <b>Advanced AI</b> (free) and I can answer <i>any</i> question \u2014 ' +
        'profit analysis, comparisons, suggestions \u2014 anything about your business.';
      renderBot(bEl, html, '');
      var act = document.createElement('div');
      act.className = 'nexa-actions';
      var btn = document.createElement('button');
      btn.className = 'nexa-act primary';
      btn.innerText = '\u2699\ufe0f Enable Advanced AI \u2014 Free';
      btn.onclick = function () { window.nexaAction('setup'); };
      act.appendChild(btn);
      bEl.appendChild(act);
      renderChips(bEl, (local && local.chips) || nexaChipsFor());
      scrollBottom();
    }, 260);
  };

  /* ------------------------------------------------------------- panel */
  window.toggleNexa = function (force) {
    var p = document.getElementById('nexa-panel');
    if (!p) return;
    var isOpen = p.classList.contains('open');
    var open = (typeof force === 'boolean') ? force : !isOpen;
    if (open) {
      p.classList.add('open');
      if (typeof nexaUpdateAIDot === 'function') nexaUpdateAIDot();
      if (!p.dataset.welcomed) {
        p.dataset.welcomed = '1';
        var saved = window.nexaLoadHistory();
        if (saved.length) {
          window.nexaHistory = saved;
          window.nexaRenderHistory();
        } else {
          nexaBotSay(
            'Hi Deepak! I\u2019m <b>Nexa Bot</b> \ud83e\udd16 \u2014 your AI data assistant.<br>' +
            'Ask me anything about your <b>events, clients, invoices, dues, expenses, tasks, profit &amp; loss or reports</b> \u2014 ' +
            'in <b>English, Hindi/Hinglish or Gujarati</b>.',
            [], nexaChipsFor());
        }
      }
      setTimeout(function () {
        var i = document.getElementById('nexa-input');
        if (i) i.focus();
      }, 250);
    } else {
      p.classList.remove('open');
      window.nexaStop();
    }
  };

  /* ------------------------------------------------------------- setup UI */
  window.nexaUpdateAIDot = function () {
    var d = document.getElementById('nexa-ai-dot');
    if (d) d.classList.toggle('on', !!nexaGetApiKey());
  };

  window.nexaOpenSetup = function () {
    var m = document.getElementById('nexaSetupModal');
    if (!m) return;
    var i = document.getElementById('nexaKeyInput');
    if (i) i.value = nexaGetApiKey();
    var s = document.getElementById('nexaKeyStatus');
    if (s) s.innerHTML = '';
    m.style.display = 'flex';
    setTimeout(function () { if (i) i.focus(); }, 150);
  };

  window.nexaSaveSetup = function () {
    var i = document.getElementById('nexaKeyInput');
    var k = String((i && i.value) || '').trim();
    if (!k) {
      if (typeof showToast === 'function') showToast('Please paste your Gemini API key first.', 'error');
      return;
    }
    if (k.indexOf('AQ.') !== 0 && k.indexOf('AIza') !== 0) {
      if (typeof showToast === 'function') showToast('Key saved \u2014 but it does not start with "AQ." or "AIza". If it fails, re-copy it from AI Studio.', 'error');
    }
    nexaSetApiKey(k);
    window.nexaCloseSetup();
    if (typeof showToast === 'function') showToast('Advanced AI activated!', 'success');
    var p = document.getElementById('nexa-panel');
    if (p && p.classList.contains('open')) {
      nexaBotSay('\u2728 <b>Advanced AI is ON!</b> Now ask me <i>anything</i> \u2014 in Hinglish, English or Gujarati. ' +
        'I will answer in the same language you use.', [], nexaChipsFor());
    }
  };

  window.nexaTestKey = function () {
    var key = nexaGetApiKey();
    var st = document.getElementById('nexaKeyStatus');
    function say(h) { if (st) st.innerHTML = h; }
    if (!key) { say('\u26a0\ufe0f No key saved yet.'); return; }
    say('\u23f3 Testing key\u2026');
    fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=5', { headers: { 'x-goog-api-key': key } })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, status: r.status, j: j }; }); })
      .then(function (r) {
        if (r.ok) {
          var n = (r.j && r.j.models && r.j.models.length) || 0;
          say('\u2705 <b>Key works!</b> Google returned ' + n + ' models. Advanced AI is ready.');
        } else {
          var reason = '';
          try { reason = r.j.error.details[0].reason || ''; } catch (e) {}
          var msg = (r.j && r.j.error && r.j.error.message) || '';
          if (r.status === 401) {
            say('\u26a0\ufe0f <b>HTTP 401</b> \u2014 Google rejected the key' + (reason ? ' (<code>' + esc(reason) + '</code>)' : '') +
              '.<br>This is the known <code>AQ.</code> auth-key rollout issue, not a typo. Try a standard <code>AIza</code> key from Google Cloud Console.');
          } else if (r.status === 400) {
            say('\u274c <b>HTTP 400</b> \u2014 the key itself is invalid' + (reason ? ' (<code>' + esc(reason) + '</code>)' : '') +
              '.<br>Re-copy it from <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">AI Studio</a>.');
          } else {
            say('\u26a0\ufe0f <b>HTTP ' + r.status + '</b> \u2014 ' + esc(msg || 'unexpected response') + (reason ? ' (<code>' + esc(reason) + '</code>)' : ''));
          }
        }
      })
      .catch(function () { say('\ud83d\udce1 Could not reach Google \u2014 check your internet connection.'); });
  };

  /* --------------------------------------------------- restore on load */
  function boot() {
    try {
      window.nexaHistory = window.nexaLoadHistory();
      if (typeof nexaUpdateAIDot === 'function') nexaUpdateAIDot();
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
