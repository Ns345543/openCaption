/*
 * chat.js — openCaption AI Chat.
 *
 * A separate full-panel overlay, opened from the header icon. It is
 * deliberately independent of the caption pipeline: its own Groq key, its own
 * model, its own history file (%APPDATA%\CaptionAI\chat.json). Nothing here
 * reads or writes the Gemini settings in config.json.
 *
 * The Groq key is obfuscated with the same local XOR scheme as the Gemini key.
 * That is not encryption; anyone with access to the Windows account can
 * recover it. The key is never logged and never leaves api.groq.com.
 */
var Chat = (function () {
  'use strict';

  var STORE_VERSION = 1;
  var DEFAULT_MODEL = 'openai/gpt-oss-120b';
  var FALLBACK_MODELS = [
    { id: 'openai/gpt-oss-120b', context: 131072 },
    { id: 'openai/gpt-oss-20b', context: 131072 },
    { id: 'qwen/qwen3-32b', context: 131072 },
    { id: 'moonshotai/kimi-k2-instruct-0905', context: 262144 },
    { id: 'llama-3.3-70b-versatile', context: 131072 }
  ];
  var MAX_HISTORY_MESSAGES = 60;
  var MAX_HISTORY_CHARS = 120000;
  var SYSTEM_PROMPT = 'You are openCaption AI, a concise, practical assistant built into ' +
    'the openCaption panel for Adobe Premiere Pro. Help with editing, captions, code, ' +
    'writing, and general questions. Use Markdown when it improves readability.';

  var S = {
    booted: false,
    open: false,
    settings: false,
    generating: false,
    run: null,
    conv: null,
    conn: 'off',
    connText: 'Not connected',
    models: [],
    sideCollapsed: false,
    verified: false,
    saveWarned: false
  };

  var els = {};
  var store = null;
  var cs = null;
  var saveTimer = 0;
  var canPersist = false;
  var chatFile = '';

  function $(id) { return document.getElementById(id); }

  /* ---------------------------------------------------------------- helpers */

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function newId(prefix) {
    return (prefix || 'm') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function timeLabel(ts) {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  function dayLabel(ts) {
    try {
      var d = new Date(ts);
      var now = new Date();
      if (d.toDateString() === now.toDateString()) return timeLabel(ts);
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function copyText(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '0';
    area.style.left = '-9999px';
    area.style.opacity = '0';
    document.body.appendChild(area);

    var copied = false;
    try {
      area.select();
      area.setSelectionRange(0, area.value.length);
      copied = document.execCommand('copy');
    } catch (e) { copied = false; }
    document.body.removeChild(area);

    if (copied) return Promise.resolve();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }
    return Promise.reject(new Error('the clipboard is unavailable'));
  }

  function flash(btn, text) {
    if (!btn) return;
    var old = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () {
      btn.textContent = old;
      btn.disabled = false;
    }, 1200);
  }

  function openExternal(url) {
    if (!/^https?:\/\//i.test(String(url || ''))) return false;
    try {
      if (cs) return cs.openURLInDefaultBrowser(url);
    } catch (e) { /* fall through */ }
    try { window.open(url, '_blank'); return true; } catch (e2) { return false; }
  }

  function scrollBottom() {
    if (!els.chatMessages) return;
    els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
  }

  /* ------------------------------------------------------------- markdown */

  function inlineMd(text) {
    var codes = [];
    text = text.replace(/`([^`\n]+)`/g, function (_, code) {
      codes.push('<code>' + code + '</code>');
      return '\u0001C' + (codes.length - 1) + '\u0001';
    });
    text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, url) {
      return '<a href="' + url + '" data-ext="link" rel="noreferrer">' + label + '</a>';
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    text = text.replace(/\u0001C(\d+)\u0001/g, function (_, index) {
      return codes[Number(index)] || '';
    });
    return text;
  }

  function codeBlockHtml(block) {
    var lang = block.lang ? escapeHtml(block.lang) : 'code';
    var code = escapeHtml(block.code.replace(/\n$/, ''));
    return '<div class="md-code">' +
      '<div class="md-code-head"><span>' + lang + '</span>' +
      '<button type="button" class="md-copy" title="Copy this code">copy</button></div>' +
      '<pre><code>' + code + '</code></pre></div>';
  }

  function tableCells(line) {
    var text = line.trim();
    if (text.charAt(0) === '|') text = text.slice(1);
    if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1);
    return text.split('|').map(function (cell) { return cell.trim(); });
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function renderMarkdown(source) {
    var src = String(source == null ? '' : source).replace(/\r\n/g, '\n');
    var blocks = [];

    src = src.replace(/```([A-Za-z0-9_+.#-]*)[ \t]*\n([\s\S]*?)```/g, function (_, lang, code) {
      blocks.push({ lang: lang || '', code: code });
      return '\u0000B' + (blocks.length - 1) + '\u0000';
    });

    /* Everything outside a code fence is plain text from the model. Escape it
       before any tag is generated: the model must never be able to inject HTML,
       inline handlers, or script into the panel. Code fence contents are
       escaped separately by codeBlockHtml(). */
    src = escapeHtml(src);

    var lines = src.split('\n');
    var out = [];
    var para = [];

    function flushPara() {
      if (!para.length) return;
      out.push('<p>' + inlineMd(para.join('<br>')) + '</p>');
      para = [];
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var blockMatch = line.match(/^\u0000B(\d+)\u0000$/);

      if (blockMatch) {
        flushPara();
        var block = blocks[Number(blockMatch[1])];
        if (block) out.push(codeBlockHtml(block));
        continue;
      }

      if (!line.trim()) { flushPara(); continue; }

      var heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        flushPara();
        var level = heading[1].length;
        out.push('<h' + level + '>' + inlineMd(heading[2]) + '</h' + level + '>');
        continue;
      }

      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
        flushPara();
        out.push('<hr>');
        continue;
      }

      if (/^\s*(?:>|&gt;)\s?/.test(line)) {
        flushPara();
        var quoted = [];
        while (i < lines.length && /^\s*(?:>|&gt;)\s?/.test(lines[i])) {
          quoted.push(inlineMd(lines[i].replace(/^\s*(?:>|&gt;)\s?/, '')));
          i++;
        }
        i--;
        out.push('<blockquote>' + quoted.join('<br>') + '</blockquote>');
        continue;
      }

      var bullet = line.match(/^\s*[-*+]\s+(.*)$/);
      if (bullet) {
        flushPara();
        var items = [];
        while (i < lines.length) {
          var item = lines[i].match(/^\s*[-*+]\s+(.*)$/);
          if (!item) break;
          items.push('<li>' + inlineMd(item[1]) + '</li>');
          i++;
        }
        i--;
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }

      var numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (numbered) {
        flushPara();
        var ordered = [];
        while (i < lines.length) {
          var entry = lines[i].match(/^\s*\d+[.)]\s+(.*)$/);
          if (!entry) break;
          ordered.push('<li>' + inlineMd(entry[1]) + '</li>');
          i++;
        }
        i--;
        out.push('<ol>' + ordered.join('') + '</ol>');
        continue;
      }

      if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushPara();
        var head = tableCells(line).map(function (cell) { return '<th>' + inlineMd(cell) + '</th>'; });
        i += 2;
        var rows = [];
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') >= 0) {
          var cells = tableCells(lines[i]).map(function (cell) { return '<td>' + inlineMd(cell) + '</td>'; });
          rows.push('<tr>' + cells.join('') + '</tr>');
          i++;
        }
        i--;
        out.push('<div class="md-table"><table><thead><tr>' + head.join('') +
          '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>');
        continue;
      }

      para.push(line);
    }

    flushPara();
    return out.join('');
  }

  function bindMarkdown(root) {
    if (!root) return;

    var copies = root.querySelectorAll('.md-copy');
    for (var i = 0; i < copies.length; i++) {
      copies[i].addEventListener('click', function () {
        var code = this.parentNode.parentNode.querySelector('code');
        var text = code ? code.textContent : '';
        copyText(text).then(function () { flash(this, 'copied'); }.bind(this))
          .catch(function () { flash(this, 'failed'); }.bind(this));
      });
    }

    var links = root.querySelectorAll('a[data-ext="link"]');
    for (var j = 0; j < links.length; j++) {
      links[j].addEventListener('click', function (e) {
        e.preventDefault();
        openExternal(this.getAttribute('href'));
      });
    }
  }

  /* --------------------------------------------------------------- storage */

  function emptyStore() {
    return {
      version: STORE_VERSION,
      apiKey: '',
      model: DEFAULT_MODEL,
      models: [],
      modelsAt: 0,
      conversations: [],
      activeId: '',
      sidebarCollapsed: false
    };
  }

  function cleanConversation(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var id = String(raw.id || '');
    if (!id) return null;
    var messages = [];
    var list = Array.isArray(raw.messages) ? raw.messages : [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : '';
      if (!role) continue;
      var content = typeof m.content === 'string' ? m.content : '';
      if (!content && role === 'user') continue;
      messages.push({
        id: String(m.id || newId()),
        role: role,
        content: content,
        ts: Number(m.ts) || Date.now()
      });
    }
    return {
      id: id,
      title: String(raw.title || 'New chat').slice(0, 120),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
      model: String(raw.model || ''),
      messages: messages
    };
  }

  function cleanStore(raw) {
    var out = emptyStore();
    if (!raw || typeof raw !== 'object') return out;

    out.model = String(raw.model || DEFAULT_MODEL);
    out.models = (Array.isArray(raw.models) ? raw.models : []).filter(function (m) {
      return m && typeof m.id === 'string' && m.id;
    }).map(function (m) {
      return { id: m.id, context: Number(m.context) || 0 };
    });
    out.modelsAt = Number(raw.modelsAt) || 0;
    out.sidebarCollapsed = !!raw.sidebarCollapsed;

    var list = Array.isArray(raw.conversations) ? raw.conversations : [];
    for (var i = 0; i < list.length; i++) {
      var conv = cleanConversation(list[i]);
      if (conv) out.conversations.push(conv);
    }
    out.activeId = String(raw.activeId || '');
    if (!out.conversations.some(function (c) { return c.id === out.activeId; })) out.activeId = '';

    var key = String(raw.apiKey || '');
    try {
      out.apiKey = typeof Config !== 'undefined' && Config.ok ? Config.decodeSecret(key) : key;
    } catch (e) { out.apiKey = ''; }

    return out;
  }

  function loadStore() {
    canPersist = typeof NODE !== 'undefined' && NODE.ok &&
      typeof Config !== 'undefined' && Config.ok;
    if (!canPersist) return emptyStore();

    /* chat.js can boot before app.js calls Config.load(), so the data
       directory may not exist yet when the first save happens. */
    try { Config.ensureDirs(); } catch (e) { /* save reports the failure */ }

    chatFile = NODE.path.join(Config.DATA_DIR, 'chat.json');
    var fallback = emptyStore();
    try {
      if (!NODE.fs.existsSync(chatFile)) return fallback;
      var raw = JSON.parse(NODE.fs.readFileSync(chatFile, 'utf8'));
      return cleanStore(raw);
    } catch (e) {
      return fallback;
    }
  }

  function serializeStore() {
    var conversations = store.conversations.map(function (c) {
      return {
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        model: c.model,
        messages: c.messages.map(function (m) {
          return { id: m.id, role: m.role, content: m.content, ts: m.ts };
        })
      };
    });

    var key = store.apiKey || '';
    try {
      if (typeof Config !== 'undefined' && Config.ok) key = Config.encodeSecret(key);
    } catch (e) { /* store plain only if Config vanished mid-session */ }

    return {
      version: STORE_VERSION,
      apiKey: key,
      model: store.model,
      models: store.models,
      modelsAt: store.modelsAt,
      conversations: conversations,
      activeId: store.activeId,
      sidebarCollapsed: !!S.sideCollapsed
    };
  }

  function saveNow() {
    saveTimer = 0;
    if (!canPersist || !chatFile) return;
    try {
      NODE.fs.writeFileSync(chatFile, JSON.stringify(serializeStore(), null, 2), 'utf8');
    } catch (e) {
      if (!S.saveWarned) {
        S.saveWarned = true;
        setConn('error', 'Chat history could not be saved.');
      }
    }
  }

  function saveSoon() {
    if (!canPersist) return;
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 250);
  }

  /* ----------------------------------------------------------------- model */

  function availableModels() {
    return S.models.length ? S.models : FALLBACK_MODELS;
  }

  function modelLabel(model) {
    var id = String(model && model.id || model || '');
    var context = model && model.context;
    if (!context) {
      for (var i = 0; i < S.models.length; i++) {
        if (S.models[i].id === id) { context = S.models[i].context; break; }
      }
    }
    if (context) {
      var k = Math.round(context / 1000);
      return id + ' · ' + k + 'k';
    }
    return id;
  }

  function currentModel() {
    if (S.conv && S.conv.model) return S.conv.model;
    if (store && store.model) return store.model;
    var list = availableModels();
    return list.length ? list[0].id : DEFAULT_MODEL;
  }

  function populateModelSelect() {
    if (!els.chatModel) return;
    var models = availableModels();
    var active = currentModel();
    els.chatModel.innerHTML = '';
    var found = false;

    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = modelLabel(m);
      els.chatModel.appendChild(opt);
      if (m.id === active) found = true;
    });

    if (active && !found) {
      var extra = document.createElement('option');
      extra.value = active;
      extra.textContent = active + ' (not listed)';
      els.chatModel.appendChild(extra);
    }
    els.chatModel.value = active;
  }

  function updateHeader() {
    if (!els.chatTitle) return;
    els.chatTitle.textContent = S.conv ? S.conv.title : 'OpenCaption AI';
    els.chatSub.textContent = 'Groq · ' + currentModel();
    var welcomeModel = els.chatMessages && els.chatMessages.querySelector('.chat-welcome-model');
    if (welcomeModel) welcomeModel.textContent = currentModel();
  }

  function setModel(id) {
    if (!id) return;
    if (S.conv) {
      S.conv.model = id;
      S.conv.updatedAt = Date.now();
    }
    store.model = id;
    saveSoon();
    if (els.chatModel) els.chatModel.value = id;
    updateHeader();
  }

  /* -------------------------------------------------------------- connection */

  var CONN_TEXT = {
    off: 'Not connected',
    saved: 'Key saved',
    connecting: 'Connecting…',
    connected: 'Connected',
    invalid: 'Invalid API key',
    rate: 'Rate limited',
    network: 'Network error',
    model: 'Model unavailable',
    error: 'Connection error'
  };

  function setConn(kind, text) {
    S.conn = kind || 'off';
    S.connText = text || CONN_TEXT[S.conn] || CONN_TEXT.off;

    [els.chatStatusPill, els.chatConnState, els.chatSideStatus].forEach(function (el) {
      if (!el) return;
      el.classList.remove('state-off', 'state-saved', 'state-connecting', 'state-connected',
        'state-invalid', 'state-rate', 'state-network', 'state-model', 'state-error');
      el.classList.add('state-' + S.conn);
    });

    if (els.chatStatusPillText) els.chatStatusPillText.textContent = S.connText;
    if (els.chatStatusText) els.chatStatusText.textContent = S.connText;
    if (els.chatConnText) els.chatConnText.textContent = S.connText;
  }

  function keyFieldValue() {
    return els.chatApiKey ? els.chatApiKey.value.trim() : '';
  }

  function maskKeyField() {
    if (!els.chatApiKey) return;
    els.chatApiKey.type = 'password';
    if (els.chatToggleKey) els.chatToggleKey.textContent = 'show';
  }

  function syncKeyField() {
    if (!els.chatApiKey) return;
    els.chatApiKey.value = store.apiKey || '';
    maskKeyField();
  }

  function applyModels(models) {
    var clean = (Array.isArray(models) ? models : []).filter(function (m) {
      return m && m.id;
    });
    if (clean.length) {
      S.models = clean;
      store.models = clean;
      store.modelsAt = Date.now();
    } else if (!S.models.length) {
      S.models = FALLBACK_MODELS.slice();
      store.models = S.models;
    }

    var ids = S.models.map(function (m) { return m.id; });
    var active = currentModel();
    if (ids.indexOf(active) < 0) {
      var next = ids.indexOf(store.model) >= 0 ? store.model : ids[0];
      if (S.conv) S.conv.model = next;
      store.model = next;
    }

    populateModelSelect();
    updateHeader();
    saveSoon();
  }

  function handleConnFailure(res) {
    var kind = res && res.kind ? res.kind : 'error';
    if (kind === 'cancelled') return;
    var text = res && res.error ? res.error : (CONN_TEXT[kind] || CONN_TEXT.error);
    setConn(kind, text);
    S.verified = false;
    return text;
  }

  function verifyKey(key, opts) {
    opts = opts || {};
    if (!key) {
      setConn('off', 'Enter a Groq API key first.');
      return Promise.resolve({ ok: false, missing: true });
    }

    setConn('connecting');
    if (els.chatConnect) els.chatConnect.disabled = true;
    if (els.chatVerifyKey) els.chatVerifyKey.disabled = true;
    if (els.chatRefreshModels) els.chatRefreshModels.disabled = true;

    return Groq.verify(key).then(function (res) {
      if (res.ok) {
        S.verified = true;
        if (opts.save) {
          store.apiKey = key;
          saveSoon();
        }
        applyModels(res.models);
        setConn('connected', res.models.length
          ? 'Connected · ' + res.models.length + ' model(s)'
          : 'Connected');
      } else {
        handleConnFailure(res);
      }
      return res;
    }).catch(function (e) {
      var kind = Groq.classify(e);
      setConn(kind, e.message || CONN_TEXT[kind] || CONN_TEXT.error);
      return { ok: false, kind: kind, error: e.message };
    }).then(function (res) {
      maskKeyField();
      if (els.chatConnect) els.chatConnect.disabled = false;
      if (els.chatVerifyKey) els.chatVerifyKey.disabled = false;
      if (els.chatRefreshModels) els.chatRefreshModels.disabled = false;
      return res;
    });
  }

  function saveKey() {
    var key = keyFieldValue();
    store.apiKey = key;
    saveSoon();
    syncKeyField();
    S.verified = false;
    if (!key) {
      setConn('off', 'Key removed.');
      return;
    }
    setConn('saved', 'Key saved. Press Connect or Verify to test it.');
  }

  function connect() {
    var key = keyFieldValue();
    if (!key) {
      setConn('off', 'Paste a Groq API key first.');
      els.chatApiKey.focus();
      return;
    }
    verifyKey(key, { save: true });
  }

  function verifyOnly() {
    var key = keyFieldValue() || store.apiKey;
    if (!key) {
      setConn('off', 'Paste a Groq API key first.');
      els.chatApiKey.focus();
      return;
    }
    verifyKey(key, { save: false });
  }

  function refreshModels() {
    var key = store.apiKey || keyFieldValue();
    verifyKey(key, { save: false });
  }

  function disconnect() {
    stopGeneration();
    S.verified = false;
    setConn('off', 'Disconnected. The saved key is kept.');
  }

  function removeKey() {
    stopGeneration();
    store.apiKey = '';
    S.verified = false;
    saveNow();
    syncKeyField();
    setConn('off', 'No API key');
  }

  /* ------------------------------------------------------------------- views */

  function showChatView() {
    S.settings = false;
    if (els.chatChatView) els.chatChatView.classList.remove('hidden');
    if (els.chatSettingsView) els.chatSettingsView.classList.add('hidden');
    if (els.chatInput) els.chatInput.focus();
  }

  function openSettings() {
    S.settings = true;
    if (els.chatChatView) els.chatChatView.classList.add('hidden');
    if (els.chatSettingsView) els.chatSettingsView.classList.remove('hidden');
    syncKeyField();
    populateModelSelect();
    if (els.chatApiKey) els.chatApiKey.focus();
  }

  function applySidebar() {
    if (!els.chatShell) return;
    els.chatShell.classList.toggle('side-collapsed', !!S.sideCollapsed);
    if (els.chatSideShow) els.chatSideShow.classList.toggle('hidden', !S.sideCollapsed);
    if (els.chatSideToggle) {
      els.chatSideToggle.title = S.sideCollapsed ? 'Show conversations' : 'Hide conversations';
    }
    store.sidebarCollapsed = !!S.sideCollapsed;
    saveSoon();
  }

  /* Below 480px the sidebar is a drawer over the chat, not a column beside
     it. Leaving it open hides the messages and blocks their clicks, so it
     closes itself as soon as the user picks something. */
  function isNarrow() {
    try { return window.innerWidth <= 480; } catch (e) { return false; }
  }

  function collapseSidebar() {
    if (!isNarrow() || S.sideCollapsed) return;
    S.sideCollapsed = true;
    applySidebar();
  }

  /* --------------------------------------------------------------- messages */

  function renderWelcome() {
    if (!els.chatMessages) return;
    var suggestions = [
      { label: 'Explain something to me', prompt: 'Explain this to me: ' },
      { label: 'Write or improve some code', prompt: 'Help me write or improve this code:\n' },
      { label: 'Help me brainstorm ideas', prompt: 'Help me brainstorm ideas for ' },
      { label: 'Summarize text', prompt: 'Summarize this text:\n' },
      { label: 'Answer a technical question', prompt: 'Answer this technical question: ' }
    ];

    els.chatMessages.innerHTML =
      '<div class="chat-welcome">' +
        '<div class="chat-welcome-mark">AI</div>' +
        '<h2>OpenCaption AI</h2>' +
        '<p class="chat-welcome-copy">Ask about Premiere, captions, code, writing, or anything else. ' +
        'Caption settings stay exactly where you left them.</p>' +
        '<div class="chat-suggestions"></div>' +
        '<p class="chat-welcome-foot">Powered by <strong>Groq</strong> · ' +
        '<span class="chat-welcome-model">' + escapeHtml(currentModel()) + '</span></p>' +
      '</div>';

    var holder = els.chatMessages.querySelector('.chat-suggestions');
    suggestions.forEach(function (s) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chat-suggestion';
      btn.textContent = s.label;
      btn.addEventListener('click', function () {
        showChatView();
        collapseSidebar();
        els.chatInput.value = s.prompt;
        autoGrow();
        updateSendState();
        els.chatInput.focus();
        els.chatInput.setSelectionRange(els.chatInput.value.length, els.chatInput.value.length);
      });
      holder.appendChild(btn);
    });
  }

  function addActions(el, msg, canRegenerate) {
    var actions = el.querySelector('.msg-actions');
    if (!actions) return;
    actions.innerHTML = '';

    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'msg-action';
    copy.textContent = 'copy';
    copy.addEventListener('click', function () {
      copyText(msg.content).then(function () { flash(copy, 'copied'); })
        .catch(function () { flash(copy, 'failed'); });
    });
    actions.appendChild(copy);

    if (canRegenerate) {
      var again = document.createElement('button');
      again.type = 'button';
      again.className = 'msg-action';
      again.textContent = 'regenerate';
      again.addEventListener('click', function () { regenerate(); });
      actions.appendChild(again);
    }

    var time = document.createElement('time');
    time.textContent = timeLabel(msg.ts);
    actions.appendChild(time);
  }

  function renderMessage(msg, canRegenerate, streaming) {
    var root = document.createElement('div');
    root.className = 'msg ' + (msg.role === 'user' ? 'msg-user' : 'msg-ai');
    if (msg.id) root.setAttribute('data-msg', msg.id);

    if (msg.role === 'user') {
      root.innerHTML = '<div class="msg-col"><div class="msg-bubble"></div>' +
        '<div class="msg-actions"></div></div>';
      var text = root.querySelector('.msg-bubble');
      text.textContent = msg.content;
      addActions(root, msg, false);
      return root;
    }

    root.innerHTML = '<div class="msg-avatar" aria-hidden="true">AI</div>' +
      '<div class="msg-col"><div class="msg-bubble md" data-bubble></div>' +
      '<div class="msg-actions"></div></div>';

    var bubble = root.querySelector('[data-bubble]');
    if (streaming) {
      bubble.classList.add('streaming');
      bubble.textContent = msg.content || '';
    } else {
      bubble.innerHTML = renderMarkdown(msg.content);
      bindMarkdown(bubble);
      addActions(root, msg, canRegenerate);
    }
    return root;
  }

  function isLastAssistant(conv, index) {
    for (var i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant' && conv.messages[i].content) return i === index;
    }
    return false;
  }

  function renderConversation(conv) {
    if (!els.chatMessages) return;
    els.chatMessages.innerHTML = '';
    if (!conv || !conv.messages.length) {
      renderWelcome();
      updateHeader();
      return;
    }

    for (var i = 0; i < conv.messages.length; i++) {
      var msg = conv.messages[i];
      if (!msg.content && msg.role === 'assistant') continue;
      els.chatMessages.appendChild(renderMessage(msg, isLastAssistant(conv, i), false));
    }
    updateHeader();
    scrollBottom();
  }

  function notice(text, kind) {
    if (!els.chatMessages) return;
    var el = document.createElement('div');
    el.className = 'msg-note ' + (kind ? 'note-' + kind : '');
    el.textContent = text;
    els.chatMessages.appendChild(el);
    scrollBottom();
  }

  function finalizeAssistant(el, msg, canRegenerate) {
    if (!el || !el.parentNode) return;
    var bubble = el.querySelector('[data-bubble]');
    if (!bubble) return;
    bubble.classList.remove('streaming');
    bubble.innerHTML = renderMarkdown(msg.content);
    bindMarkdown(bubble);
    addActions(el, msg, canRegenerate);
  }

  function streamBubble() {
    if (!S.run || !S.run.el) return null;
    return S.run.el.querySelector('[data-bubble]');
  }

  /* ---------------------------------------------------------- conversations */

  function conversationById(id) {
    for (var i = 0; i < store.conversations.length; i++) {
      if (store.conversations[i].id === id) return store.conversations[i];
    }
    return null;
  }

  function titleFrom(text) {
    var clean = String(text || '')
      .replace(/```[\s\S]*?```/g, ' code ')
      .replace(/[#>*_`~\[\]()]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return 'New chat';
    return clean.length > 48 ? clean.slice(0, 48) + '…' : clean;
  }

  function ensureConversation() {
    if (S.conv) return S.conv;
    var conv = {
      id: newId('c'),
      title: 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      model: currentModel(),
      messages: []
    };
    S.conv = conv;
    store.conversations.unshift(conv);
    store.activeId = conv.id;
    saveSoon();
    renderList();
    updateHeader();
    return conv;
  }

  function renderList() {
    if (!els.chatList) return;
    var query = els.chatSearch ? els.chatSearch.value.trim().toLowerCase() : '';
    var list = store.conversations.filter(function (c) {
      if (!query) return true;
      if (String(c.title || '').toLowerCase().indexOf(query) >= 0) return true;
      return c.messages.some(function (m) {
        return String(m.content || '').toLowerCase().indexOf(query) >= 0;
      });
    });

    els.chatList.innerHTML = '';
    if (!list.length) {
      var empty = document.createElement('div');
      empty.className = 'chat-list-empty';
      empty.textContent = query ? 'No matching chats' : 'No chats yet';
      els.chatList.appendChild(empty);
      return;
    }

    list.forEach(function (conv) {
      var item = document.createElement('div');
      item.className = 'chat-item' + (S.conv && S.conv.id === conv.id ? ' active' : '');
      item.setAttribute('role', 'button');
      item.tabIndex = 0;
      item.setAttribute('data-id', conv.id);
      item.title = conv.title;

      var title = document.createElement('span');
      title.className = 'chat-item-title';
      title.textContent = conv.title;
      item.appendChild(title);

      var when = document.createElement('span');
      when.className = 'chat-item-date';
      when.textContent = dayLabel(conv.updatedAt);
      item.appendChild(when);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'chat-item-del';
      del.title = 'Delete this chat';
      del.setAttribute('aria-label', 'Delete ' + conv.title);
      del.textContent = '×';
      item.appendChild(del);

      item.addEventListener('click', function (e) {
        if (e.target && e.target.classList.contains('chat-item-del')) {
          e.stopPropagation();
          deleteConversation(conv.id);
          return;
        }
        selectConversation(conv.id);
      });
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectConversation(conv.id);
        }
      });

      els.chatList.appendChild(item);
    });
  }

  function selectConversation(id) {
    if (S.generating) stopGeneration();
    var conv = conversationById(id);
    if (!conv) return;
    S.conv = conv;
    store.activeId = conv.id;
    if (conv.model) {
      store.model = conv.model;
      if (els.chatModel) els.chatModel.value = conv.model;
    }
    saveSoon();
    renderList();
    renderConversation(conv);
    showChatView();
    collapseSidebar();
    updateHeader();
    renderWelcomeModel();
  }

  function renderWelcomeModel() {
    var el = els.chatMessages && els.chatMessages.querySelector('.chat-welcome-model');
    if (el) el.textContent = currentModel();
  }

  function newChat() {
    if (S.generating) stopGeneration();
    S.conv = null;
    store.activeId = '';
    saveSoon();
    renderList();
    renderWelcome();
    showChatView();
    collapseSidebar();
    updateHeader();
    renderWelcomeModel();
    scrollBottom();
    els.chatInput.focus();
  }

  function deleteConversation(id) {
    var conv = conversationById(id);
    if (!conv) return;
    if (!window.confirm('Delete "' + conv.title + '"? This cannot be undone.')) return;

    if (S.generating && S.conv && S.conv.id === id) stopGeneration();
    store.conversations = store.conversations.filter(function (c) { return c.id !== id; });
    if (store.activeId === id) store.activeId = '';
    if (S.conv && S.conv.id === id) {
      S.conv = null;
      renderWelcome();
      updateHeader();
    }
    saveSoon();
    renderList();
  }

  function clearAll() {
    if (!store.conversations.length) {
      notice('There is no chat history to clear.', 'info');
      return;
    }
    if (!window.confirm('Delete every AI Chat conversation? This cannot be undone. ' +
      'Your Groq key and caption settings are kept.')) return;

    stopGeneration();
    store.conversations = [];
    store.activeId = '';
    S.conv = null;
    saveNow();
    renderList();
    renderWelcome();
    updateHeader();
    showChatView();
  }

  /* ---------------------------------------------------------------- sending */

  function updateSendState() {
    if (!els.chatSend) return;
    var empty = !els.chatInput.value.trim();
    els.chatSend.disabled = S.generating || empty;
    if (els.chatStop) els.chatStop.classList.toggle('hidden', !S.generating);
  }

  function autoGrow() {
    if (!els.chatInput) return;
    els.chatInput.style.height = 'auto';
    els.chatInput.style.height = Math.min(140, els.chatInput.scrollHeight) + 'px';
  }

  function buildMessages(conv) {
    var history = conv.messages.filter(function (m) {
      return (m.role === 'user' || m.role === 'assistant') && m.content;
    });

    var picked = [];
    var chars = 0;
    for (var i = history.length - 1; i >= 0 && picked.length < MAX_HISTORY_MESSAGES; i--) {
      var content = history[i].content;
      if (chars + content.length > MAX_HISTORY_CHARS && picked.length) break;
      chars += content.length;
      picked.unshift(history[i]);
    }
    if (!picked.length && history.length) picked = [history[history.length - 1]];

    var messages = [{ role: 'system', content: SYSTEM_PROMPT }];
    picked.forEach(function (m) {
      messages.push({ role: m.role, content: m.content });
    });
    return messages;
  }

  function setGenerating(on) {
    S.generating = on;
    if (els.chatStop) {
      els.chatStop.classList.toggle('hidden', !on);
      els.chatStop.disabled = false;
      els.chatStop.textContent = 'Stop';
    }
    if (els.chatMessages) els.chatMessages.classList.toggle('generating', on);
    updateSendState();
  }

  function sendCurrent() {
    if (S.generating) return;
    var text = els.chatInput ? els.chatInput.value.trim() : '';
    if (!text) return;

    if (!store.apiKey) {
      showChatView();
      notice('Connect a Groq API key before sending a message.', 'warn');
      openSettings();
      return;
    }
    if (!currentModel()) {
      notice('Choose a Groq model in Settings first.', 'warn');
      openSettings();
      return;
    }

    var conv = ensureConversation();
    if (!conv.title || conv.title === 'New chat') conv.title = titleFrom(text);

    var message = { id: newId(), role: 'user', content: text, ts: Date.now() };
    conv.messages.push(message);
    conv.updatedAt = Date.now();

    els.chatInput.value = '';
    autoGrow();
    updateSendState();
    saveSoon();
    renderList();
    renderConversation(conv);
    startCompletion(conv);
  }

  function startCompletion(conv) {
    if (S.generating) return;
    if (!conv.messages.some(function (m) { return m.role === 'user' && m.content; })) return;

    var assistant = { id: newId(), role: 'assistant', content: '', ts: Date.now() };
    conv.messages.push(assistant);

    var el = renderMessage(assistant, false, true);
    els.chatMessages.appendChild(el);
    scrollBottom();

    S.run = {
      token: { cancelled: false },
      conv: conv,
      assistant: assistant,
      el: el,
      got: false,
      settled: false
    };

    setGenerating(true);
    perform(S.run, buildMessages(conv), false);
  }

  function onDelta(run, full) {
    run.got = true;
    run.assistant.content = full;
    var bubble = streamBubble();
    if (bubble) {
      bubble.textContent = full;
      scrollBottom();
    }
  }

  function finishRun(run) {
    if (!run || run.settled) return;
    run.settled = true;
    if (S.run === run) S.run = null;
    setGenerating(false);
    if (els.chatInput) els.chatInput.focus();
  }

  function finishSuccess(run, result) {
    if (run.settled) return;
    if (!result || !String(result.text || '').trim()) {
      finishEmpty(run);
      return;
    }
    run.assistant.content = result.text;
    run.assistant.ts = Date.now();
    run.conv.updatedAt = Date.now();
    finalizeAssistant(run.el, run.assistant, true);
    saveNow();
    renderList();
    updateHeader();
    finishRun(run);
    scrollBottom();
  }

  function finishEmpty(run) {
    var at = run.conv.messages.indexOf(run.assistant);
    if (at >= 0) run.conv.messages.splice(at, 1);
    if (run.el && run.el.parentNode) run.el.parentNode.removeChild(run.el);
    notice('The model returned an empty response. Try again or pick another model.', 'err');
    saveSoon();
    finishRun(run);
  }

  function finishError(run, err) {
    if (run.settled) return;
    var kind = Groq.classify(err);
    var message = (err && err.message) ? err.message : 'The request failed.';

    if (run.token.cancelled || kind === 'cancelled') {
      finishAborted(run);
      return;
    }

    if (run.assistant.content.trim()) {
      finalizeAssistant(run.el, run.assistant, true);
      notice('Response interrupted: ' + message, 'err');
      run.conv.updatedAt = Date.now();
      saveSoon();
      renderList();
    } else {
      var at = run.conv.messages.indexOf(run.assistant);
      if (at >= 0) run.conv.messages.splice(at, 1);
      if (run.el && run.el.parentNode) run.el.parentNode.removeChild(run.el);
      notice(message, kind === 'invalid' || kind === 'rate' ? 'warn' : 'err');
    }

    if (kind === 'invalid' || kind === 'rate' || kind === 'model' || kind === 'network') {
      setConn(kind, message);
    }
    finishRun(run);
  }

  function finishAborted(run) {
    if (run.settled) return;
    if (run.assistant.content.trim()) {
      finalizeAssistant(run.el, run.assistant, true);
      notice('Stopped. The partial response is kept.', 'info');
      run.conv.updatedAt = Date.now();
      saveSoon();
      renderList();
    } else {
      var at = run.conv.messages.indexOf(run.assistant);
      if (at >= 0) run.conv.messages.splice(at, 1);
      if (run.el && run.el.parentNode) run.el.parentNode.removeChild(run.el);
      notice('Stopped before the model replied.', 'info');
    }
    finishRun(run);
  }

  function perform(run, messages, fallbackUsed) {
    var model = run.conv.model || currentModel();
    var handlers = {
      token: run.token,
      onDelta: function (_, full) { onDelta(run, full); }
    };

    Groq.streamChat(store.apiKey, model, messages, handlers).then(function (result) {
      finishSuccess(run, result);
    }).catch(function (err) {
      if (run.settled) return;
      if (run.token.cancelled) { finishAborted(run); return; }

      var kind = Groq.classify(err);
      var canFallback = !fallbackUsed && !run.got &&
        (kind === 'network' || kind === 'error');

      if (!canFallback) {
        finishError(run, err);
        return;
      }

      notice('Streaming was interrupted — retrying without streaming…', 'info');
      Groq.completeChat(store.apiKey, model, messages, handlers).then(function (result) {
        finishSuccess(run, result);
      }).catch(function (err2) {
        finishError(run, err2);
      });
    });
  }

  function stopGeneration() {
    if (!S.run) return;
    S.run.token.cancelled = true;
    Groq.cancel(S.run.token);
    if (els.chatStop) {
      els.chatStop.disabled = true;
      els.chatStop.textContent = 'Stopping…';
    }
  }

  function regenerate() {
    if (S.generating || !S.conv) return;
    var conv = S.conv;
    var at = -1;
    for (var i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant') { at = i; break; }
    }
    if (at < 0) return;

    conv.messages.splice(at, 1);
    saveSoon();
    renderConversation(conv);
    startCompletion(conv);
  }

  /* -------------------------------------------------------------------- open */

  function open() {
    if (!S.booted) return;
    els.chatShell.classList.remove('hidden');
    els.chatShell.setAttribute('aria-hidden', 'false');
    S.open = true;
    if (isNarrow()) S.sideCollapsed = true;
    applySidebar();

    if (!store.apiKey) {
      setConn('off', 'No API key');
    } else if (!S.verified && !S.generating) {
      verifyKey(store.apiKey, { save: false });
    }

    if (!S.generating) {
      if (S.conv) renderConversation(S.conv);
      else renderWelcome();
    }
    updateHeader();
    renderWelcomeModel();
    scrollBottom();
    setTimeout(function () { if (els.chatInput) els.chatInput.focus(); }, 40);
  }

  function close() {
    if (!S.booted) return;
    els.chatShell.classList.add('hidden');
    els.chatShell.setAttribute('aria-hidden', 'true');
    S.open = false;
    if (els.chatLaunch) els.chatLaunch.focus();
  }

  function isOpen() { return S.open; }

  /* ------------------------------------------------------------------- bind */

  function bind() {
    if (els.chatLaunch) els.chatLaunch.addEventListener('click', open);
    if (els.chatClose) els.chatClose.addEventListener('click', close);
    if (els.chatNew) els.chatNew.addEventListener('click', newChat);
    if (els.chatSettingsBtn) els.chatSettingsBtn.addEventListener('click', function () {
      if (S.settings) showChatView();
      else openSettings();
    });
    if (els.chatSettingsOpen) els.chatSettingsOpen.addEventListener('click', openSettings);
    if (els.chatSettingsBack) els.chatSettingsBack.addEventListener('click', showChatView);
    if (els.chatSideToggle) els.chatSideToggle.addEventListener('click', function () {
      S.sideCollapsed = true;
      applySidebar();
    });
    if (els.chatSideShow) els.chatSideShow.addEventListener('click', function () {
      S.sideCollapsed = false;
      applySidebar();
    });

    /* Tapping the visible chat area dismisses the narrow-layout drawer. */
    if (els.chatChatView) els.chatChatView.addEventListener('mousedown', function () {
      collapseSidebar();
    });

    if (els.chatSearch) els.chatSearch.addEventListener('input', renderList);
    if (els.chatClearAll) els.chatClearAll.addEventListener('click', clearAll);

    if (els.chatSaveKey) els.chatSaveKey.addEventListener('click', saveKey);
    if (els.chatConnect) els.chatConnect.addEventListener('click', connect);
    if (els.chatVerifyKey) els.chatVerifyKey.addEventListener('click', verifyOnly);
    if (els.chatDisconnect) els.chatDisconnect.addEventListener('click', disconnect);
    if (els.chatRemoveKey) els.chatRemoveKey.addEventListener('click', removeKey);
    if (els.chatRefreshModels) els.chatRefreshModels.addEventListener('click', refreshModels);

    if (els.chatToggleKey) els.chatToggleKey.addEventListener('click', function () {
      var showing = els.chatApiKey.type === 'text';
      els.chatApiKey.type = showing ? 'password' : 'text';
      els.chatToggleKey.textContent = showing ? 'show' : 'hide';
    });

    if (els.chatModel) els.chatModel.addEventListener('change', function () {
      setModel(els.chatModel.value);
    });

    if (els.chatSend) els.chatSend.addEventListener('click', sendCurrent);
    if (els.chatStop) els.chatStop.addEventListener('click', stopGeneration);
    if (els.chatInput) {
      els.chatInput.addEventListener('input', function () {
        autoGrow();
        updateSendState();
      });
      els.chatInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
        e.preventDefault();
        sendCurrent();
      });
    }

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !S.open) return;
      e.preventDefault();
      e.stopPropagation();
      if (S.settings) showChatView();
      else close();
    }, true);
  }

  /* ------------------------------------------------------------------- boot */

  function init() {
    if (S.booted) return;

    var ids = ['chatLaunch', 'chatShell', 'chatSide', 'chatSideToggle', 'chatSideShow',
      'chatNew', 'chatSearch', 'chatList', 'chatStatusText', 'chatSettingsBtn', 'chatClearAll',
      'chatSideStatus',
      'chatTop', 'chatTitle', 'chatSub', 'chatStatusPill', 'chatStatusPillText',
      'chatSettingsOpen', 'chatClose', 'chatMessages', 'chatInput', 'chatSend', 'chatStop',
      'chatChatView', 'chatSettingsView', 'chatSettingsBack', 'chatApiKey', 'chatToggleKey',
      'chatSaveKey', 'chatConnect', 'chatVerifyKey', 'chatDisconnect', 'chatRemoveKey',
      'chatConnState', 'chatConnText', 'chatModel', 'chatRefreshModels', 'chatModelHint'];

    ids.forEach(function (id) { els[id] = $(id); });
    if (!els.chatShell || !els.chatMessages) return;

    try { cs = new CSInterface(); } catch (e) { cs = null; }

    store = loadStore();
    S.models = store.models.length ? store.models : FALLBACK_MODELS.slice();
    S.sideCollapsed = !!store.sidebarCollapsed;
    if (store.activeId) S.conv = conversationById(store.activeId);

    if (typeof Groq === 'undefined' || !Groq.ok) {
      setConn('error', (typeof Groq !== 'undefined' && Groq.error) || 'AI Chat is unavailable.');
      if (els.chatSend) els.chatSend.disabled = true;
    } else if (!store.apiKey) {
      setConn('off', 'No API key');
    } else {
      setConn('saved', 'Key saved — press Connect to test it.');
    }

    populateModelSelect();
    syncKeyField();
    applySidebar();
    bind();
    renderList();

    if (S.conv) renderConversation(S.conv);
    else renderWelcome();

    updateHeader();
    updateSendState();
    autoGrow();
    S.booted = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    init: init,
    open: open,
    close: close,
    isOpen: isOpen,
    _renderMarkdown: renderMarkdown,
    _titleFrom: titleFrom,
    _modelLabel: modelLabel,
    _buildMessages: buildMessages,
    _store: function () { return store; },
    _state: function () { return S; },
    _save: saveNow,
    _loadStore: loadStore
  };
})();
