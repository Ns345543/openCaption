/*
 * chat.js — openCaption AI Chat.
 *
 * A separate full-panel overlay, opened from the header icon. It is
 * deliberately independent of the caption pipeline: its own provider keys, its
 * own models, its own history file (%APPDATA%\CaptionAI\chat.json). Nothing here
 * reads or writes the Gemini settings in config.json, so the chat's Gemini key
 * and the caption generator's Gemini key never touch each other.
 *
 * Keys are obfuscated with the same local XOR scheme as the caption key. That is
 * not encryption; anyone with access to the Windows account can recover them.
 * Each key is sent only to its own provider and is scrubbed from every error
 * message.
 */
var Chat = (function () {
  'use strict';

  var STORE_VERSION = 2;
  var PROVIDER_ORDER = ['gemini', 'openai', 'anthropic', 'xai', 'deepseek', 'moonshot', 'groq'];
  var LEGACY_PROVIDER = 'groq';
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
    executingPlan: null,
    conv: null,
    provider: LEGACY_PROVIDER,
    conns: {},
    verified: {},
    checking: {},
    sideCollapsed: false,
    saveWarned: false,
    menuOpen: false,
    openCard: ''
  };

  var els = {};
  var cardEls = {};
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

  function bindExternalLinks(root) {
    if (!root) return;
    var links = root.querySelectorAll('a[data-ext="link"]');
    for (var i = 0; i < links.length; i++) {
      links[i].addEventListener('click', function (e) {
        e.preventDefault();
        openExternal(this.getAttribute('href'));
      });
    }
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

  /* ------------------------------------------------------------ providers */

  function validProvider(id) {
    return PROVIDER_ORDER.indexOf(String(id || '')) >= 0;
  }

  function provById(id) {
    if (typeof Providers === 'undefined' || !Providers) return null;
    return Providers.get(id);
  }

  function providerName(id) {
    var p = provById(id);
    return p ? p.name : String(id || 'Provider');
  }

  function emptyProvider() {
    return { apiKey: '', model: '', models: [], modelsAt: 0 };
  }

  function provState(id) {
    if (!store.providers[id]) store.providers[id] = emptyProvider();
    return store.providers[id];
  }

  function cleanModels(list) {
    var out = [];
    var seen = {};
    var src = Array.isArray(list) ? list : [];
    for (var i = 0; i < src.length; i++) {
      var m = src[i] || {};
      var id = String(m.id || '');
      if (!id || seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, context: Number(m.context) || 0 });
    }
    return out;
  }

  function fallbackModels(id) {
    var p = provById(id);
    return p && p.fallbackModels ? cleanModels(p.fallbackModels) : [];
  }

  function providerModels(id) {
    var ps = provState(id);
    return ps.models.length ? ps.models : fallbackModels(id);
  }

  function modelContext(id, pid) {
    var list = providerModels(pid);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i].context;
    }
    return 0;
  }

  function modelLabel(model, pid) {
    var id = String(model && model.id || model || '');
    var context = model && model.context;
    if (!context) context = modelContext(id, pid || S.provider);
    if (context) {
      var k = Math.round(context / 1000);
      return id + ' · ' + k + 'k';
    }
    return id;
  }

  function currentModel() {
    if (S.conv && S.conv.provider === S.provider && S.conv.model) return S.conv.model;
    var ps = provState(S.provider);
    if (ps.model) return ps.model;
    var list = providerModels(S.provider);
    return list.length ? list[0].id : '';
  }

  function setModel(id, pid) {
    id = String(id || '').trim();
    if (!id) return;
    pid = validProvider(pid) ? pid : S.provider;
    var ps = provState(pid);
    ps.model = id;
    if (pid === S.provider) {
      if (S.conv) {
        S.conv.provider = pid;
        S.conv.model = id;
        S.conv.updatedAt = Date.now();
      }
      populateModelSelect();
      updateHeader();
      updateSendState();
    }
    populateCardModels(pid);
    saveSoon();
  }

  function populateModelSelect() {
    if (!els.chatModel) return;
    var models = providerModels(S.provider);
    var active = currentModel();
    els.chatModel.innerHTML = '';
    var found = false;

    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = modelLabel(m, S.provider);
      els.chatModel.appendChild(opt);
      if (m.id === active) found = true;
    });

    if (!models.length) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'No models listed';
      els.chatModel.appendChild(empty);
    } else if (active && !found) {
      var extra = document.createElement('option');
      extra.value = active;
      extra.textContent = active + ' (not listed)';
      els.chatModel.appendChild(extra);
      found = true;
    }

    els.chatModel.value = found && active ? active : '';
    els.chatModel.disabled = !models.length;
    if (els.chatModelRefresh) {
      els.chatModelRefresh.disabled = !provState(S.provider).apiKey;
    }
  }

  function populateCardModels(pid) {
    var card = cardEls[pid];
    if (!card) return;
    var ps = provState(pid);
    var models = providerModels(pid);
    var active = ps.model || (models.length ? models[0].id : '');
    card.model.innerHTML = '';

    models.forEach(function (m) {
      var opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = modelLabel(m, pid);
      card.model.appendChild(opt);
    });

    if (active && !models.some(function (m) { return m.id === active; })) {
      var extra = document.createElement('option');
      extra.value = active;
      extra.textContent = active + ' (not listed)';
      card.model.appendChild(extra);
    }
    if (!models.length && !active) {
      var empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'No models listed';
      card.model.appendChild(empty);
    }

    card.model.value = active;
    card.model.disabled = !models.length;
    if (!ps.model && active) ps.model = active;

    if (card.modelHint) {
      var hint = ps.modelsAt
        ? ps.models.length + ' model(s) listed by ' + providerName(pid) + '.'
        : 'Using a built-in list until you connect.';
      if (ps.modelsAt && ps.models.length && ps.model &&
          !ps.models.some(function (m) { return m.id === ps.model; })) {
        hint += ' The selected model is not in the current list.';
      }
      card.modelHint.textContent = hint;
    }
  }

  function populateAllCardModels() {
    PROVIDER_ORDER.forEach(function (pid) { populateCardModels(pid); });
  }

  /* --------------------------------------------------------------- storage */

  function emptyStore() {
    return {
      version: STORE_VERSION,
      providers: {},
      conversations: [],
      activeId: '',
      activeProvider: LEGACY_PROVIDER,
      sidebarCollapsed: false
    };
  }

  function decodeKey(text) {
    try {
      return (typeof Config !== 'undefined' && Config.ok) ? Config.decodeSecret(text) : String(text || '');
    } catch (e) { return ''; }
  }

  function encodeKey(text) {
    if (!text) return '';
    try {
      /* Never fall back to plaintext: if the encoder is unavailable the key is
         simply not persisted, and the user can paste it again after restart. */
      return (typeof Config !== 'undefined' && Config.ok) ? Config.encodeSecret(text) : '';
    } catch (e) { return ''; }
  }

  function cleanProvider(raw) {
    var out = emptyProvider();
    if (!raw || typeof raw !== 'object') return out;
    out.apiKey = decodeKey(String(raw.apiKey || ''));
    out.model = String(raw.model || '');
    out.models = cleanModels(raw.models);
    out.modelsAt = Number(raw.modelsAt) || 0;
    return out;
  }

  function cleanUsage(raw) {
    if (!raw || typeof raw !== 'object') return null;
    var input = Number(raw.input) || 0;
    var output = Number(raw.output) || 0;
    var total = Number(raw.total) || (input + output);
    if (!input && !output && !total) return null;
    return { input: input, output: output, total: total };
  }

  function cleanAction(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof ActionValidator === 'undefined') return null;

    var checked = ActionValidator.validatePlan({
      kind: 'plan',
      title: raw.title,
      summary: raw.summary,
      steps: raw.steps
    });
    if (!checked.ok) return null;

    var status = raw.status;
    if (['pending', 'running', 'done', 'failed', 'cancelled'].indexOf(status) === -1) status = 'pending';
    var interrupted = status === 'running';
    if (interrupted) status = 'failed';

    var warnings = checked.warnings.slice();
    if (Array.isArray(raw.warnings)) {
      for (var w = 0; w < raw.warnings.length && w < 20; w++) {
        var text = typeof raw.warnings[w] === 'string' ? raw.warnings[w].slice(0, 400) : '';
        if (text && warnings.indexOf(text) === -1) warnings.push(text);
      }
    }

    var results = [];
    if (Array.isArray(raw.results)) {
      for (var r = 0; r < raw.results.length && r < checked.plan.steps.length; r++) {
        var item = raw.results[r];
        if (!item || typeof item !== 'object') continue;
        var index = Number(item.index);
        if (!isFinite(index) || index < 0 || index >= checked.plan.steps.length) continue;
        results.push({
          index: index,
          action: String(item.action || checked.plan.steps[index].action),
          label: String(item.label || ''),
          ok: !!item.ok,
          error: String(item.error || '').slice(0, 1000),
          result: item.result && typeof item.result === 'object' ? item.result : null,
          startedAt: Number(item.startedAt) || 0,
          finishedAt: Number(item.finishedAt) || 0
        });
      }
    }

    return {
      id: String(raw.id || newId('a')),
      title: checked.plan.title,
      summary: checked.plan.summary,
      steps: checked.plan.steps,
      status: status,
      warnings: warnings,
      results: results,
      error: interrupted ? 'The panel closed before this plan finished.' : String(raw.error || '').slice(0, 1200),
      createdAt: Number(raw.createdAt) || Date.now(),
      startedAt: Number(raw.startedAt) || 0,
      finishedAt: Number(raw.finishedAt) || 0
    };
  }

  function cleanConversation(raw, fallbackProvider, fallbackModel) {
    if (!raw || typeof raw !== 'object') return null;
    var id = String(raw.id || '');
    if (!id) return null;

    var convProvider = validProvider(raw.provider) ? raw.provider : '';
    var convModel = String(raw.model || fallbackModel || '');
    var list = Array.isArray(raw.messages) ? raw.messages : [];

    if (!convProvider) {
      for (var p = 0; p < list.length; p++) {
        if (list[p] && validProvider(list[p].provider)) { convProvider = list[p].provider; break; }
      }
    }
    if (!convProvider && fallbackProvider) convProvider = fallbackProvider;

    var messages = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : '';
      if (!role) continue;
      var content = typeof m.content === 'string' ? m.content : '';
      if (!content && role === 'user') continue;
      var message = {
        id: String(m.id || newId()),
        role: role,
        content: content,
        ts: Number(m.ts) || Date.now(),
        provider: validProvider(m.provider) ? m.provider : convProvider,
        model: String(m.model || (role === 'assistant' ? convModel : '')),
        reasoning: typeof m.reasoning === 'string' ? m.reasoning : '',
        usage: cleanUsage(m.usage),
        finishReason: String(m.finishReason || '')
      };
      if (m.local === true) message.local = true;
      var action = cleanAction(m.action);
      if (action) message.action = action;
      messages.push(message);
    }

    return {
      id: id,
      title: String(raw.title || 'New chat').slice(0, 120),
      createdAt: Number(raw.createdAt) || Date.now(),
      updatedAt: Number(raw.updatedAt) || Number(raw.createdAt) || Date.now(),
      provider: convProvider,
      model: convModel,
      messages: messages
    };
  }

  function cleanStore(raw) {
    var out = emptyStore();
    if (!raw || typeof raw !== 'object') return out;

    out.sidebarCollapsed = !!raw.sidebarCollapsed;

    var rawProviders = raw.providers && typeof raw.providers === 'object' ? raw.providers : null;
    var fallback = rawProviders ? '' : LEGACY_PROVIDER;
    var fallbackModel = rawProviders ? '' : String(raw.model || '');

    /* v1 stored a single Groq key/model at the top level. Move it into the
       provider map so the key and every old conversation survive the upgrade. */
    if (!rawProviders) {
      out.providers[LEGACY_PROVIDER] = emptyProvider();
      out.providers[LEGACY_PROVIDER].apiKey = decodeKey(String(raw.apiKey || ''));
      out.providers[LEGACY_PROVIDER].model = String(raw.model || '');
      out.providers[LEGACY_PROVIDER].models = cleanModels(raw.models);
      out.providers[LEGACY_PROVIDER].modelsAt = Number(raw.modelsAt) || 0;
    }

    for (var i = 0; i < PROVIDER_ORDER.length; i++) {
      var pid = PROVIDER_ORDER[i];
      if (rawProviders && rawProviders[pid]) out.providers[pid] = cleanProvider(rawProviders[pid]);
      else if (!out.providers[pid]) out.providers[pid] = emptyProvider();
    }

    /* A very old file could have both shapes; do not lose the Groq key. */
    if (rawProviders && raw.apiKey && !out.providers[LEGACY_PROVIDER].apiKey) {
      out.providers[LEGACY_PROVIDER].apiKey = decodeKey(String(raw.apiKey));
    }

    var conversations = Array.isArray(raw.conversations) ? raw.conversations : [];
    for (var c = 0; c < conversations.length; c++) {
      var conv = cleanConversation(conversations[c], fallback, fallbackModel);
      if (conv) out.conversations.push(conv);
    }

    out.activeId = String(raw.activeId || '');
    if (!out.conversations.some(function (x) { return x.id === out.activeId; })) out.activeId = '';

    if (validProvider(raw.activeProvider)) {
      out.activeProvider = raw.activeProvider;
    } else if (out.activeId) {
      var active = out.conversations.filter(function (x) { return x.id === out.activeId; })[0];
      out.activeProvider = active && active.provider ? active.provider : '';
    }
    if (!validProvider(out.activeProvider)) out.activeProvider = LEGACY_PROVIDER;

    return out;
  }

  function serializeAction(action) {
    return {
      id: action.id,
      title: action.title,
      summary: action.summary,
      steps: action.steps,
      status: action.status,
      warnings: action.warnings || [],
      results: action.results || [],
      error: action.error || '',
      createdAt: action.createdAt,
      startedAt: action.startedAt,
      finishedAt: action.finishedAt
    };
  }

  function serializeStore() {
    var providers = {};
    for (var i = 0; i < PROVIDER_ORDER.length; i++) {
      var pid = PROVIDER_ORDER[i];
      var ps = store.providers[pid] || emptyProvider();
      providers[pid] = {
        apiKey: ps.apiKey ? encodeKey(ps.apiKey) : '',
        model: ps.model,
        models: cleanModels(ps.models),
        modelsAt: ps.modelsAt
      };
    }

    var conversations = store.conversations.map(function (c) {
      return {
        id: c.id,
        title: c.title,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        provider: c.provider,
        model: c.model,
        messages: c.messages.map(function (m) {
          var out = {
            id: m.id,
            role: m.role,
            content: m.content,
            ts: m.ts,
            provider: m.provider || '',
            model: m.model || ''
          };
          if (m.reasoning) out.reasoning = m.reasoning;
          if (m.usage) out.usage = m.usage;
          if (m.finishReason) out.finishReason = m.finishReason;
          if (m.local) out.local = true;
          if (m.action) out.action = serializeAction(m.action);
          return out;
        })
      };
    });

    return {
      version: STORE_VERSION,
      providers: providers,
      conversations: conversations,
      activeId: store.activeId,
      activeProvider: store.activeProvider,
      sidebarCollapsed: !!S.sideCollapsed
    };
  }

  function loadStore() {
    canPersist = typeof NODE !== 'undefined' && NODE.ok &&
      typeof Config !== 'undefined' && Config.ok;
    if (!canPersist) return cleanStore(null);

    /* chat.js can boot before app.js calls Config.load(), so the data
       directory may not exist yet when the first save happens. */
    try { Config.ensureDirs(); } catch (e) { /* save reports the failure */ }

    chatFile = NODE.path.join(Config.DATA_DIR, 'chat.json');
    try {
      if (!NODE.fs.existsSync(chatFile)) return cleanStore(null);
      var raw = JSON.parse(NODE.fs.readFileSync(chatFile, 'utf8'));
      return cleanStore(raw);
    } catch (e) {
      return cleanStore(null);
    }
  }

  function saveNow() {
    saveTimer = 0;
    if (!canPersist || !chatFile) return;
    try {
      NODE.fs.writeFileSync(chatFile, JSON.stringify(serializeStore(), null, 2), 'utf8');
    } catch (e) {
      if (!S.saveWarned) {
        S.saveWarned = true;
        setConn(S.provider, 'error', 'Chat history could not be saved.');
      }
    }
  }

  function saveSoon() {
    if (!canPersist) return;
    if (saveTimer) return;
    saveTimer = setTimeout(saveNow, 250);
  }

  /* ----------------------------------------------------------- connection */

  var CONN_TEXT = {
    off: 'Not configured',
    saved: 'Key saved',
    connecting: 'Connecting…',
    connected: 'Connected',
    invalid: 'Invalid API key',
    rate: 'Rate limited',
    quota: 'No credits / quota',
    network: 'Network error',
    model: 'Model unavailable',
    service: 'Service unavailable',
    error: 'Connection error'
  };

  var STATE_CLASSES = ['off', 'saved', 'connecting', 'connected', 'invalid', 'rate',
    'quota', 'network', 'model', 'service', 'error'];

  function applyStateClass(el, kind) {
    if (!el) return;
    for (var i = 0; i < STATE_CLASSES.length; i++) el.classList.remove('state-' + STATE_CLASSES[i]);
    el.classList.add('state-' + (kind || 'off'));
  }

  function defaultConn(pid) {
    var ps = provState(pid);
    if (ps.apiKey) return { kind: 'saved', text: 'Key saved — test to connect' };
    return { kind: 'off', text: 'Not configured' };
  }

  function connOf(pid) {
    return S.conns[pid] || defaultConn(pid);
  }

  function setConn(pid, kind, text) {
    S.conns[pid] = {
      kind: kind || 'off',
      text: text || CONN_TEXT[kind] || CONN_TEXT.off
    };
    renderCardStatus(pid);
    renderProviderMenu();
    refreshPill();
    refreshConnectBanner();
    updateSendState();
  }

  function renderCardStatus(pid) {
    var card = cardEls[pid];
    if (!card) return;
    var conn = connOf(pid);
    applyStateClass(card.status, conn.kind);
    card.statusText.textContent = conn.text;
    card.status.title = conn.text;
    card.root.setAttribute('data-state', conn.kind);
  }

  function refreshPill() {
    var conn = connOf(S.provider);
    applyStateClass(els.chatStatusPill, conn.kind);
    applyStateClass(els.chatSideStatus, conn.kind);
    if (els.chatStatusPillText) els.chatStatusPillText.textContent = conn.text;
    if (els.chatStatusText) els.chatStatusText.textContent = conn.text;
  }

  function refreshConnectBanner() {
    if (!els.chatConnectBanner) return;
    var missing = !provState(S.provider).apiKey;
    els.chatConnectBanner.classList.toggle('hidden', !missing);
    if (missing) {
      if (els.chatConnectName) els.chatConnectName.textContent = providerName(S.provider);
      if (els.chatAdapterName) els.chatAdapterName.textContent = providerName(S.provider);
    }
  }

  function maskCard(pid) {
    var card = cardEls[pid];
    if (!card) return;
    card.key.type = 'password';
    card.toggle.textContent = 'show';
  }

  function syncCardKey(pid) {
    var card = cardEls[pid];
    if (!card) return;
    card.key.value = provState(pid).apiKey || '';
    maskCard(pid);
  }

  function setCardBusy(pid, busy) {
    var card = cardEls[pid];
    if (!card) return;
    card.root.classList.toggle('busy', !!busy);
    ['connect', 'test', 'save', 'remove', 'disconnect', 'refresh', 'useCustom'].forEach(function (key) {
      if (card[key]) card[key].disabled = !!busy;
    });
    if (card.model) card.model.disabled = !!busy || !providerModels(pid).length;
  }

  function handleConnFailure(pid, res) {
    var kind = res && res.kind ? res.kind : 'error';
    if (kind === 'cancelled') return;
    setConn(pid, kind, res && res.error ? res.error : (CONN_TEXT[kind] || CONN_TEXT.error));
  }

  function applyModels(pid, models) {
    var ps = provState(pid);
    var clean = cleanModels(models);
    var hadDiscovery = !!ps.modelsAt;
    if (clean.length) {
      ps.models = clean;
      ps.modelsAt = Date.now();
    } else if (!ps.models.length) {
      ps.models = fallbackModels(pid);
    }

    var ids = ps.models.map(function (m) { return m.id; });
    if (!ps.model && ids.length) ps.model = ids[0];
    else if (!hadDiscovery && clean.length && ids.indexOf(ps.model) < 0) {
      ps.model = ids[0];
    }

    if (S.conv && S.conv.provider === pid) {
      if (!S.conv.model) S.conv.model = ps.model;
      else if (!hadDiscovery && clean.length && ids.indexOf(S.conv.model) < 0) {
        S.conv.model = ps.model;
      }
    }

    populateModelSelect();
    populateCardModels(pid);
    updateHeader();
    updateSendState();
    saveSoon();
  }

  function verifyProvider(pid, key, opts) {
    opts = opts || {};
    if (!validProvider(pid)) return Promise.resolve({ ok: false, kind: 'error', error: 'Unknown provider.' });
    var p = provById(pid);
    if (!p) return Promise.resolve({ ok: false, kind: 'error', error: 'AI Chat is unavailable.' });

    if (!key) {
      setConn(pid, 'off', 'Paste an API key first.');
      openProviderSettings(pid);
      return Promise.resolve({ ok: false, missing: true });
    }
    if (S.checking[pid]) return S.checking[pid];

    setConn(pid, 'connecting', 'Connecting…');
    setCardBusy(pid, true);

    var promise = p.test(key).then(function (res) {
      if (res && res.ok) {
        S.verified[pid] = true;
        if (opts.save) {
          provState(pid).apiKey = key;
          saveSoon();
          syncCardKey(pid);
        }
        applyModels(pid, res.models);
        setConn(pid, 'connected', res.models && res.models.length
          ? 'Connected · ' + res.models.length + ' models'
          : 'Connected');
      } else {
        S.verified[pid] = false;
        handleConnFailure(pid, res);
      }
      return res;
    }).catch(function (e) {
      S.verified[pid] = false;
      var kind = (typeof Providers !== 'undefined' && Providers) ? Providers.classify(e) : 'error';
      setConn(pid, kind, (e && e.message) || ('Could not reach ' + p.name + '.'));
      return { ok: false, kind: kind, error: e && e.message };
    }).then(function (res) {
      maskCard(pid);
      setCardBusy(pid, false);
      delete S.checking[pid];
      return res;
    });

    S.checking[pid] = promise;
    return promise;
  }

  function saveProviderKey(pid) {
    var card = cardEls[pid];
    if (!card) return;
    var key = card.key.value.trim();
    var ps = provState(pid);
    ps.apiKey = key;
    S.verified[pid] = false;
    saveSoon();
    syncCardKey(pid);
    setConn(pid, key ? 'saved' : 'off',
      key ? 'Key saved. Press Connect to test it.' : 'No API key');
    populateModelSelect();
    updateSendState();
  }

  function removeProviderKey(pid) {
    var ps = provState(pid);
    if (!ps.apiKey) {
      setConn(pid, 'off', 'There is no saved key for ' + providerName(pid) + '.');
      return;
    }
    if (!window.confirm('Remove the saved ' + providerName(pid) + ' API key? ' +
      'Other providers and your chat history are kept.')) return;

    if (S.generating && S.run && S.run.provider === pid) stopGeneration();
    ps.apiKey = '';
    ps.models = [];
    ps.modelsAt = 0;
    S.verified[pid] = false;
    saveNow();
    syncCardKey(pid);
    setConn(pid, 'off', 'Key removed.');
    populateModelSelect();
    populateCardModels(pid);
    updateSendState();
  }

  function disconnectProvider(pid) {
    S.verified[pid] = false;
    setConn(pid, 'off', 'Disconnected. The saved key is kept.');
  }

  function connectProvider(pid) {
    var card = cardEls[pid];
    var ps = provState(pid);
    var key = card && card.key.value.trim() ? card.key.value.trim() : ps.apiKey;
    if (!key) {
      setConn(pid, 'off', 'Paste an API key first.');
      openProviderSettings(pid);
      return;
    }
    verifyProvider(pid, key, { save: true });
  }

  function testProvider(pid) {
    var card = cardEls[pid];
    var ps = provState(pid);
    var key = card && card.key.value.trim() ? card.key.value.trim() : ps.apiKey;
    if (!key) {
      setConn(pid, 'off', 'Paste an API key first.');
      openProviderSettings(pid);
      return;
    }
    verifyProvider(pid, key, { save: false });
  }

  function refreshProviderModels(pid) {
    var ps = provState(pid);
    var card = cardEls[pid];
    var key = (card && card.key.value.trim()) || ps.apiKey;
    if (!key) {
      setConn(pid, 'off', 'Paste an API key first.');
      openProviderSettings(pid);
      return;
    }
    verifyProvider(pid, key, { save: false });
  }

  /* -------------------------------------------------------------- provider ui */

  function renderProviderMenu() {
    if (!els.chatProviderMenu) return;
    els.chatProviderMenu.innerHTML = '';

    PROVIDER_ORDER.forEach(function (pid) {
      var p = provById(pid);
      if (!p) return;
      var conn = connOf(pid);

      var row = document.createElement('button');
      row.type = 'button';
      row.className = 'prov-item' + (pid === S.provider ? ' active' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', pid === S.provider ? 'true' : 'false');
      row.setAttribute('data-provider', pid);

      var mark = document.createElement('span');
      mark.className = 'prov-mark';
      mark.style.color = p.tint || '';
      mark.textContent = p.mark || '·';
      row.appendChild(mark);

      var name = document.createElement('span');
      name.className = 'prov-item-name';
      name.textContent = p.name;
      row.appendChild(name);

      var status = document.createElement('span');
      status.className = 'prov-item-state';
      applyStateClass(status, conn.kind);
      var dot = document.createElement('span');
      dot.className = 'chat-dot';
      status.appendChild(dot);
      var word = document.createElement('span');
      word.textContent = statusWord(conn.kind);
      status.appendChild(word);
      row.appendChild(status);

      if (pid === S.provider) {
        var check = document.createElement('span');
        check.className = 'prov-check';
        check.textContent = '✓';
        check.setAttribute('aria-hidden', 'true');
        row.appendChild(check);
      }

      row.addEventListener('click', function () {
        selectProvider(pid);
        closeMenu();
      });
      els.chatProviderMenu.appendChild(row);
    });

    bindExternalLinks(els.chatProviderMenu);
  }

  function statusWord(kind) {
    switch (kind) {
      case 'connected': return 'connected';
      case 'connecting': return 'checking';
      case 'saved': return 'key saved';
      case 'invalid': return 'invalid key';
      case 'rate': return 'rate limited';
      case 'quota': return 'no credits';
      case 'model': return 'no model';
      case 'network': return 'offline';
      case 'service': return 'service down';
      case 'error': return 'error';
      default: return 'add key';
    }
  }

  function openMenu() {
    if (!els.chatProviderMenu) return;
    renderProviderMenu();
    els.chatProviderMenu.classList.remove('hidden');
    if (els.chatProviderBtn) els.chatProviderBtn.setAttribute('aria-expanded', 'true');
    S.menuOpen = true;
  }

  function closeMenu() {
    if (!els.chatProviderMenu) return;
    els.chatProviderMenu.classList.add('hidden');
    if (els.chatProviderBtn) els.chatProviderBtn.setAttribute('aria-expanded', 'false');
    S.menuOpen = false;
  }

  function syncProviderUi() {
    var p = provById(S.provider);
    if (els.chatProviderMark) {
      els.chatProviderMark.textContent = p ? (p.mark || '·') : '·';
      els.chatProviderMark.style.color = p ? (p.tint || '') : '';
    }
    if (els.chatProviderName) els.chatProviderName.textContent = p ? p.name : 'Provider';
    if (els.chatSettingsProvider) {
      els.chatSettingsProvider.textContent = (p ? p.longName : S.provider).toUpperCase();
    }

    var ps = provState(S.provider);
    if (els.chatModelRefresh) els.chatModelRefresh.disabled = !ps.apiKey;
    renderProviderMenu();
    refreshPill();
    refreshConnectBanner();
    updateHeader();
    updateSendState();
  }

  function selectProvider(pid) {
    if (!validProvider(pid) || !provById(pid)) return;
    if (pid === S.provider) {
      syncProviderUi();
      return;
    }
    if (S.generating) stopGeneration();

    S.provider = pid;
    store.activeProvider = pid;
    var ps = provState(pid);

    if (!ps.model) {
      var list = providerModels(pid);
      if (list.length) ps.model = list[0].id;
    }
    if (S.conv) {
      S.conv.provider = pid;
      S.conv.model = ps.model || '';
      S.conv.updatedAt = Date.now();
    }

    saveSoon();
    syncProviderUi();
    populateModelSelect();
    if (S.settings) expandCard(pid);

    if (!ps.apiKey) {
      setConn(pid, 'off', 'Not configured — add a key');
    } else if (!S.verified[pid]) {
      if (S.conns[pid] && S.conns[pid].kind === 'off') {
        setConn(pid, 'saved', 'Key saved — test to connect');
      }
      if (S.open) verifyProvider(pid, ps.apiKey, { save: false });
    }
  }

  /* --------------------------------------------------------------- models */

  function updateHeader() {
    if (!els.chatTitle) return;
    els.chatTitle.textContent = S.conv ? S.conv.title : 'OpenCaption AI';
    var model = currentModel();
    els.chatSub.textContent = providerName(S.provider) + (model ? ' · ' + model : ' · no model');
    renderWelcomeModel();
  }

  /* ----------------------------------------------------------------- views */

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
    PROVIDER_ORDER.forEach(syncCardKey);
    populateAllCardModels();
    expandCard(S.provider);
    if (els.chatSettingsProvider) {
      var p = provById(S.provider);
      els.chatSettingsProvider.textContent = (p ? p.longName : S.provider).toUpperCase();
    }
    var card = cardEls[S.provider];
    if (card) {
      (provState(S.provider).apiKey ? card.head : card.key).focus();
    }
  }

  function openProviderSettings(pid) {
    if (!validProvider(pid)) return;
    if (pid !== S.provider) {
      S.provider = pid;
      store.activeProvider = pid;
      if (S.conv) {
        S.conv.provider = pid;
        S.conv.model = provState(pid).model || currentModel();
      }
      syncProviderUi();
      populateModelSelect();
      saveSoon();
    }
    openSettings();
    expandCard(pid);
    var card = cardEls[pid];
    if (card) card.key.focus();
  }

  function expandCard(pid) {
    S.openCard = S.openCard === pid ? '' : pid;
    PROVIDER_ORDER.forEach(function (id) {
      var card = cardEls[id];
      if (!card) return;
      var open = S.openCard === id;
      card.root.classList.toggle('open', open);
      card.head.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
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
        'Pick a provider and model above; caption settings stay exactly where you left them.</p>' +
        '<div class="chat-suggestions"></div>' +
        '<p class="chat-welcome-foot">Powered by <strong class="chat-welcome-provider">' +
          escapeHtml(providerName(S.provider)) + '</strong> · ' +
          '<span class="chat-welcome-model">' + escapeHtml(currentModel() || 'choose a model') + '</span></p>' +
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

  function renderWelcomeModel() {
    if (!els.chatMessages) return;
    var provider = els.chatMessages.querySelector('.chat-welcome-provider');
    if (provider) provider.textContent = providerName(S.provider);
    var model = els.chatMessages.querySelector('.chat-welcome-model');
    if (model) model.textContent = currentModel() || 'choose a model';
  }

  function formatTokens(usage) {
    function n(value) {
      var v = Number(value) || 0;
      if (v >= 1000000) return (v / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
      if (v >= 1000) return (v / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
      return String(v);
    }
    if (!usage) return '';
    var total = usage.total || ((usage.input || 0) + (usage.output || 0));
    return n(usage.input) + ' in · ' + n(usage.output) + ' out · ' + n(total) + ' total';
  }

  function metaText(msg) {
    var bits = [];
    if (msg.provider) bits.push(providerName(msg.provider));
    if (msg.model) bits.push(msg.model);
    return bits.join(' · ');
  }

  function fillMeta(el, msg) {
    var meta = el.querySelector('[data-meta]');
    if (!meta) return;
    var text = metaText(msg);
    var usage = formatTokens(msg.usage);
    meta.textContent = usage ? text + ' · ' + usage : text;
    meta.classList.toggle('hidden', !text);
    meta.title = usage ? 'Token usage reported by ' + providerName(msg.provider) : '';
  }

  function fillReasoning(el, msg) {
    var box = el.querySelector('[data-reason]');
    if (!box) return;
    var body = box.querySelector('[data-reason-body]');
    if (!msg.reasoning) {
      box.classList.add('hidden');
      if (body) body.textContent = '';
      return;
    }
    box.classList.remove('hidden');
    if (body) body.textContent = msg.reasoning;
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

    if (canRegenerate && !msg.local) {
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
      '<div class="msg-col">' +
        '<details class="msg-reason hidden" data-reason><summary>reasoning</summary>' +
        '<div class="msg-reason-body" data-reason-body></div></details>' +
        '<div class="msg-bubble md" data-bubble></div>' +
        '<div class="action-slot" data-action-slot></div>' +
        '<div class="msg-meta hidden" data-meta></div>' +
        '<div class="msg-actions"></div>' +
      '</div>';

    var bubble = root.querySelector('[data-bubble]');
    fillMeta(root, msg);
    fillReasoning(root, msg);

    if (streaming) {
      bubble.classList.add('streaming');
      bubble.textContent = msg.content || '';
    } else {
      bubble.innerHTML = renderMarkdown(msg.content);
      bindMarkdown(bubble);
      addActions(root, msg, canRegenerate);
      mountActionCard(root, msg);
    }
    return root;
  }

  function mountActionCard(root, msg) {
    if (!root || !msg) return;
    var slot = root.querySelector('[data-action-slot]');
    if (!slot) return;
    if (!msg.action || typeof ActionPreview === 'undefined') {
      slot.innerHTML = '';
      return;
    }
    ActionPreview.mount(slot, msg.action, {
      onExecute: function () { executePlan(msg); },
      onCancel: function () { cancelPlan(msg); },
      onStop: function () { stopPlanExecution(); }
    });
  }

  function refreshActionCard(msg) {
    if (!msg || !msg.id || !els.chatMessages) return;
    var root = els.chatMessages.querySelector('[data-msg="' + msg.id + '"]');
    if (root) mountActionCard(root, msg);
    scrollBottom();
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
    fillMeta(el, msg);
    fillReasoning(el, msg);
    addActions(el, msg, canRegenerate);
    mountActionCard(el, msg);
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
      provider: S.provider,
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
    if (S.executingPlan) {
      notice('Wait for the current editing plan to finish, or press Stop in its card.', 'warn');
      return;
    }
    if (S.generating) stopGeneration();
    var conv = conversationById(id);
    if (!conv) return;
    S.conv = conv;
    store.activeId = conv.id;

    if (validProvider(conv.provider) && provById(conv.provider)) S.provider = conv.provider;
    else conv.provider = S.provider;
    store.activeProvider = S.provider;

    var ps = provState(S.provider);
    if (conv.model) ps.model = conv.model;
    else conv.model = ps.model || (providerModels(S.provider)[0] || {}).id || '';

    saveSoon();
    syncProviderUi();
    populateModelSelect();
    renderList();
    renderConversation(conv);
    showChatView();
    collapseSidebar();
    updateHeader();

    if (ps.apiKey && !S.verified[S.provider] && S.open) {
      verifyProvider(S.provider, ps.apiKey, { save: false });
    }
  }

  function newChat() {
    if (S.executingPlan) {
      notice('Wait for the current editing plan to finish, or press Stop in its card.', 'warn');
      return;
    }
    if (S.generating) stopGeneration();
    S.conv = null;
    store.activeId = '';
    saveSoon();
    renderList();
    renderWelcome();
    showChatView();
    collapseSidebar();
    updateHeader();
    scrollBottom();
    if (els.chatInput) els.chatInput.focus();
  }

  function deleteConversation(id) {
    if (S.executingPlan) {
      notice('Wait for the current editing plan to finish, or press Stop in its card.', 'warn');
      return;
    }
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
    if (S.executingPlan) {
      notice('Wait for the current editing plan to finish, or press Stop in its card.', 'warn');
      return;
    }
    if (!store.conversations.length) {
      notice('There is no chat history to clear.', 'info');
      return;
    }
    if (!window.confirm('Delete every AI Chat conversation? This cannot be undone. ' +
      'Your saved provider keys and caption settings are kept.')) return;

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
    var ps = provState(S.provider);
    var empty = !els.chatInput || !els.chatInput.value.trim();
    els.chatSend.disabled = S.generating || empty || !ps.apiKey || !currentModel();
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

    var p = provById(S.provider);
    var ps = provState(S.provider);
    if (!p) {
      notice('AI Chat is unavailable. Restart Premiere or check the panel manifest.', 'err');
      return;
    }
    if (!ps.apiKey) {
      showChatView();
      notice('Connect ' + p.name + ' before sending a message.', 'warn');
      openProviderSettings(S.provider);
      return;
    }
    if (!currentModel()) {
      notice('Choose a ' + p.name + ' model in Settings first.', 'warn');
      openProviderSettings(S.provider);
      return;
    }

    var conv = ensureConversation();
    if (!conv.title || conv.title === 'New chat') conv.title = titleFrom(text);
    conv.provider = S.provider;
    conv.model = currentModel();

    var message = { id: newId(), role: 'user', content: text, ts: Date.now() };
    conv.messages.push(message);
    conv.updatedAt = Date.now();

    els.chatInput.value = '';
    autoGrow();
    updateSendState();
    saveSoon();
    renderList();
    renderConversation(conv);
    if (isEditRequest(text)) startEditCompletion(conv);
    else startCompletion(conv);
  }

  function startCompletion(conv) {
    if (S.generating) return;
    if (!conv.messages.some(function (m) { return m.role === 'user' && m.content; })) return;

    var p = provById(S.provider);
    var ps = provState(S.provider);
    var model = currentModel();
    if (!p || !ps.apiKey || !model) {
      notice('Connect a provider and choose a model before sending.', 'warn');
      openSettings();
      return;
    }

    var assistant = {
      id: newId(),
      role: 'assistant',
      content: '',
      reasoning: '',
      ts: Date.now(),
      provider: S.provider,
      model: model,
      usage: null,
      finishReason: ''
    };
    conv.messages.push(assistant);
    conv.provider = S.provider;
    conv.model = model;

    var el = renderMessage(assistant, false, true);
    els.chatMessages.appendChild(el);
    scrollBottom();

    S.run = {
      token: { cancelled: false },
      conv: conv,
      assistant: assistant,
      el: el,
      got: false,
      settled: false,
      provider: S.provider,
      model: model
    };

    setGenerating(true);
    perform(S.run, buildMessages(conv), false);
  }

  function lastUserText(conv) {
    for (var i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'user' && conv.messages[i].content) return conv.messages[i].content;
    }
    return '';
  }

  /**
   * Decides whether a message is an imperative timeline request rather than a
   * question. This is deliberately conservative: an ambiguous message goes to
   * normal chat, where the model can ask a follow-up instead of guessing.
   */
  function isEditRequest(text) {
    var s = String(text || '').trim().toLowerCase();
    if (!s || s.length > 4000) return false;

    var verbs = 'add|remove|delete|cut|split|move|apply|duplicate|trim|export|close|insert|set|change|make|create|put|raise|lower|detect|find|select|fix|replace|swap|shift|drop|mute|unmute|rename|undo';
    var direct = new RegExp('^\\s*(please\\s+)?(' + verbs + ')\\b').test(s);

    if (!direct && /\b(how|what|why|explain|tell me|describe|difference|should i)\b/.test(s)) {
      return false;
    }
    if (direct) return true;
    if (new RegExp('\\b(can|could|would|will)\\s+you\\s+(please\\s+)?(' + verbs + ')\\b').test(s)) return true;
    if (/\b(remove|delete|cut|close|fill)\b.{0,45}\b(silence|silences|silent|pauses|gaps)\b/.test(s)) return true;
    if (/\b(add|create|insert)\b.{0,45}\b(adjustment layer|effect|blur|title|subtitle|caption)\b/.test(s)) return true;
    return false;
  }

  function startEditCompletion(conv) {
    if (S.generating) return;
    if (!conv.messages.some(function (m) { return m.role === 'user' && m.content; })) return;

    if (typeof PremiereContext === 'undefined' || typeof ActionPlanner === 'undefined' ||
        typeof ActionExecutor === 'undefined' || typeof ActionPreview === 'undefined') {
      notice('The editing engine did not load. Restart Premiere or check the panel manifest.', 'err');
      return;
    }

    var p = provById(S.provider);
    var ps = provState(S.provider);
    var model = currentModel();
    if (!p || !ps.apiKey || !model) {
      notice('Connect a provider and choose a model before asking the assistant to edit.', 'warn');
      openSettings();
      return;
    }

    var assistant = {
      id: newId(),
      role: 'assistant',
      content: '',
      reasoning: '',
      ts: Date.now(),
      provider: S.provider,
      model: model,
      usage: null,
      finishReason: '',
      action: null
    };
    conv.messages.push(assistant);
    conv.provider = S.provider;
    conv.model = model;

    var el = renderMessage(assistant, false, true);
    var bubble = el.querySelector('[data-bubble]');
    if (bubble) bubble.textContent = 'Reading the active sequence…';
    els.chatMessages.appendChild(el);
    scrollBottom();

    var run = {
      mode: 'plan',
      token: { cancelled: false },
      conv: conv,
      assistant: assistant,
      el: el,
      got: true,
      settled: false,
      provider: S.provider,
      model: model,
      context: null
    };
    S.run = run;
    setGenerating(true);

    var requestText = lastUserText(conv);
    PremiereContext.read({
      includeClips: true,
      includeEffects: PremiereContext.needsEffectList(requestText)
    }).catch(function (err) {
      err.sequenceContext = true;
      throw err;
    }).then(function (context) {
      if (run.settled) return null;
      if (run.token.cancelled) throw { cancelled: true };
      run.context = context;

      var stream = run.el ? run.el.querySelector('[data-bubble]') : null;
      if (stream) stream.textContent = 'Planning the edit…';

      return ActionPlanner.plan({
        adapter: p,
        apiKey: ps.apiKey,
        model: model,
        messages: conv.messages,
        contextText: PremiereContext.format(context),
        token: run.token
      });
    }).then(function (result) {
      if (run.settled || !result) return;
      if (run.token.cancelled) { finishAborted(run); return; }
      finishPlanned(run, result);
    }).catch(function (err) {
      if (run.settled) return;
      if (run.token.cancelled || (err && err.cancelled)) { finishAborted(run); return; }
      if (err && err.sequenceContext) {
        finishPlanMessage(run, 'I could not read the active sequence, so no actions were prepared.\n\n' +
          String(err.message || err) + '\n\nOpen a sequence in the Timeline and try again.');
        return;
      }
      finishError(run, err);
    });
  }

  function finishPlanMessage(run, text) {
    if (run.settled) return;
    run.assistant.content = text;
    run.assistant.ts = Date.now();
    run.assistant.provider = run.provider;
    run.conv.updatedAt = Date.now();
    finalizeAssistant(run.el, run.assistant, true);
    saveNow();
    renderList();
    updateHeader();
    finishRun(run);
    scrollBottom();
  }

  function makeActionRecord(plan, warnings) {
    return {
      id: newId('a'),
      title: plan.title,
      summary: plan.summary,
      steps: plan.steps,
      status: 'pending',
      warnings: warnings || [],
      results: [],
      error: '',
      createdAt: Date.now(),
      startedAt: 0,
      finishedAt: 0
    };
  }

  function finishPlanned(run, result) {
    if (run.settled) return;
    if (!result.ok) {
      var details = '';
      if (result.details && result.details.length) {
        details = '\n\n' + result.details.slice(0, 6).map(function (line) { return '- ' + line; }).join('\n');
      }
      finishPlanMessage(run, (result.error || 'The editing plan could not be prepared.') +
        details + '\n\nNo actions were prepared, so nothing was changed.');
      return;
    }

    var assistant = run.assistant;
    assistant.ts = Date.now();
    assistant.provider = run.provider;
    assistant.model = result.model || run.model;
    if (result.usage) assistant.usage = result.usage;
    if (result.finishReason) assistant.finishReason = result.finishReason;

    if (result.kind === 'plan') {
      var label = PremiereContext.sequenceLabel(run.context);
      assistant.content = result.plan.summary ||
        ('I prepared a ' + result.plan.steps.length + '-step editing plan for "' + label +
          '". Review it below, then press Execute.');
      assistant.action = makeActionRecord(result.plan, result.warnings);
      assistant.local = false;
    } else {
      assistant.content = result.text;
      assistant.action = null;
      if (result.warnings && result.warnings.length) {
        assistant.content += '\n\n*' + result.warnings[0] + '*';
      }
    }

    run.conv.updatedAt = Date.now();
    finalizeAssistant(run.el, assistant, true);
    saveNow();
    renderList();
    updateHeader();
    finishRun(run);
    scrollBottom();
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

  function onReasoning(run, full) {
    run.assistant.reasoning = full;
    var box = run.el ? run.el.querySelector('[data-reason]') : null;
    if (!box) return;
    box.classList.remove('hidden');
    var body = box.querySelector('[data-reason-body]');
    if (body) body.textContent = full;
    scrollBottom();
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
    if (result.reasoning) run.assistant.reasoning = result.reasoning;
    if (result.usage) run.assistant.usage = result.usage;
    if (result.finishReason) run.assistant.finishReason = result.finishReason;
    if (result.model) run.assistant.model = result.model;
    run.assistant.provider = run.provider;
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
    var kind = (typeof Providers !== 'undefined' && Providers) ? Providers.classify(err) : 'error';
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
      notice(message, kind === 'invalid' || kind === 'rate' || kind === 'quota' ? 'warn' : 'err');
    }

    if (kind === 'invalid' || kind === 'rate' || kind === 'quota' ||
        kind === 'model' || kind === 'network' || kind === 'service') {
      setConn(run.provider, kind, message);
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
    var p = provById(run.provider);
    var ps = provState(run.provider);
    if (!p) {
      finishError(run, new Error('AI Chat is unavailable.'));
      return;
    }

    var handlers = {
      apiKey: ps.apiKey,
      model: run.model,
      messages: messages,
      temperature: 0.7,
      token: run.token,
      onDelta: function (_, full) { onDelta(run, full); },
      onReasoning: function (_, full) { onReasoning(run, full); }
    };

    p.chat(handlers).then(function (result) {
      finishSuccess(run, result);
    }).catch(function (err) {
      if (run.settled) return;
      if (run.token.cancelled) { finishAborted(run); return; }

      var kind = (typeof Providers !== 'undefined' && Providers) ? Providers.classify(err) : 'error';
      var canFallback = !fallbackUsed && !run.got &&
        (kind === 'network' || kind === 'error' || kind === 'service');

      if (!canFallback || !p.complete) {
        finishError(run, err);
        return;
      }

      notice('Streaming was interrupted — retrying without streaming…', 'info');
      p.complete(handlers).then(function (result) {
        finishSuccess(run, result);
      }).catch(function (err2) {
        finishError(run, err2);
      });
    });
  }

  function stopGeneration() {
    if (!S.run) return;
    S.run.token.cancelled = true;
    if (typeof Providers !== 'undefined' && Providers) Providers.cancel(S.run.token);
    else if (typeof Groq !== 'undefined' && Groq.ok) Groq.cancel(S.run.token);
    if (els.chatStop) {
      els.chatStop.disabled = true;
      els.chatStop.textContent = 'Stopping…';
    }
  }

  /* ------------------------------------------------------------ action execution */

  function planErrorMessage(out) {
    for (var i = 0; i < (out.results || []).length; i++) {
      if (!out.results[i].ok) return out.results[i].error || 'The step did not complete.';
    }
    return out.cancelled ? 'The plan was stopped.' : 'The plan did not complete.';
  }

  function cancelPlan(msg) {
    if (!msg || !msg.action || msg.action.status !== 'pending') return;
    msg.action.status = 'cancelled';
    msg.action.finishedAt = Date.now();
    saveNow();
    refreshActionCard(msg);
    notice('Plan cancelled. Nothing was changed.', 'info');
  }

  function stopPlanExecution() {
    if (!S.executingPlan) return;
    S.executingPlan.token.cancelled = true;
    notice('Stopping after the current step…', 'info');
  }

  function executePlan(msg) {
    if (!msg || !msg.action) return;
    var action = msg.action;
    if (action.status !== 'pending') return;
    if (S.executingPlan) {
      notice('Another editing plan is already running.', 'warn');
      return;
    }
    var conv = S.conv;
    if (!conv) return;

    var token = { cancelled: false };
    S.executingPlan = { token: token, msg: msg, conv: conv };

    action.status = 'running';
    action.results = [];
    action.error = '';
    action.startedAt = Date.now();
    action.finishedAt = 0;
    action.runningIndex = -1;
    action.analysisProgress = '';
    saveSoon();
    refreshActionCard(msg);

    ActionExecutor.execute(action, {
      token: token,
      onProgress: function (index, state) {
        action.runningIndex = state === 'running' ? index : -1;
        refreshActionCard(msg);
      },
      onAnalysis: function (fraction) {
        action.analysisProgress = 'Analyzing the sequence audio… ' + Math.round(fraction * 100) + '%';
        refreshActionCard(msg);
      }
    }).then(function (out) {
      action.status = out.ok ? 'done' : (out.cancelled ? 'cancelled' : 'failed');
      action.results = out.results || [];
      action.error = out.ok ? '' : planErrorMessage(out);
      action.finishedAt = Date.now();
      action.runningIndex = -1;
      action.analysisProgress = '';

      var resultMessage = {
        id: newId(),
        role: 'assistant',
        content: out.summary,
        ts: Date.now(),
        provider: msg.provider,
        model: msg.model,
        local: true
      };
      conv.messages.push(resultMessage);
      conv.updatedAt = Date.now();
      S.executingPlan = null;

      saveNow();
      renderList();
      if (S.conv === conv) renderConversation(conv);
    }).catch(function (err) {
      action.status = (err && err.cancelled) ? 'cancelled' : 'failed';
      action.error = String((err && err.message) || err);
      action.finishedAt = Date.now();
      action.runningIndex = -1;
      action.analysisProgress = '';
      S.executingPlan = null;

      saveNow();
      renderList();
      refreshActionCard(msg);
      notice('The editing plan stopped: ' + action.error, 'err');
    });
  }

  function regenerate() {
    if (S.generating || !S.conv) return;
    var conv = S.conv;
    var at = -1;
    for (var i = conv.messages.length - 1; i >= 0; i--) {
      if (conv.messages[i].role === 'assistant') { at = i; break; }
    }
    if (at < 0) return;

    var removed = conv.messages[at];
    conv.messages.splice(at, 1);
    saveSoon();
    renderConversation(conv);

    var wantsPlan = !!(removed && removed.action) || isEditRequest(lastUserText(conv));
    if (wantsPlan) startEditCompletion(conv);
    else startCompletion(conv);
  }

  /* -------------------------------------------------------------- provider cards */

  function buildProviderCards() {
    if (!els.chatProviderCards) return;
    els.chatProviderCards.innerHTML = '';
    cardEls = {};

    PROVIDER_ORDER.forEach(function (pid) {
      var p = provById(pid);
      if (!p) return;

      var card = document.createElement('section');
      card.className = 'chat-settings-card prov-card';
      card.setAttribute('data-provider', pid);
      card.innerHTML =
        '<div class="prov-card-head" role="button" tabindex="0" aria-expanded="false">' +
          '<span class="prov-mark" style="color:' + escapeHtml(p.tint || '') + '">' +
            escapeHtml(p.mark || '·') + '</span>' +
          '<span class="prov-card-name">' + escapeHtml(p.longName) + '</span>' +
          '<span class="chat-conn state-off" data-role="status">' +
            '<span class="chat-dot"></span><span data-role="statustext">Not configured</span></span>' +
          '<span class="prov-caret" aria-hidden="true">▾</span>' +
        '</div>' +
        '<div class="prov-card-body">' +
          '<label class="field"><span>' + escapeHtml(p.name) + ' API key</span>' +
            '<div class="input-wrap">' +
              '<input data-role="key" type="password" placeholder="' + escapeHtml(p.keyHint || 'API key') + '" ' +
                'spellcheck="false" autocomplete="off" />' +
              '<button class="ghost-btn" data-role="toggle" type="button" title="Show / hide">show</button>' +
            '</div>' +
          '</label>' +
          '<div class="row wrap chat-key-actions">' +
            '<button class="btn primary sm" data-role="connect" type="button">Connect</button>' +
            '<button class="btn sm" data-role="test" type="button">Test</button>' +
            '<button class="btn sm" data-role="save" type="button">Save key</button>' +
            '<button class="btn sm ghost" data-role="disconnect" type="button">Disconnect</button>' +
            '<button class="btn sm ghost" data-role="remove" type="button">Remove key</button>' +
          '</div>' +
          '<p class="hint">Get a key at <a href="' + escapeHtml(p.keyUrl) + '" data-ext="link">' +
            escapeHtml(String(p.keyUrl).replace(/^https?:\/\//, '').replace(/\/$/, '')) + '</a> · ' +
            '<a href="' + escapeHtml(p.docsUrl) + '" data-ext="link">docs</a>. ' +
            'Stored on this computer only; never shown in chat.</p>' +
          '<div class="prov-model-grid">' +
            '<label class="field"><span class="field-head">Model ' +
              '<span class="field-actions"><button class="linkbtn" data-role="refresh" type="button" ' +
                'title="Fetch models from ' + escapeHtml(p.name) + '">refresh</button></span></span>' +
              '<select data-role="model" aria-label="' + escapeHtml(p.name) + ' model"></select></label>' +
            '<label class="field"><span>Custom model ID</span>' +
              '<div class="input-wrap"><input data-role="custom" type="text" spellcheck="false" ' +
                'placeholder="exact model id" />' +
                '<button class="btn sm" data-role="usecustom" type="button">use</button></div></label>' +
          '</div>' +
          '<p class="hint" data-role="modelhint"></p>' +
        '</div>';

      var cache = {
        root: card,
        head: card.querySelector('.prov-card-head'),
        status: card.querySelector('[data-role="status"]'),
        statusText: card.querySelector('[data-role="statustext"]'),
        key: card.querySelector('[data-role="key"]'),
        toggle: card.querySelector('[data-role="toggle"]'),
        connect: card.querySelector('[data-role="connect"]'),
        test: card.querySelector('[data-role="test"]'),
        save: card.querySelector('[data-role="save"]'),
        disconnect: card.querySelector('[data-role="disconnect"]'),
        remove: card.querySelector('[data-role="remove"]'),
        refresh: card.querySelector('[data-role="refresh"]'),
        model: card.querySelector('[data-role="model"]'),
        custom: card.querySelector('[data-role="custom"]'),
        useCustom: card.querySelector('[data-role="usecustom"]'),
        modelHint: card.querySelector('[data-role="modelhint"]')
      };
      cardEls[pid] = cache;

      cache.head.addEventListener('click', function () { expandCard(pid); });
      cache.head.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          expandCard(pid);
        }
      });

      cache.toggle.addEventListener('click', function (e) {
        e.stopPropagation();
        var showing = cache.key.type === 'text';
        cache.key.type = showing ? 'password' : 'text';
        cache.toggle.textContent = showing ? 'show' : 'hide';
      });
      cache.key.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          connectProvider(pid);
        }
      });

      cache.connect.addEventListener('click', function () { connectProvider(pid); });
      cache.test.addEventListener('click', function () { testProvider(pid); });
      cache.save.addEventListener('click', function () { saveProviderKey(pid); });
      cache.disconnect.addEventListener('click', function () { disconnectProvider(pid); });
      cache.remove.addEventListener('click', function () { removeProviderKey(pid); });
      cache.refresh.addEventListener('click', function () { refreshProviderModels(pid); });

      cache.model.addEventListener('change', function () {
        setModel(cache.model.value, pid);
      });

      cache.useCustom.addEventListener('click', function () {
        var id = cache.custom.value.trim();
        if (!id) return;
        setModel(id, pid);
        cache.custom.value = '';
      });
      cache.custom.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          cache.useCustom.click();
        }
      });

      bindExternalLinks(card);
      els.chatProviderCards.appendChild(card);
    });
  }

  function syncAllCards() {
    PROVIDER_ORDER.forEach(function (pid) {
      syncCardKey(pid);
      renderCardStatus(pid);
      populateCardModels(pid);
    });
  }

  /* -------------------------------------------------------------------- open */

  function open() {
    if (!S.booted) return;
    els.chatShell.classList.remove('hidden');
    els.chatShell.setAttribute('aria-hidden', 'false');
    S.open = true;
    if (isNarrow()) S.sideCollapsed = true;
    applySidebar();

    var ps = provState(S.provider);
    if (!ps.apiKey) {
      setConn(S.provider, 'off', 'Not configured — add a key');
    } else if (!S.verified[S.provider] && !S.generating) {
      verifyProvider(S.provider, ps.apiKey, { save: false });
    }

    if (!S.generating) {
      if (S.conv) renderConversation(S.conv);
      else renderWelcome();
    }
    syncProviderUi();
    populateModelSelect();
    updateHeader();
    scrollBottom();
    setTimeout(function () { if (els.chatInput) els.chatInput.focus(); }, 40);
  }

  function close() {
    if (!S.booted) return;
    closeMenu();
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

    if (els.chatProviderBtn) els.chatProviderBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      if (S.menuOpen) closeMenu();
      else openMenu();
    });
    if (els.chatProviderMenu) els.chatProviderMenu.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    if (els.chatModel) els.chatModel.addEventListener('change', function () {
      setModel(els.chatModel.value);
    });
    if (els.chatModelRefresh) els.chatModelRefresh.addEventListener('click', function () {
      refreshProviderModels(S.provider);
    });

    if (els.chatConnectProvider) els.chatConnectProvider.addEventListener('click', function () {
      openProviderSettings(S.provider);
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

    document.addEventListener('mousedown', function (e) {
      if (!S.menuOpen) return;
      var wrap = els.chatProviderBtn ? els.chatProviderBtn.parentNode : null;
      if (wrap && wrap.contains(e.target)) return;
      closeMenu();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !S.open) return;
      e.preventDefault();
      e.stopPropagation();
      if (S.menuOpen) closeMenu();
      else if (S.settings) showChatView();
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
      'chatChatView', 'chatSettingsView', 'chatSettingsBack',
      'chatProviderBtn', 'chatProviderMark', 'chatProviderName', 'chatProviderMenu',
      'chatModel', 'chatModelRefresh', 'chatConnectBanner', 'chatConnectName',
      'chatConnectProvider', 'chatProviderCards', 'chatSettingsProvider'];

    ids.forEach(function (id) { els[id] = $(id); });
    if (!els.chatShell || !els.chatMessages) return;

    try { cs = new CSInterface(); } catch (e) { cs = null; }

    store = loadStore();
    for (var i = 0; i < PROVIDER_ORDER.length; i++) {
      if (!store.providers[PROVIDER_ORDER[i]]) store.providers[PROVIDER_ORDER[i]] = emptyProvider();
    }
    if (validProvider(store.activeProvider)) S.provider = store.activeProvider;
    S.sideCollapsed = !!store.sidebarCollapsed;
    if (store.activeId) S.conv = conversationById(store.activeId);
    if (S.conv && validProvider(S.conv.provider)) S.provider = S.conv.provider;
    store.activeProvider = S.provider;

    buildProviderCards();
    bind();
    syncAllCards();
    populateModelSelect();
    applySidebar();
    renderList();

    PROVIDER_ORDER.forEach(function (pid) {
      S.conns[pid] = defaultConn(pid);
      renderCardStatus(pid);
    });

    if (typeof Providers === 'undefined' || !Providers.available) {
      setConn(S.provider, 'error', 'AI Chat is unavailable — Node.js is not enabled in this panel.');
      if (els.chatSend) els.chatSend.disabled = true;
    } else if (typeof Groq === 'undefined' && !provById('groq')) {
      setConn(S.provider, 'saved', 'Key saved — press Connect to test it.');
    }

    syncProviderUi();
    populateModelSelect();

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
    _loadStore: loadStore,
    _cleanStore: cleanStore,
    _serializeStore: serializeStore,
    _selectProvider: selectProvider,
    _providerState: provState,
    _applyModels: applyModels,
    _isEditRequest: isEditRequest,
    _cleanAction: cleanAction,
    _executePlan: executePlan,
    _cancelPlan: cancelPlan
  };
})();
