/*
 * groq.js — Groq chat completions (OpenAI-compatible).
 *
 * The panel talks to Groq over Node's https module rather than fetch so the
 * same code works in every CEP build and a Stop button can destroy the socket.
 *
 * Endpoints (verified against console.groq.com/docs):
 *   POST /openai/v1/chat/completions   stream=true  -> server-sent events
 *   GET  /openai/v1/models                          -> models available to the key
 *
 * The API key lives only in the Authorization header. It is never logged,
 * never placed in a URL, and never sent anywhere except api.groq.com.
 */
var Groq = (function () {
  'use strict';

  if (typeof NODE === 'undefined' || !NODE.ok) {
    return { ok: false, error: 'Node.js is not available, so AI Chat is disabled.' };
  }

  var https = NODE.https;
  var HOST = 'api.groq.com';
  var BASE = '/openai/v1';
  var IDLE_TIMEOUT = 90000;
  var USER_AGENT = 'openCaption-ai-chat';

  /* In-flight requests, so Stop can hang up immediately. */
  var active = [];

  function cancelError() {
    var e = new Error('Stopped.');
    e.cancelled = true;
    return e;
  }

  function cancel(token) {
    for (var i = active.length - 1; i >= 0; i--) {
      var entry = active[i];
      if (token && entry.token !== token) continue;
      active.splice(i, 1);
      try { entry.req.destroy(cancelError()); } catch (e) { /* already closed */ }
    }
  }

  function scrub(text) {
    return String(text || '').replace(/gsk_[A-Za-z0-9_\-]+/g, 'gsk_…');
  }

  function apiMessage(text, status) {
    var message = '';
    try {
      var parsed = JSON.parse(text);
      if (parsed && parsed.error) message = parsed.error.message || parsed.error.code || '';
      else if (parsed && parsed.message) message = parsed.message;
    } catch (e) { /* not JSON */ }

    if (status === 401) return 'Invalid API key. Check the key at console.groq.com/keys.';
    if (status === 403) return 'This API key is not allowed to use the selected model.';
    if (status === 404) return 'Model unavailable: ' + scrub(message || 'the model was not found.');
    if (status === 429) return 'Rate limited by Groq. Wait a moment and try again.';
    if (status >= 500) return 'Groq returned an error (HTTP ' + status + '). ' + scrub(message || '');
    return message ? scrub(message) : 'Groq request failed (HTTP ' + status + ').';
  }

  function statusError(status, text) {
    var e = new Error(apiMessage(text, status));
    e.status = status;
    e.body = text || '';
    return e;
  }

  function headersFor(apiKey, payload, accept) {
    var headers = {
      'Authorization': 'Bearer ' + apiKey,
      'Accept': accept || 'application/json',
      'User-Agent': USER_AGENT
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    return headers;
  }

  /* ------------------------------------------------------------ plain request */

  function request(apiKey, method, path, body) {
    return new Promise(function (resolve, reject) {
      var payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
      var req = https.request({
        hostname: HOST,
        port: 443,
        path: BASE + path,
        method: method,
        headers: headersFor(apiKey, payload),
        timeout: IDLE_TIMEOUT
      }, function (res) {
        var chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, text: text, headers: res.headers });
          } else {
            reject(statusError(res.statusCode, text));
          }
        });
        res.on('error', reject);
      });

      req.on('timeout', function () {
        req.destroy(new Error('Groq did not respond for ' + (IDLE_TIMEOUT / 1000) + 's. Check the connection and try again.'));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /* ------------------------------------------------------------ chat, streamed */

  function streamChat(apiKey, model, messages, handlers) {
    handlers = handlers || {};
    var token = handlers.token || {};

    return new Promise(function (resolve, reject) {
      var payload = Buffer.from(JSON.stringify({
        model: model,
        messages: messages,
        stream: true,
        temperature: typeof handlers.temperature === 'number' ? handlers.temperature : 0.7
      }), 'utf8');

      var settled = false;
      var entry = null;
      var text = '';
      var reasoning = '';
      var usage = null;
      var finishReason = '';

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        var at = active.indexOf(entry);
        if (at >= 0) active.splice(at, 1);
        fn(value);
      }

      var req = https.request({
        hostname: HOST,
        port: 443,
        path: BASE + '/chat/completions',
        method: 'POST',
        headers: headersFor(apiKey, payload, 'text/event-stream'),
        timeout: IDLE_TIMEOUT
      }, function (res) {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          var chunks = [];
          res.on('data', function (d) { chunks.push(d); });
          res.on('end', function () {
            finish(reject, statusError(res.statusCode, Buffer.concat(chunks).toString('utf8')));
          });
          res.on('error', function (e) { finish(reject, e); });
          return;
        }

        var buffer = '';

        function handleEvent(block) {
          var data = [];
          var lines = block.split('\n');
          for (var i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('data:') !== 0) continue;
            data.push(lines[i].slice(5).replace(/^ /, ''));
          }
          if (!data.length) return;

          var raw = data.join('\n').trim();
          if (!raw || raw === '[DONE]') return;

          var json = null;
          try { json = JSON.parse(raw); } catch (e) { return; }

          if (json.error) {
            var code = Number(json.error.code) || res.statusCode;
            finish(reject, statusError(code, JSON.stringify(json)));
            return;
          }

          if (json.usage) usage = json.usage;
          if (json.x_groq && json.x_groq.usage) usage = json.x_groq.usage;

          var choice = json.choices && json.choices[0];
          if (!choice) return;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          var delta = choice.delta || {};
          var piece = delta.content;
          if (typeof piece === 'string' && piece) {
            text += piece;
            if (handlers.onDelta) handlers.onDelta(piece, text);
          }
          var thought = delta.reasoning || delta.reasoning_content;
          if (typeof thought === 'string' && thought) {
            reasoning += thought;
            if (handlers.onReasoning) handlers.onReasoning(thought, reasoning);
          }
        }

        res.on('data', function (chunk) {
          if (token.cancelled) {
            req.destroy(cancelError());
            return;
          }
          buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
          var at;
          while ((at = buffer.indexOf('\n\n')) >= 0) {
            var block = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            handleEvent(block);
          }
        });

        res.on('end', function () {
          if (settled) return;
          if (buffer.trim()) handleEvent(buffer);
          finish(resolve, {
            text: text, reasoning: reasoning, usage: usage,
            finishReason: finishReason, model: model
          });
        });

        res.on('error', function (e) {
          finish(reject, token.cancelled ? cancelError() : e);
        });
      });

      entry = { req: req, token: token };
      active.push(entry);

      req.on('timeout', function () {
        req.destroy(new Error('Groq did not respond for ' + (IDLE_TIMEOUT / 1000) + 's. Check the connection and try again.'));
      });
      req.on('error', function (e) {
        finish(reject, token.cancelled ? cancelError() : e);
      });
      req.write(payload);
      req.end();
    });
  }

  /* --------------------------------------------------------- chat, not streamed */

  function completeChat(apiKey, model, messages, handlers) {
    handlers = handlers || {};
    return request(apiKey, 'POST', '/chat/completions', {
      model: model,
      messages: messages,
      stream: false,
      temperature: typeof handlers.temperature === 'number' ? handlers.temperature : 0.7
    }).then(function (res) {
      var json = null;
      try { json = JSON.parse(res.text); } catch (e) { json = null; }
      if (!json || !json.choices || !json.choices[0]) {
        throw new Error('Groq returned an unexpected response.');
      }
      var message = json.choices[0].message || {};
      var content = typeof message.content === 'string' ? message.content : '';
      var reasoning = String(message.reasoning || message.reasoning_content || '');
      if (handlers.onDelta && content) handlers.onDelta(content, content);
      if (handlers.onReasoning && reasoning) handlers.onReasoning(reasoning, reasoning);
      return {
        text: content,
        reasoning: reasoning,
        usage: json.usage || null,
        finishReason: json.choices[0].finish_reason || '',
        model: json.model || model
      };
    });
  }

  /* ----------------------------------------------------------------- models */

  var SKIP = /(whisper|tts|embed|guard|safeguard|rerank|moderation|audio)/i;

  function modelRank(id) {
    if (/gpt-oss-120b/i.test(id)) return 0;
    if (/gpt-oss-20b/i.test(id)) return 1;
    if (/kimi/i.test(id)) return 2;
    if (/qwen/i.test(id)) return 3;
    if (/llama-3\.3/i.test(id)) return 4;
    if (/llama/i.test(id)) return 5;
    return 6;
  }

  function listModels(apiKey) {
    return request(apiKey, 'GET', '/models', null).then(function (res) {
      var json = null;
      try { json = JSON.parse(res.text); } catch (e) { json = null; }
      var list = (json && json.data) || [];
      var models = [];
      for (var i = 0; i < list.length; i++) {
        var m = list[i] || {};
        var id = String(m.id || '');
        if (!id || SKIP.test(id)) continue;
        if (m.active === false) continue;
        models.push({ id: id, context: Number(m.context_window) || 0 });
      }
      models.sort(function (a, b) {
        return modelRank(a.id) - modelRank(b.id) || a.id.localeCompare(b.id);
      });
      return models;
    });
  }

  /** Verifies the key by asking Groq which models it may use. */
  function verify(apiKey) {
    return listModels(apiKey).then(function (models) {
      return { ok: true, models: models };
    }).catch(function (e) {
      return {
        ok: false,
        status: e.status || 0,
        kind: classify(e),
        error: e.message || 'Could not reach Groq.'
      };
    });
  }

  /** Maps an error to the state names the chat UI shows. */
  function classify(err) {
    if (!err) return 'error';
    if (err.cancelled) return 'cancelled';
    if (err.status === 401 || err.status === 403) return 'invalid';
    if (err.status === 404) return 'model';
    if (err.status === 429) return 'rate';
    if (err.status >= 500) return 'network';
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|socket hang up|network/i.test(
      String(err.code || '') + ' ' + String(err.message || ''))) return 'network';
    return 'error';
  }

  return {
    ok: true,
    id: 'groq',
    name: 'Groq',
    endpoint: 'https://' + HOST + BASE + '/chat/completions',
    verify: verify,
    listModels: listModels,
    streamChat: streamChat,
    completeChat: completeChat,
    cancel: cancel,
    classify: classify,
    /* Test hooks. */
    _apiMessage: apiMessage,
    _modelRank: modelRank
  };
})();
