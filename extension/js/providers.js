/*
 * providers.js — chat provider adapters for openCaption AI.
 *
 * Every provider speaks a different dialect, so each one gets its own adapter
 * behind one interface:
 *
 *   chat({ apiKey, model, messages, temperature, token, onDelta, onReasoning })
 *        -> Promise<{ text, reasoning, usage, finishReason, model, provider }>
 *   complete(...)  same, without streaming (fallback when SSE is interrupted)
 *   listModels(apiKey) -> Promise<[{ id, context }]>
 *   test(apiKey)   -> Promise<{ ok, models } | { ok:false, kind, error }>
 *   cancel(token)  destroys only this adapter's in-flight requests
 *
 * The panel never talks to a wire format directly. Messages are normalised to
 * [{ role: 'system'|'user'|'assistant', content: '...' }] and reasoning text is
 * always returned separately so it is never mixed into the answer.
 *
 * Keys travel only in request headers for their own provider. Every error
 * message is scrubbed before it reaches the UI or the chat log.
 */
var Providers = (function () {
  'use strict';

  var NODE_OK = typeof NODE !== 'undefined' && NODE.ok && !!NODE.https;
  var https = NODE_OK ? NODE.https : null;
  var USER_AGENT = 'openCaption-ai-chat/1.7';
  var IDLE_TIMEOUT = 120000;

  var requestFactory = function (options, callback) {
    return https.request(options, callback);
  };

  /* ------------------------------------------------------------ primitives */

  function merge(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) {
        if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
      }
    }
    return target;
  }

  function trim(text) {
    return String(text == null ? '' : text)
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 320);
  }

  var SECRET_STYLES = [
    /sk-ant-[A-Za-z0-9_\-]{8,}/g,
    /sk-[A-Za-z0-9_\-]{8,}/g,
    /gsk_[A-Za-z0-9_\-]{8,}/g,
    /xai-[A-Za-z0-9_\-]{8,}/g,
    /AIza[A-Za-z0-9_\-]{20,}/g,
    /([?&](?:key|api_key|apikey|access_token)=)[^&\s]+/gi
  ];

  function scrub(text, key) {
    var out = String(text == null ? '' : text);
    if (key && String(key).length >= 4) out = out.split(String(key)).join('…');
    for (var i = 0; i < SECRET_STYLES.length; i++) {
      out = out.replace(SECRET_STYLES[i], function (match, prefix) {
        return prefix ? prefix + '…' : '…';
      });
    }
    return trim(out);
  }

  function ProviderError(message, opts) {
    opts = opts || {};
    var e = new Error(message);
    e.name = 'ProviderError';
    e.kind = opts.kind || 'error';
    e.status = Number(opts.status) || 0;
    e.code = opts.code || '';
    e.retryAfter = Number(opts.retryAfter) || 0;
    e.body = opts.body || '';
    return e;
  }

  function cancelError() {
    var e = new Error('Stopped.');
    e.cancelled = true;
    e.kind = 'cancelled';
    return e;
  }

  function classify(err) {
    if (!err) return 'error';
    if (err.cancelled || err.name === 'AbortError') return 'cancelled';
    if (err.kind) return err.kind;
    var status = Number(err.status) || 0;
    if (status === 401 || status === 403) return 'invalid';
    if (status === 402) return 'quota';
    if (status === 404) return 'model';
    if (status === 429) return 'rate';
    if (status >= 500) return 'service';
    var text = String(err.code || '') + ' ' + String(err.message || '');
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|socket hang up|certificate|network|timed? ?out/i.test(text)) {
      return 'network';
    }
    return 'error';
  }

  function retryAfter(res) {
    var headers = res && res.headers;
    if (!headers) return 0;
    return Number(headers['retry-after'] || headers['Retry-After']) || 0;
  }

  function statusKind(status, detail) {
    var low = String(detail || '').toLowerCase();
    if (/insufficient[_ ]?quota|insufficient[_ ]?balance|insufficient[_ ]?credit|credit balance|no credits|billing|payment|spend limit|quota/.test(low)) {
      return 'quota';
    }
    if (status === 401) return 'invalid';
    if (status === 402) return 'quota';
    if (status === 403) return 'invalid';
    if (status === 404) return 'model';
    if (status === 429) return 'rate';
    if (status === 498) return 'rate';
    if (status >= 500) return 'service';
    return 'error';
  }

  function friendly(kind, status, detail, opts) {
    opts = opts || {};
    var clean = scrub(detail, opts.key);
    var head;
    switch (kind) {
      case 'invalid': head = 'Invalid API key. '; break;
      case 'quota': head = 'No credits or quota left on this account. '; break;
      case 'rate': head = 'Rate limited. '; break;
      case 'model': head = 'Model unavailable. '; break;
      case 'service': head = 'Provider service error' + (status ? ' (HTTP ' + status + ')' : '') + '. '; break;
      case 'network': head = 'Network error. '; break;
      default: head = status ? 'Request failed (HTTP ' + status + '). ' : 'Request failed. ';
    }
    if (clean && clean.toLowerCase().indexOf(head.toLowerCase().trim()) !== 0) head += clean;
    return head.trim();
  }

  function buildError(kind, status, detail, opts) {
    opts = opts || {};
    return ProviderError(friendly(kind, status, detail, opts), {
      kind: kind,
      status: status,
      code: opts.code || '',
      retryAfter: opts.retryAfter || 0,
      body: scrub(opts.body || '')
    });
  }

  function jsonError(text) {
    var raw = String(text || '');
    try {
      var parsed = JSON.parse(raw);
      var e = parsed && (parsed.error || parsed);
      if (typeof e === 'string') return { message: e, code: '', type: '', status: '' };
      if (!e || typeof e !== 'object') return { message: '', code: '', type: '', status: '' };
      return {
        message: String(e.message || e.msg || e.detail || parsed.message || ''),
        code: String(e.code || ''),
        type: String(e.type || ''),
        status: String(e.status || '')
      };
    } catch (err) {
      return { message: trim(raw), code: '', type: '', status: '' };
    }
  }

  function normalizeMessages(list) {
    var out = [];
    var src = Array.isArray(list) ? list : [];
    for (var i = 0; i < src.length; i++) {
      var m = src[i] || {};
      if (m.role !== 'system' && m.role !== 'user' && m.role !== 'assistant') continue;
      var content = typeof m.content === 'string' ? m.content : '';
      if (!content) continue;
      out.push({ role: m.role, content: content });
    }
    return out;
  }

  function splitSystem(list) {
    var system = [];
    var messages = [];
    normalizeMessages(list).forEach(function (m) {
      if (m.role === 'system') system.push(m.content);
      else messages.push({ role: m.role, content: m.content });
    });
    return { system: system.join('\n\n'), messages: messages };
  }

  function contentText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    var out = '';
    for (var i = 0; i < content.length; i++) {
      var part = content[i] || {};
      if (typeof part.text === 'string') out += part.text;
    }
    return out;
  }

  function clampTemperature(value, min, max) {
    var n = Number(value);
    if (!isFinite(n)) n = 0.7;
    if (n < min) n = min;
    if (n > max) n = max;
    return n;
  }

  function usageNorm(input, output, total) {
    var i = Number(input) || 0;
    var o = Number(output) || 0;
    var t = Number(total) || (i + o);
    if (!i && !o && !t) return null;
    return { input: i, output: o, total: t };
  }

  function sseReader(handler) {
    var buffer = '';

    function parse(block) {
      var event = '';
      var data = [];
      var lines = block.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (!line || line.charAt(0) === ':') continue;
        if (line.indexOf('event:') === 0) event = line.slice(6).trim();
        else if (line.indexOf('data:') === 0) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) handler({ event: event, data: data.join('\n') });
    }

    return {
      push: function (chunk) {
        buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
        var at;
        while ((at = buffer.indexOf('\n\n')) >= 0) {
          parse(buffer.slice(0, at));
          buffer = buffer.slice(at + 2);
        }
      },
      end: function () {
        if (buffer.trim()) parse(buffer);
        buffer = '';
      }
    };
  }

  /* ----------------------------------------------------------- http client */

  function createClient(errorFor) {
    var active = [];

    function track(req, token) {
      var entry = { req: req, token: token };
      active.push(entry);
      return entry;
    }

    function untrack(entry) {
      var at = active.indexOf(entry);
      if (at >= 0) active.splice(at, 1);
    }

    function cancel(token) {
      for (var i = active.length - 1; i >= 0; i--) {
        var entry = active[i];
        if (token && entry.token !== token) continue;
        active.splice(i, 1);
        try { entry.req.destroy(cancelError()); } catch (e) { /* already closed */ }
      }
    }

    function start(cfg, streaming) {
      return new Promise(function (resolve, reject) {
        var payload = cfg.body == null ? null : Buffer.from(JSON.stringify(cfg.body), 'utf8');
        var headers = merge({}, cfg.headers || {});
        if (payload) {
          headers['Content-Type'] = headers['Content-Type'] || 'application/json';
          headers['Content-Length'] = payload.length;
        }

        var settled = false;
        var entry = null;

        function finish(fn, value) {
          if (settled) return;
          settled = true;
          untrack(entry);
          fn(value);
        }

        var req;
        try {
          req = requestFactory({
            hostname: cfg.host,
            port: 443,
            path: cfg.path,
            method: cfg.method || (payload ? 'POST' : 'GET'),
            headers: headers,
            timeout: cfg.timeout || IDLE_TIMEOUT
          }, function (res) {
            var code = res.statusCode || 0;

            if (code < 200 || code >= 300) {
              var failed = [];
              res.on('data', function (d) { failed.push(d); });
              res.on('end', function () {
                finish(reject, errorFor(code, Buffer.concat(failed).toString('utf8'), res, cfg.key));
              });
              res.on('error', function (e) { finish(reject, e); });
              return;
            }

            if (!streaming) {
              var chunks = [];
              res.on('data', function (d) { chunks.push(d); });
              res.on('end', function () {
                finish(resolve, {
                  status: code,
                  headers: res.headers,
                  text: Buffer.concat(chunks).toString('utf8')
                });
              });
              res.on('error', function (e) { finish(reject, e); });
              return;
            }

            var api = {
              cancelled: function () { return !!(cfg.token && cfg.token.cancelled); },
              done: function (value) {
                if (settled) return;
                finish(resolve, value);
                try { req.destroy(); } catch (e) { /* already gone */ }
              },
              fail: function (err) { finish(reject, err); }
            };

            var reader = sseReader(function (evt) {
              if (settled) return;
              try { cfg.onEvent(evt, api); } catch (err) { finish(reject, err); }
            });

            res.on('data', function (chunk) {
              if (cfg.token && cfg.token.cancelled) {
                req.destroy(cancelError());
                return;
              }
              reader.push(chunk);
            });

            res.on('end', function () {
              if (settled) return;
              reader.end();
              if (settled) return;
              try { api.done(cfg.result ? cfg.result() : { text: '' }); }
              catch (err) { finish(reject, err); }
            });

            res.on('error', function (e) {
              finish(reject, cfg.token && cfg.token.cancelled ? cancelError() : e);
            });
          });
        } catch (err) {
          finish(reject, err);
          return;
        }

        entry = track(req, cfg.token);

        req.on('timeout', function () {
          req.destroy(new Error('No response from ' + cfg.host + ' for ' +
            Math.round((cfg.timeout || IDLE_TIMEOUT) / 1000) + 's.'));
        });
        req.on('error', function (e) {
          finish(reject, cfg.token && cfg.token.cancelled ? cancelError() : e);
        });

        if (payload) req.write(payload);
        req.end();
      });
    }

    return {
      stream: function (cfg) { return start(cfg, true); },
      plain: function (cfg) { return start(cfg, false); },
      cancel: cancel
    };
  }

  /* ------------------------------------------------------- model utilities */

  var NOISE = /(embedding|embed-|whisper|tts|transcribe|translate|audio|speech|realtime|moderation|rerank|guard|safeguard|dall-?e|gpt-image|sora|imagine|video|veo|imagen|computer-use|deep-research|codex)/i;

  function cleanModels(list) {
    var out = [];
    var seen = {};
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var id = String(typeof m === 'string' ? m : (m.id || m.name || ''));
      if (!id) continue;
      if (id.indexOf('models/') === 0) id = id.slice(7);
      if (seen[id]) continue;
      seen[id] = true;
      out.push({ id: id, context: Number(m.context || m.context_window || m.context_length || 0) || 0 });
    }
    return out;
  }

  function ranker(patterns) {
    return function (id) {
      for (var i = 0; i < patterns.length; i++) {
        if (patterns[i].test(id)) return i;
      }
      return patterns.length;
    };
  }

  function sortModels(models, rank) {
    models.sort(function (a, b) {
      var byRank = rank(a.id) - rank(b.id);
      if (byRank) return byRank;
      return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
    });
    return models;
  }

  function testAdapter(adapter, key) {
    if (!key) {
      return Promise.resolve({ ok: false, kind: 'off', error: 'Enter an API key first.' });
    }
    return adapter.listModels(key).then(function (models) {
      return { ok: true, models: models };
    }).catch(function (e) {
      return {
        ok: false,
        kind: classify(e),
        status: Number(e && e.status) || 0,
        error: (e && e.message) || ('Could not reach ' + adapter.name + '.')
      };
    });
  }

  /* --------------------------------------------- OpenAI-compatible adapters */

  function openAIAdapter(spec) {
    var client = createClient(function (status, text, res, key) {
      var info = jsonError(text);
      var detail = info.message || text;
      var kind = statusKind(status, (info.code || '') + ' ' + (info.type || '') + ' ' + (info.status || '') + ' ' + detail);
      return buildError(kind, status, detail, {
        code: info.code || info.type || info.status,
        retryAfter: retryAfter(res),
        key: key,
        body: text
      });
    });

    var base = spec.base == null ? '/v1' : spec.base;
    var rank = ranker(spec.rankPatterns);
    var keep = spec.keep || function (id) { return !NOISE.test(id); };

    function headers(key, accept) {
      return merge({
        'Authorization': 'Bearer ' + key,
        'Accept': accept || 'application/json',
        'User-Agent': USER_AGENT
      }, spec.headers || {});
    }

    function usageFrom(raw) {
      if (!raw) return null;
      return usageNorm(raw.prompt_tokens, raw.completion_tokens, raw.total_tokens);
    }

    function modelsFrom(json) {
      var list = json && (Array.isArray(json.data) ? json.data
        : Array.isArray(json.models) ? json.models
        : Array.isArray(json) ? json : []);
      var picked = [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i] || {};
        var id = typeof m === 'string' ? m : String(m.id || m.name || m.model || '');
        if (!id || !keep(id)) continue;
        picked.push({
          id: id.replace(/^models\//, ''),
          context: Number(m.context_window || m.context_length || m.inputTokenLimit || m.max_context_length || 0) || 0
        });
      }
      return sortModels(cleanModels(picked), rank);
    }

    function fetchModels(key, path, accept) {
      return client.plain({
        host: spec.host,
        path: base + path,
        method: 'GET',
        headers: headers(key, accept),
        key: key
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.text); } catch (e) { json = null; }
        if (!json) {
          throw ProviderError(spec.name + ' returned an unexpected model list.',
            { kind: 'error', status: res.status });
        }
        return modelsFrom(json);
      });
    }

    function listModels(key) {
      return fetchModels(key, '/models').catch(function (err) {
        if (spec.altModelsPath && (err.status === 400 || err.status === 404 || err.status === 405)) {
          return fetchModels(key, spec.altModelsPath, spec.altModelsAccept);
        }
        throw err;
      });
    }

    function chat(opts) {
      var key = opts.apiKey;
      var token = opts.token || {};
      var messages = normalizeMessages(opts.messages);
      if (!messages.length) {
        return Promise.reject(ProviderError('There is no message to send.', { kind: 'error' }));
      }

      var body = { model: opts.model, messages: messages, stream: true };
      if (spec.temperature !== false && !(spec.noTemperature && spec.noTemperature(opts.model))) {
        body.temperature = clampTemperature(opts.temperature, 0, 2);
      }
      if (spec.streamUsage) body.stream_options = { include_usage: true };
      if (spec.maxTokens) body.max_tokens = spec.maxTokens;
      if (spec.extraBody) spec.extraBody(body, opts);

      var state = {
        text: '', reasoning: '', usage: null,
        finishReason: '', model: opts.model
      };

      function result() {
        return {
          text: state.text,
          reasoning: state.reasoning,
          usage: state.usage,
          finishReason: state.finishReason,
          model: state.model,
          provider: spec.id
        };
      }

      return client.stream({
        host: spec.host,
        path: base + '/chat/completions',
        method: 'POST',
        headers: headers(key, 'text/event-stream'),
        body: body,
        token: token,
        key: key,
        onEvent: function (evt, api) {
          var raw = String(evt.data || '').trim();
          if (!raw) return;
          if (raw === '[DONE]') { api.done(result()); return; }

          var json = null;
          try { json = JSON.parse(raw); } catch (e) { return; }

          if (json.error) {
            var info = jsonError(raw);
            var code = Number(info.code) || 0;
            var kind = statusKind(code, (info.code || '') + ' ' + (info.type || '') + ' ' + info.message);
            api.fail(buildError(kind, code, info.message, { code: info.code || info.type, key: key, body: raw }));
            return;
          }

          if (json.usage) state.usage = usageFrom(json.usage);
          if (json.model) state.model = String(json.model);

          var choice = json.choices && json.choices[0];
          if (!choice) return;

          var delta = choice.delta || {};
          var piece = contentText(delta.content);
          if (piece) {
            state.text += piece;
            if (opts.onDelta) opts.onDelta(piece, state.text);
          }

          var thought = delta.reasoning_content || delta.reasoning;
          if (typeof thought === 'string' && thought) {
            state.reasoning += thought;
            if (opts.onReasoning) opts.onReasoning(thought, state.reasoning);
          }

          if (choice.finish_reason) state.finishReason = String(choice.finish_reason);
        },
        result: result
      });
    }

    function complete(opts) {
      var key = opts.apiKey;
      var messages = normalizeMessages(opts.messages);
      var body = { model: opts.model, messages: messages, stream: false };
      if (spec.temperature !== false && !(spec.noTemperature && spec.noTemperature(opts.model))) {
        body.temperature = clampTemperature(opts.temperature, 0, 2);
      }
      if (spec.maxTokens) body.max_tokens = spec.maxTokens;
      if (spec.extraBody) spec.extraBody(body, opts);

      return client.plain({
        host: spec.host,
        path: base + '/chat/completions',
        method: 'POST',
        headers: headers(key),
        body: body,
        key: key
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.text); } catch (e) { json = null; }
        if (!json) {
          throw ProviderError(spec.name + ' returned an unexpected response.',
            { kind: 'error', status: res.status });
        }
        if (json.error) {
          var info = jsonError(res.text);
          var kind = statusKind(res.status, (info.code || '') + ' ' + (info.type || '') + ' ' + info.message);
          throw buildError(kind, res.status, info.message, { code: info.code || info.type, key: key });
        }
        var choice = (json.choices && json.choices[0]) || {};
        var message = choice.message || {};
        var text = contentText(message.content);
        var reasoning = String(message.reasoning_content || message.reasoning || '');
        if (text && opts.onDelta) opts.onDelta(text, text);
        if (reasoning && opts.onReasoning) opts.onReasoning(reasoning, reasoning);
        return {
          text: text,
          reasoning: reasoning,
          usage: usageFrom(json.usage),
          finishReason: String(choice.finish_reason || ''),
          model: String(json.model || opts.model),
          provider: spec.id
        };
      });
    }

    return {
      id: spec.id,
      name: spec.name,
      longName: spec.longName || spec.name,
      mark: spec.mark,
      tint: spec.tint,
      host: spec.host,
      keyUrl: spec.keyUrl,
      docsUrl: spec.docsUrl,
      keyHint: spec.keyHint,
      fallbackModels: cleanModels(spec.fallbackModels || []),
      chat: chat,
      complete: complete,
      listModels: listModels,
      cancel: client.cancel,
      test: function (key) { return testAdapter(this, key); }
    };
  }

  /* --------------------------------------------------------------- Gemini */

  function geminiAdapter() {
    var HOST = 'generativelanguage.googleapis.com';

    var client = createClient(function (status, text, res, key) {
      var info = jsonError(text);
      var detail = info.message || text;
      var gstatus = String(info.status || info.type || info.code || '').toUpperCase();
      var low = detail.toLowerCase();
      var kind;
      if (/api key|api_key|unauthenticated|invalid.*key/.test(low) ||
          status === 401 || gstatus === 'UNAUTHENTICATED') {
        kind = 'invalid';
      } else if (status === 402) {
        kind = 'quota';
      } else if (status === 403) {
        kind = /quota|billing|credit|payment/.test(low) ? 'quota' : 'invalid';
      } else if (status === 429) {
        kind = /quota|resource_exhausted|billing|payment/.test(low) ? 'quota' : 'rate';
      } else if (status === 404 || gstatus === 'NOT_FOUND') {
        kind = 'model';
      } else if (status >= 500) {
        kind = 'service';
      } else {
        kind = statusKind(status, detail);
      }
      return buildError(kind, status, detail, {
        code: gstatus,
        retryAfter: retryAfter(res),
        key: key,
        body: text
      });
    });

    var rank = ranker([/flash-lite/i, /flash/i, /pro/i, /gemma/i]);

    function headers(key, accept) {
      return {
        'x-goog-api-key': key,
        'Accept': accept || 'application/json',
        'User-Agent': USER_AGENT
      };
    }

    function keepModel(id) {
      return /^(gemini|gemma)/i.test(id) && !NOISE.test(id) && !/learnlm/i.test(id);
    }

    function listModels(key) {
      return client.plain({
        host: HOST,
        path: '/v1beta/models?pageSize=1000',
        method: 'GET',
        headers: headers(key),
        key: key
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.text); } catch (e) { json = null; }
        var list = (json && json.models) || [];
        var picked = [];
        for (var i = 0; i < list.length; i++) {
          var m = list[i] || {};
          var methods = m.supportedGenerationMethods || [];
          if (methods.length && methods.indexOf('generateContent') < 0) continue;
          var id = String(m.baseModelId || m.name || '').replace(/^models\//, '');
          if (!id || !keepModel(id)) continue;
          picked.push({ id: id, context: Number(m.inputTokenLimit) || 0 });
        }
        if (json && !picked.length) {
          throw ProviderError('Gemini did not list any chat models for this key.',
            { kind: 'model', status: res.status });
        }
        return sortModels(cleanModels(picked), rank);
      });
    }

    function bodyFor(opts) {
      var split = splitSystem(opts.messages);
      var contents = [];
      for (var i = 0; i < split.messages.length; i++) {
        var m = split.messages[i];
        var role = m.role === 'assistant' ? 'model' : 'user';
        var last = contents[contents.length - 1];
        if (last && last.role === role) {
          last.parts.push({ text: m.content });
        } else {
          contents.push({ role: role, parts: [{ text: m.content }] });
        }
      }
      while (contents.length && contents[0].role === 'model') contents.shift();

      var body = {
        contents: contents,
        generationConfig: { temperature: clampTemperature(opts.temperature, 0, 2) }
      };
      if (split.system) body.systemInstruction = { parts: [{ text: split.system }] };
      return body;
    }

    function usageFrom(meta) {
      if (!meta) return null;
      var thoughts = Number(meta.thoughtsTokenCount) || 0;
      return usageNorm(
        meta.promptTokenCount,
        (Number(meta.candidatesTokenCount) || 0) + thoughts,
        meta.totalTokenCount
      );
    }

    function absorb(json, state, opts, api) {
      if (json.error) {
        var info = jsonError(JSON.stringify(json));
        api.fail(buildError(statusKind(json.error.code, info.message), Number(json.error.code) || 0,
          info.message, { code: info.status || info.type, key: opts.apiKey, body: JSON.stringify(json) }));
        return false;
      }
      if (json.promptFeedback && json.promptFeedback.blockReason) {
        api.fail(ProviderError('Gemini blocked this request: ' +
          String(json.promptFeedback.blockReason).toLowerCase() + '.', { kind: 'error' }));
        return false;
      }
      if (json.usageMetadata) state.usage = usageFrom(json.usageMetadata);

      var candidate = json.candidates && json.candidates[0];
      if (!candidate) return true;
      if (candidate.finishReason) state.finishReason = String(candidate.finishReason);

      var parts = (candidate.content && candidate.content.parts) || [];
      for (var i = 0; i < parts.length; i++) {
        var part = parts[i] || {};
        if (typeof part.text !== 'string' || !part.text) continue;
        if (part.thought) {
          state.reasoning += part.text;
          if (opts.onReasoning) opts.onReasoning(part.text, state.reasoning);
        } else {
          state.text += part.text;
          if (opts.onDelta) opts.onDelta(part.text, state.text);
        }
      }
      return true;
    }

    function chat(opts) {
      var token = opts.token || {};
      var model = String(opts.model || '').replace(/^models\//, '');
      var body = bodyFor(opts);
      if (!body.contents.length) {
        return Promise.reject(ProviderError('There is no message to send.', { kind: 'error' }));
      }

      var state = { text: '', reasoning: '', usage: null, finishReason: '', model: model };
      function result() {
        return {
          text: state.text,
          reasoning: state.reasoning,
          usage: state.usage,
          finishReason: state.finishReason,
          model: state.model,
          provider: 'gemini'
        };
      }

      return client.stream({
        host: HOST,
        path: '/v1beta/models/' + encodeURIComponent(model) + ':streamGenerateContent?alt=sse',
        method: 'POST',
        headers: headers(opts.apiKey, 'text/event-stream'),
        body: body,
        token: token,
        key: opts.apiKey,
        onEvent: function (evt, api) {
          var raw = String(evt.data || '').trim();
          if (!raw || raw === '[DONE]') return;
          var json = null;
          try { json = JSON.parse(raw); } catch (e) { return; }
          absorb(json, state, opts, api);
        },
        result: result
      });
    }

    function complete(opts) {
      var model = String(opts.model || '').replace(/^models\//, '');
      var body = bodyFor(opts);
      return client.plain({
        host: HOST,
        path: '/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
        method: 'POST',
        headers: headers(opts.apiKey),
        body: body,
        key: opts.apiKey
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.text); } catch (e) { json = null; }
        if (!json) {
          throw ProviderError('Gemini returned an unexpected response.',
            { kind: 'error', status: res.status });
        }
        var state = { text: '', reasoning: '', usage: null, finishReason: '', model: model };
        absorb(json, state, opts, { fail: function (err) { throw err; } });
        return {
          text: state.text,
          reasoning: state.reasoning,
          usage: state.usage,
          finishReason: state.finishReason,
          model: state.model,
          provider: 'gemini'
        };
      });
    }

    return {
      id: 'gemini',
      name: 'Gemini',
      longName: 'Google Gemini',
      mark: '✦',
      tint: '#4c8dff',
      host: HOST,
      keyUrl: 'https://aistudio.google.com/apikey',
      docsUrl: 'https://ai.google.dev/gemini-api/docs',
      keyHint: 'AIza…',
      fallbackModels: cleanModels(['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash']),
      chat: chat,
      complete: complete,
      listModels: listModels,
      cancel: client.cancel,
      test: function (key) { return testAdapter(this, key); }
    };
  }

  /* ------------------------------------------------------------- Anthropic */

  function anthropicAdapter() {
    var HOST = 'api.anthropic.com';
    var VERSION = '2023-06-01';

    var client = createClient(function (status, text, res, key) {
      var info = jsonError(text);
      var type = String(info.type || '').toLowerCase();
      var detail = info.message || text;
      var kind = 'error';
      if (/authentication|permission|unauthorized|invalid.*key/.test(type)) kind = 'invalid';
      else if (/not_found/.test(type)) kind = 'model';
      else if (/rate_limit/.test(type)) {
        kind = /quota|credit|balance|billing/.test(detail.toLowerCase()) ? 'quota' : 'rate';
      } else if (/billing|insufficient/.test(type)) kind = 'quota';
      else if (/overloaded|api_error|timeout/.test(type)) kind = 'service';
      else kind = statusKind(status, detail);
      if (status === 402) kind = 'quota';
      if (status === 403 && kind !== 'quota') kind = 'invalid';
      return buildError(kind, status, detail, {
        code: info.type || info.code,
        retryAfter: retryAfter(res),
        key: key,
        body: text
      });
    });

    var rank = ranker([/sonnet/i, /opus/i, /haiku/i]);

    function headers(key) {
      return {
        'x-api-key': key,
        'anthropic-version': VERSION,
        'Accept': 'application/json',
        'User-Agent': USER_AGENT
      };
    }

    function listModels(key) {
      return client.plain({
        host: HOST,
        path: '/v1/models?limit=1000',
        method: 'GET',
        headers: headers(key),
        key: key
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.text); } catch (e) { json = null; }
        var list = (json && json.data) || [];
        var picked = [];
        for (var i = 0; i < list.length; i++) {
          var m = list[i] || {};
          if (m.type && m.type !== 'model') continue;
          var id = String(m.id || '');
          if (!/^claude/i.test(id)) continue;
          picked.push({ id: id, context: 0 });
        }
        return sortModels(cleanModels(picked), rank);
      });
    }

    function usageFrom(input, output) {
      return usageNorm(input, output, (Number(input) || 0) + (Number(output) || 0));
    }

    function resultOf(state) {
      return {
        text: state.text,
        reasoning: state.reasoning,
        usage: usageFrom(state.input, state.output),
        finishReason: state.finishReason,
        model: state.model,
        provider: 'anthropic'
      };
    }

    function chat(opts) {
      var key = opts.apiKey;
      var token = opts.token || {};
      var split = splitSystem(opts.messages);
      while (split.messages.length && split.messages[0].role === 'assistant') split.messages.shift();
      if (!split.messages.length) {
        return Promise.reject(ProviderError('There is no message to send.', { kind: 'error' }));
      }

      var body = {
        model: opts.model,
        max_tokens: 8192,
        messages: split.messages,
        stream: true,
        temperature: clampTemperature(opts.temperature, 0, 1)
      };
      if (split.system) body.system = split.system;

      var state = {
        text: '', reasoning: '', input: 0, output: 0,
        finishReason: '', model: opts.model
      };

      return client.stream({
        host: HOST,
        path: '/v1/messages',
        method: 'POST',
        headers: headers(key),
        body: body,
        token: token,
        key: key,
        onEvent: function (evt, api) {
          var json = null;
          try { json = JSON.parse(String(evt.data || '')); } catch (e) { return; }
          var type = evt.event || json.type;

          if (type === 'error' || json.type === 'error') {
            var err = json.error || {};
            var kind = statusKind(0, (err.type || '') + ' ' + (err.message || ''));
            api.fail(buildError(kind, 0, err.message || 'Anthropic returned an error.',
              { code: err.type, key: key, body: JSON.stringify(json) }));
            return;
          }

          if (type === 'message_start') {
            var msg = json.message || {};
            if (msg.model) state.model = String(msg.model);
            if (msg.usage) {
              state.input = Number(msg.usage.input_tokens) || 0;
              state.output = Number(msg.usage.output_tokens) || 0;
            }
          } else if (type === 'content_block_start') {
            var startBlock = json.content_block || {};
            if (startBlock.type === 'text' && typeof startBlock.text === 'string' && startBlock.text) {
              state.text += startBlock.text;
              if (opts.onDelta) opts.onDelta(startBlock.text, state.text);
            } else if (startBlock.type === 'thinking' && typeof startBlock.thinking === 'string' && startBlock.thinking) {
              state.reasoning += startBlock.thinking;
              if (opts.onReasoning) opts.onReasoning(startBlock.thinking, state.reasoning);
            }
          } else if (type === 'content_block_delta') {
            var delta = json.delta || {};
            if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              state.text += delta.text;
              if (opts.onDelta) opts.onDelta(delta.text, state.text);
            } else if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string' && delta.thinking) {
              state.reasoning += delta.thinking;
              if (opts.onReasoning) opts.onReasoning(delta.thinking, state.reasoning);
            }
          } else if (type === 'message_delta') {
            var change = json.delta || {};
            if (change.stop_reason) state.finishReason = String(change.stop_reason);
            var usage = json.usage || {};
            if (usage.output_tokens != null) state.output = Number(usage.output_tokens) || 0;
            if (usage.input_tokens != null) state.input = Number(usage.input_tokens) || 0;
          } else if (type === 'message_stop') {
            api.done(resultOf(state));
          }
        },
        result: function () { return resultOf(state); }
      });
    }

    function complete(opts) {
      var key = opts.apiKey;
      var split = splitSystem(opts.messages);
      while (split.messages.length && split.messages[0].role === 'assistant') split.messages.shift();
      var body = {
        model: opts.model,
        max_tokens: 8192,
        messages: split.messages,
        stream: false,
        temperature: clampTemperature(opts.temperature, 0, 1)
      };
      if (split.system) body.system = split.system;

      return client.plain({
        host: HOST,
        path: '/v1/messages',
        method: 'POST',
        headers: headers(key),
        body: body,
        key: key
      }).then(function (res) {
        var json = null;
        try { json = JSON.parse(res.text); } catch (e) { json = null; }
        if (!json) {
          throw ProviderError('Claude returned an unexpected response.',
            { kind: 'error', status: res.status });
        }
        var text = '';
        var reasoning = '';
        var blocks = json.content || [];
        for (var i = 0; i < blocks.length; i++) {
          var block = blocks[i] || {};
          if (block.type === 'text' && typeof block.text === 'string') text += block.text;
          else if (block.type === 'thinking' && typeof block.thinking === 'string') reasoning += block.thinking;
        }
        if (text && opts.onDelta) opts.onDelta(text, text);
        if (reasoning && opts.onReasoning) opts.onReasoning(reasoning, reasoning);
        var usage = json.usage || {};
        return {
          text: text,
          reasoning: reasoning,
          usage: usageFrom(usage.input_tokens, usage.output_tokens),
          finishReason: String(json.stop_reason || ''),
          model: String(json.model || opts.model),
          provider: 'anthropic'
        };
      });
    }

    return {
      id: 'anthropic',
      name: 'Claude',
      longName: 'Anthropic Claude',
      mark: '✳',
      tint: '#d97757',
      host: HOST,
      keyUrl: 'https://console.anthropic.com/settings/keys',
      docsUrl: 'https://platform.claude.com/docs/en/api/overview',
      keyHint: 'sk-ant-…',
      fallbackModels: cleanModels(['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']),
      chat: chat,
      complete: complete,
      listModels: listModels,
      cancel: client.cancel,
      test: function (key) { return testAdapter(this, key); }
    };
  }

  /* ---------------------------------------------------------------- Groq */

  function groqAdapter() {
    var ok = typeof Groq !== 'undefined' && Groq.ok;

    function resultOf(raw) {
      return {
        text: String(raw && raw.text || ''),
        reasoning: String(raw && raw.reasoning || ''),
        usage: raw && raw.usage
          ? usageNorm(raw.usage.prompt_tokens || raw.usage.input_tokens,
            raw.usage.completion_tokens || raw.usage.output_tokens,
            raw.usage.total_tokens)
          : null,
        finishReason: String(raw && raw.finishReason || ''),
        model: String(raw && raw.model || ''),
        provider: 'groq'
      };
    }

    function adapterError(err) {
      if (!err) return ProviderError('Groq request failed.', { kind: 'error' });
      var kind = Groq.classify(err);
      err.kind = kind;
      return err;
    }

    return {
      id: 'groq',
      name: 'Groq',
      longName: 'Groq',
      mark: '⚡',
      tint: '#f55036',
      host: 'api.groq.com',
      keyUrl: 'https://console.groq.com/keys',
      docsUrl: 'https://console.groq.com/docs',
      keyHint: 'gsk_…',
      fallbackModels: cleanModels([
        { id: 'openai/gpt-oss-120b', context: 131072 },
        { id: 'openai/gpt-oss-20b', context: 131072 },
        { id: 'qwen/qwen3-32b', context: 131072 },
        { id: 'moonshotai/kimi-k2-instruct-0905', context: 262144 },
        { id: 'llama-3.3-70b-versatile', context: 131072 }
      ]),
      available: ok,
      chat: function (opts) {
        if (!ok) {
          return Promise.reject(ProviderError(
            (typeof Groq !== 'undefined' && Groq.error) || 'Groq is unavailable.',
            { kind: 'error' }));
        }
        return Groq.streamChat(opts.apiKey, opts.model, normalizeMessages(opts.messages), {
          token: opts.token,
          temperature: opts.temperature,
          onDelta: opts.onDelta,
          onReasoning: opts.onReasoning
        }).then(resultOf).catch(function (err) { throw adapterError(err); });
      },
      complete: function (opts) {
        if (!ok) {
          return Promise.reject(ProviderError(
            (typeof Groq !== 'undefined' && Groq.error) || 'Groq is unavailable.',
            { kind: 'error' }));
        }
        return Groq.completeChat(opts.apiKey, opts.model, normalizeMessages(opts.messages), {
          token: opts.token,
          temperature: opts.temperature,
          onDelta: opts.onDelta,
          onReasoning: opts.onReasoning
        }).then(resultOf).catch(function (err) { throw adapterError(err); });
      },
      listModels: function (key) {
        if (!ok) {
          return Promise.reject(ProviderError(
            (typeof Groq !== 'undefined' && Groq.error) || 'Groq is unavailable.',
            { kind: 'error' }));
        }
        return Groq.listModels(key).then(function (models) {
          return cleanModels(models);
        }).catch(function (err) { throw adapterError(err); });
      },
      cancel: function (token) {
        if (ok) Groq.cancel(token);
      },
      test: function (key) { return testAdapter(this, key); }
    };
  }

  /* ---------------------------------------------------------------- registry */

  var adapters = {
    gemini: geminiAdapter(),
    openai: openAIAdapter({
      id: 'openai',
      name: 'OpenAI',
      longName: 'OpenAI',
      mark: '◎',
      tint: '#10a37f',
      host: 'api.openai.com',
      base: '/v1',
      keyUrl: 'https://platform.openai.com/api-keys',
      docsUrl: 'https://developers.openai.com/api/docs',
      keyHint: 'sk-…',
      streamUsage: true,
      rankPatterns: [/gpt-6\.1-sol/i, /gpt-6\.1/i, /gpt-6/i, /gpt-5/i, /gpt-4\.1/i, /gpt-4o/i],
      fallbackModels: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-4.1']
    }),
    anthropic: anthropicAdapter(),
    xai: openAIAdapter({
      id: 'xai',
      name: 'Grok',
      longName: 'xAI Grok',
      mark: 'X',
      tint: '#9aa4ad',
      host: 'api.x.ai',
      base: '/v1',
      keyUrl: 'https://console.x.ai/',
      docsUrl: 'https://docs.x.ai/',
      keyHint: 'xai-…',
      altModelsPath: '/language-models',
      keep: function (id) { return !/imagine|image|video|embed|tts|audio/i.test(id); },
      rankPatterns: [/grok-4\.7/i, /grok-4/i, /grok-3/i],
      fallbackModels: ['grok-4.7', 'grok-4', 'grok-3']
    }),
    deepseek: openAIAdapter({
      id: 'deepseek',
      name: 'DeepSeek',
      longName: 'DeepSeek',
      mark: 'D',
      tint: '#4d6bfe',
      host: 'api.deepseek.com',
      base: '',
      keyUrl: 'https://platform.deepseek.com/api_keys',
      docsUrl: 'https://api-docs.deepseek.com/',
      keyHint: 'sk-…',
      temperature: false,
      streamUsage: true,
      rankPatterns: [/^deepseek-flash$/i, /^deepseek-v4-pro$/i, /chat/i, /reasoner/i],
      fallbackModels: ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat']
    }),
    moonshot: openAIAdapter({
      id: 'moonshot',
      name: 'Kimi',
      longName: 'Moonshot Kimi',
      mark: 'K',
      tint: '#7c5cff',
      host: 'api.moonshot.ai',
      base: '/v1',
      keyUrl: 'https://platform.moonshot.ai/',
      docsUrl: 'https://platform.moonshot.ai/docs',
      keyHint: 'sk-…',
      rankPatterns: [/kimi-k3\.1-pro/i, /kimi-k3/i, /kimi-k2\.6/i, /kimi-latest/i, /kimi/i],
      fallbackModels: ['kimi-k3.1-pro', 'kimi-k3', 'kimi-k2.6']
    }),
    groq: groqAdapter()
  };

  var order = ['gemini', 'openai', 'anthropic', 'xai', 'deepseek', 'moonshot', 'groq'];
  var list = [];
  for (var i = 0; i < order.length; i++) list.push(adapters[order[i]]);

  function cancel(token) {
    for (var i = 0; i < list.length; i++) {
      try { list[i].cancel(token); } catch (e) { /* idle adapter */ }
    }
  }

  return {
    available: NODE_OK,
    order: order.slice(),
    all: function () { return list.slice(); },
    get: function (id) { return adapters[id] || null; },
    cancel: cancel,
    classify: classify,
    scrub: scrub,
    /* Test hook: swap the https.request factory. */
    _setRequestFactory: function (fn) { requestFactory = fn || function (options, cb) { return https.request(options, cb); }; }
  };
})();
