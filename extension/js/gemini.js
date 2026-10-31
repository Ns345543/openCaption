/*
 * gemini.js — Gemini audio transcription over the REST API.
 *
 * One request = one 30s-ish slice of sequence audio. The model returns cues with
 * times measured from the start of that slice, which the caller offsets by the
 * slice's position in the sequence.
 *
 * Generation uses the streaming endpoint (:streamGenerateContent): a non-streamed
 * call sends nothing at all until the model has finished, which shows up as a bare
 * socket timeout on slow/thinking models. Streaming also lets us ignore "thought"
 * parts, which are not part of the transcript.
 */
var Gemini = (function () {
  if (!NODE.ok) return { ok: false, error: NODE.error };

  var https = NODE.https;
  var HOST = 'generativelanguage.googleapis.com';
  var API_VERSION = 'v1beta';
  var SOCKET_TIMEOUT = 60000;

  var RETRY_STATUS = { 429: true, 500: true, 502: true, 503: true, 504: true };

  /* In-flight streaming requests, so a cancel can hang up on all of them at
     once instead of waiting out the socket timeout. */
  var activeRequests = [];

  function cancelError() {
    var e = new Error('Cancelled.');
    e.cancelled = true;
    return e;
  }

  /** Destroys every live request for the given token (or all of them). */
  function cancel(token) {
    for (var i = activeRequests.length - 1; i >= 0; i--) {
      var entry = activeRequests[i];
      if (token && entry.token !== token) continue;
      activeRequests.splice(i, 1);
      try { entry.req.destroy(cancelError()); } catch (e) { /* already closed */ }
    }
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function headersFor(apiKey, payload, accept) {
    var headers = { 'x-goog-api-key': apiKey, 'Accept': accept || 'application/json' };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    return headers;
  }

  /* ------------------------------------------------------------- plain GET/POST */

  function request(apiKey, method, urlPath, body) {
    return new Promise(function (resolve, reject) {
      var payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;

      var req = https.request({
        hostname: HOST,
        port: 443,
        path: urlPath,
        method: method,
        headers: headersFor(apiKey, payload),
        timeout: SOCKET_TIMEOUT
      }, function (res) {
        var chunks = [];
        res.on('data', function (d) { chunks.push(d); });
        res.on('end', function () {
          var text = Buffer.concat(chunks).toString('utf8');
          var json = null;
          try { json = text ? JSON.parse(text) : {}; } catch (e) { json = null; }
          resolve({ status: res.statusCode, json: json, text: text });
        });
        res.on('error', reject);
      });

      req.on('timeout', function () {
        req.destroy(new Error('Request timed out after ' + (SOCKET_TIMEOUT / 1000) + 's with no response.'));
      });
      req.on('error', reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  /* ------------------------------------------------------------ SSE streaming */

  function streamGenerate(apiKey, model, body, onBytes, token) {
    return new Promise(function (resolve, reject) {
      var payload = Buffer.from(JSON.stringify(body), 'utf8');
      var urlPath = '/' + API_VERSION + '/models/' + encodeURIComponent(model) +
                    ':streamGenerateContent?alt=sse';

      var startedAt = Date.now();
      var headersMs = null;
      var firstByteMs = null;
      var settled = false;
      var entry = null;

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        var at = activeRequests.indexOf(entry);
        if (at >= 0) activeRequests.splice(at, 1);
        fn(value);
      }

      var req = https.request({
        hostname: HOST,
        port: 443,
        path: urlPath,
        method: 'POST',
        headers: headersFor(apiKey, payload, 'text/event-stream'),
        timeout: SOCKET_TIMEOUT
      }, function (res) {
        headersMs = Date.now() - startedAt;

        if (res.statusCode !== 200) {
          var chunks = [];
          res.on('data', function (d) { chunks.push(d); });
          res.on('end', function () {
            var text = Buffer.concat(chunks).toString('utf8');
            var json = null;
            try { json = text ? JSON.parse(text) : {}; } catch (e) { json = null; }
            finish(resolve, { status: res.statusCode, json: json, text: text, headersMs: headersMs });
          });
          res.on('error', function (e) { finish(reject, e); });
          return;
        }

        var buffer = '';
        var text = '';
        var transcript = '';
        var finishReason = '';
        var usage = null;
        var blocked = null;

        res.setEncoding('utf8');
        res.on('data', function (chunk) {
          if (firstByteMs === null) firstByteMs = Date.now() - startedAt;

          buffer += chunk;
          var idx;
          while ((idx = buffer.indexOf('\n')) >= 0) {
            var line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (line.indexOf('data:') !== 0) continue;

            var payloadText = line.slice(5).trim();
            if (!payloadText || payloadText === '[DONE]') continue;

            var obj;
            try { obj = JSON.parse(payloadText); } catch (e) { continue; }

            if (obj.promptFeedback && obj.promptFeedback.blockReason) {
              blocked = obj.promptFeedback.blockReason;
            }

            var cand = obj.candidates && obj.candidates[0];
            if (cand) {
              if (cand.finishReason) finishReason = cand.finishReason;
              var parts = (cand.content && cand.content.parts) || [];
              for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (!part) continue;
                // "thought" parts are the model's reasoning, never subtitle text.
                if (part.text && !part.thought) {
                  text += part.text;
                  if (onBytes) onBytes(text.length + transcript.length);
                }
                /* Dedicated *-transcribe models do not answer in the parts[].text
                   field: they return the words in parts[].audioTranscription.
                   Without this the transcript was dropped and every slice was
                   reported as "no speech". */
                if (part.audioTranscription && part.audioTranscription.text) {
                  var chunkText = part.audioTranscription.text;
                  /* Streams may send deltas or the whole transcript so far;
                     keep the text without duplicating it either way. */
                  if (transcript && chunkText.indexOf(transcript) === 0) transcript = chunkText;
                  else transcript += chunkText;
                  if (onBytes) onBytes(text.length + transcript.length);
                }
              }
            }
            if (obj.usageMetadata) usage = obj.usageMetadata;
          }
        });

        res.on('end', function () {
          finish(resolve, {
            status: 200, streamed: true, text: text, transcript: transcript,
            finish: finishReason, usage: usage,
            blocked: blocked, headersMs: headersMs, firstByteMs: firstByteMs
          });
        });
        res.on('error', function (e) { finish(reject, e); });
      });

      entry = { token: token || null, req: req };
      activeRequests.push(entry);

      req.on('timeout', function () {
        // The socket opened (or the request was sent) but nothing came back.
        // Say exactly how far it got: that is the difference between a dead
        // connection and a model that is still "thinking".
        var where;
        if (headersMs === null) {
          where = 'the request was sent but the server never answered';
        } else if (firstByteMs === null) {
          where = 'the server accepted the request but the model produced nothing';
        } else {
          where = 'the stream stalled after ' + (firstByteMs / 1000).toFixed(1) + 's';
        }
        var err = new Error('no output for ' + (SOCKET_TIMEOUT / 1000) + 's — ' + where + '.');
        err.timedOut = true;
        err.headersMs = headersMs;
        err.firstByteMs = firstByteMs;
        req.destroy(err);
      });
      req.on('error', function (e) { finish(reject, e); });
      req.write(payload);
      req.end();
    });
  }

  function errorMessage(res) {
    if (res.json && res.json.error && res.json.error.message) {
      var st = res.json.error.status ? ' (' + res.json.error.status + ')' : '';
      return res.json.error.message + st;
    }
    var snippet = String(res.text || '').replace(/\s+/g, ' ').slice(0, 240);
    return 'HTTP ' + res.status + (snippet ? ': ' + snippet : '');
  }

  /* ------------------------------------------- transcribe word timestamps */

  /* Dedicated transcribe models expose the Interactions endpoint, which can
     return a timestamp for every word. Asking the old generateContent endpoint
     for them yields plain text only, which forced the panel to guess where each
     word sat — and made captions run through pauses. */

  function parseOffset(value) {
    if (typeof value === 'number') return isFinite(value) ? value : null;
    var s = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (!s) return null;
    if (s.indexOf(':') >= 0) {
      var parts = s.split(':');
      var seconds = 0;
      for (var i = 0; i < parts.length; i++) seconds = seconds * 60 + (parseFloat(parts[i]) || 0);
      return isFinite(seconds) ? seconds : null;
    }
    var n = parseFloat(s);
    return isFinite(n) ? n : null;
  }

  /** Pulls text, word timings and token usage out of an interaction response. */
  function parseInteraction(json) {
    var words = [];
    var textParts = [];
    var steps = (json && json.steps) || [];

    for (var i = 0; i < steps.length; i++) {
      var content = steps[i] && steps[i].content;
      if (!content) continue;
      if (!Array.isArray(content)) content = [content];

      for (var c = 0; c < content.length; c++) {
        var item = content[c] || {};
        if (typeof item.text === 'string' && item.text) textParts.push(item.text);

        var annotations = item.annotations || [];
        for (var a = 0; a < annotations.length; a++) {
          var an = annotations[a] || {};
          var type = String(an.type || '');
          if (type && type !== 'word_info') continue;

          var word = String(an.text || '').trim();
          var start = parseOffset(an.start_offset !== undefined ? an.start_offset : an.startOffset);
          var end = parseOffset(an.end_offset !== undefined ? an.end_offset : an.endOffset);
          if (!word || start === null || end === null) continue;
          if (end < start) { var swap = start; start = end; end = swap; }
          words.push({
            text: word,
            start: Math.max(0, start),
            end: Math.max(start + 0.02, end),
            speaker: an.speaker ? String(an.speaker) : ''
          });
        }
      }
    }

    words.sort(function (x, y) { return x.start - y.start || x.end - y.end; });

    var text = textParts.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) text = words.map(function (w) { return w.text; }).join(' ');

    var usage = null;
    if (json && json.usage && isFinite(Number(json.usage.total_tokens))) {
      usage = { totalTokenCount: Number(json.usage.total_tokens) };
    }
    return { words: words, text: text, usage: usage };
  }

  /** Verbatim transcription with a word timestamp for every spoken word. */
  async function transcribeWords(opts) {
    var started = Date.now();
    var audio = opts.wavBuffer.toString('base64');

    /* Field casing has differed between API revisions; the documented shape
       for this endpoint is snake_case, with camelCase as the fallback. */
    var configs = [
      { generation_config: { transcription_config: { mode: {
        type: 'verbatim', timestamp_granularities: ['word'] } } } },
      { generationConfig: { transcriptionConfig: { mode: {
        type: 'verbatim', timestampGranularities: ['word'] } } } }
    ];

    var lastError = '';

    for (var v = 0; v < configs.length; v++) {
      var body = {
        model: opts.model,
        input: [{ type: 'audio', data: audio, mime_type: 'audio/wav' }]
      };
      for (var key in configs[v]) {
        if (Object.prototype.hasOwnProperty.call(configs[v], key)) body[key] = configs[v][key];
      }

      var res = null;
      for (var attempt = 1; attempt <= 3; attempt++) {
        try {
          res = await request(opts.apiKey, 'POST', '/' + API_VERSION + '/interactions', body);
        } catch (e) {
          throw new Error('Network error: ' + e.message);
        }

        if (res.status === 200) break;

        lastError = errorMessage(res);
        /* A per-day cap will not clear in the seconds a retry buys, and the
           plain-transcription fallback draws on the same quota. */
        if (res.status === 429 && /per day|daily/i.test(lastError)) break;
        if (RETRY_STATUS[res.status] && attempt < 3) {
          await delay(1200 * attempt);
          continue;
        }
        break;
      }

      if (res && res.status === 200) {
        if (res.json && res.json.status && res.json.status !== 'completed') {
          lastError = 'the transcription ended with status "' + res.json.status + '"';
          break;
        }
        if (!res.json || !Array.isArray(res.json.steps)) {
          lastError = 'the transcription response had no steps';
          break;
        }
        /* An empty result is a valid answer: that slice simply has no speech.
           Only an unreadable response is treated as a failure. */
        var parsed = parseInteraction(res.json);
        return {
          words: parsed.words,
          transcript: parsed.text,
          usage: parsed.usage,
          ms: Date.now() - started
        };
      }

      lastError = lastError || 'Word-timestamped transcription failed.';
      if (!(res && res.status === 400 && v + 1 < configs.length)) break;
    }

    var err = new Error(lastError || 'Word-timestamped transcription failed.');
    err.status = /quota|rate limit|resource_exhausted/i.test(lastError) ? 429 : 0;
    throw err;
  }

  /* ------------------------------------------------------------------ models */

  /** Validates the key and returns the list of usable model ids. */
  async function validateKey(apiKey) {
    if (!apiKey) return { ok: false, error: 'No API key.' };
    var res;
    try {
      res = await request(apiKey, 'GET', '/' + API_VERSION + '/models?pageSize=50', null);
    } catch (e) {
      return { ok: false, error: 'Network error: ' + e.message };
    }
    if (res.status === 200 && res.json && res.json.models) {
      var ids = res.json.models.map(function (m) { return String(m.name || '').replace(/^models\//, ''); });
      return { ok: true, models: ids };
    }
    var msg = errorMessage(res);
    if (res.status === 400 || res.status === 403) {
      msg += ' — check that the key is correct and the Generative Language API is enabled for its project.';
    }
    return { ok: false, error: msg, status: res.status };
  }

  /** Lower rank = better default for transcription: fast and cheap first. */
  function modelRank(id) {
    var m = String(id || '').toLowerCase();
    if (/transcribe/.test(m)) return 4;   // dedicated, but cannot do JSON mode
    if (/flash-lite/.test(m)) return 0;   // answers a short clip in ~2s
    if (/flash/.test(m)) return 2;
    if (/pro/.test(m)) return 3;
    return 1;
  }

  /** Filters the /models list down to models that can transcribe audio.
   *  Sorted fastest-first, so the caller's "first flash model" is a good default. */
  function audioModels(ids) {
    return (ids || []).filter(function (id) {
      if (!/^gemini/i.test(id)) return false;
      if (/embedding|aqa|imagen|veo|tts|live|image|dialog|computer|robotics/i.test(id)) return false;
      if (/-(exp|experimental)(-|$)/i.test(id)) return false;
      if (/-preview(-|$)/i.test(id)) return false;
      return true;
    }).sort(function (a, b) {
      var d = modelRank(a) - modelRank(b);
      if (d !== 0) return d;
      // Prefer a concrete version over a "-latest" alias: aliases move under
      // you, and one of them was the model that stalled for 60s.
      var aliasA = /-latest$/.test(a) ? 1 : 0;
      var aliasB = /-latest$/.test(b) ? 1 : 0;
      if (aliasA !== aliasB) return aliasA - aliasB;
      return a < b ? 1 : (a > b ? -1 : 0); // newest-ish first inside a tier
    });
  }

  /* ---------------------------------------------------------------- prompting */

  function languageRule(language) {
    if (!language || language === 'auto') {
      return 'Transcribe in the original spoken language. Do not translate.';
    }
    if (language === 'Hinglish') {
      return [
        'The speech is Hindi, or a natural mix of Hindi and English (code-switching).',
        'Write the transcript in ROMAN (Latin) letters only — Hinglish transliteration.',
        'NEVER output Devanagari or any other non-Latin script.',
        'Keep words the speaker actually says in English spelled normally (project, meeting, deadline, Friday).',
        'Spell Hindi words the way Indian speakers type them: hai, nahi, kya, matlab, thoda, bahut, karenge, samajh.',
        'Example: the Hindi sentence meaning "today we will discuss the new project" becomes "aaj hum naya project discuss karenge".'
      ].join(' ');
    }
    return 'The speech is in ' + language + '. Transcribe it in ' + language + '. Do not translate it into another language.';
  }

  function buildPrompt(opts) {
    var language = languageRule(opts.language);
    var per = opts.wordsPerLine || 2;
    var lines = opts.maxLines || 1;

    /* The model is asked for phrase-sized cues, not the panel's final
       layout: told to fit "2 words" it drops most of the sentence, and the
       panel splits and groups cues itself anyway. Six words keeps the phrase
       anchors tight; larger caption layouts allow a few more. */
    var promptCap = Math.max(6, per * lines);

    return [
      'You are a professional subtitle transcriber.',
      'Transcribe ALL intelligible speech in this audio file, verbatim and in chronological order.',
      '',
      'Rules:',
      '- "start" and "end" are seconds measured from the FIRST SAMPLE of this audio file. The file is exactly ' + opts.duration.toFixed(2) + ' seconds long.',
      '- Place "start" on the first audible syllable of the phrase and "end" just after its last syllable. Never pad a cue with silence at either edge — the timestamps are checked against the waveform.',
      '- One short cue per natural phrase or breath group — usually 2-6 words, never longer than 3.0 seconds. Break a long sentence after a comma or between clauses even when the speaker does not pause. Prefer two short cues over one long one.',
      '- Keep each cue to at most ' + promptCap + ' words. Never drop, shorten or summarise speech to satisfy a length limit: more cues are always better than missing words.',
      '- Split a long sentence after a comma or between clauses, never in the middle of a name, a number or a set phrase (for example "project deadline" or "Friday ko" should stay together).',
      '- Never put a line break or \\n inside the text; the panel lays the cue out itself.',
      '- ' + language,
      '- Keep punctuation and capitalisation natural. Keep filler words (um, uh) only if they are clearly audible.',
      '- Do not add speaker labels, sound effects, music descriptions, or commentary.',
      '- Do not invent dialogue. If a passage is silence, music, or unintelligible, leave a gap.',
      '- If the whole file has no speech, return {"cues": []}.',
      '',
      'Return JSON only.'
    ].join('\n');
  }

  var RESPONSE_SCHEMA = {
    type: 'OBJECT',
    properties: {
      cues: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            start: { type: 'NUMBER' },
            end: { type: 'NUMBER' },
            text: { type: 'STRING' }
          },
          required: ['start', 'end', 'text']
        }
      }
    },
    required: ['cues']
  };

  function buildBody(opts) {
    var generationConfig = {
      temperature: 0,
      topP: 0.95
    };
    if (opts.jsonMode !== false) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = RESPONSE_SCHEMA;
    }
    if (opts.thinking) generationConfig.thinkingConfig = opts.thinking;

    return {
      contents: [{
        role: 'user',
        parts: [
          { text: buildPrompt(opts) },
          { inlineData: { mimeType: 'audio/wav', data: opts.audioBase64 } }
        ]
      }],
      generationConfig: generationConfig,
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };
  }

  function stripFences(text) {
    var s = String(text || '').trim();
    if (s.indexOf('```') === 0) {
      s = s.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
    }
    return s.trim();
  }

  function parseCues(rawText) {
    var text = stripFences(rawText);
    if (!text) return [];
    var parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      var start = text.indexOf('{');
      var end = text.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try { parsed = JSON.parse(text.slice(start, end + 1)); } catch (e2) { parsed = null; }
      }
    }
    if (!parsed || !Array.isArray(parsed.cues)) return [];
    return parsed.cues
      .filter(function (c) { return c && typeof c.text === 'string' && c.text.trim(); })
      .map(function (c) {
        return {
          start: Number(c.start),
          end: Number(c.end),
          text: c.text.trim()
        };
      })
      .filter(function (c) { return isFinite(c.start) && isFinite(c.end); });
  }

  /* ------------------------------------------------------------- thinking */

  /*
   * Reasoning models answer "transcribe this" only after thinking, and some
   * emit nothing at all until they are done — the panel then looks hung even
   * though every packet arrived. Ask for the smallest reasoning budget the
   * model family understands.
   *
   * The field name and its value casing have changed between API revisions, so
   * the first rejected request falls through to the next spelling and finally
   * to no thinkingConfig at all. Whichever form works is remembered for the
   * session, so the negotiation costs at most one extra round trip.
   */
  var thinkingChoice = {}; // model id -> config object, or false for "send none"

  function thinkingPlans(model) {
    var id = String(model || '').toLowerCase();
    if (/transcribe/.test(id)) {
      // Dedicated transcription models have no reasoning stage at all.
      return [];
    }
    if (/^gemini-3/.test(id)) {
      // Flash models have a "minimal" level; Pro starts at "low". Value casing
      // has varied between API revisions, so a rejection falls through to LOW.
      var plans = /flash/.test(id)
        ? [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }]
        : [{ thinkingLevel: 'low' }];
      plans.push({ thinkingLevel: 'LOW' });
      return plans;
    }
    if (/^gemini-2\.5-flash/.test(id) || /^gemini-flash/.test(id)) {
      return [{ thinkingBudget: 0 }];
    }
    return [];
  }

  function thinkingFor(model) {
    var key = String(model || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(thinkingChoice, key)) {
      var cached = thinkingChoice[key];
      return cached === false ? [] : [cached];
    }
    return thinkingPlans(model);
  }

  /* ------------------------------------------------------------- transcription */

  function textRequestBody(model, prompt, thinking) {
    var body = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 16, temperature: 0 }
    };
    if (thinking) body.generationConfig.thinkingConfig = thinking;
    return {
      path: '/' + API_VERSION + '/models/' + encodeURIComponent(model) + ':generateContent',
      body: body
    };
  }

  /** Minimal round trip that proves the model answers at all. */
  async function testModel(apiKey, model) {
    var plans = thinkingFor(model);
    var thinking = plans.length ? plans[0] : null;
    var started = Date.now();

    for (var pass = 0; pass < 2; pass++) {
      var spec = textRequestBody(model, 'Reply with the single word OK.', thinking);

      try {
        var res = await request(apiKey, 'POST', spec.path, spec.body);
        var ms = Date.now() - started;
        if (res.status !== 200) {
          var msg = errorMessage(res);
          if (pass === 0 && thinking && res.status === 400 && /thinking/i.test(msg)) {
            thinking = null; // the model rejects the field; ask without it
            continue;
          }
          return { ok: false, ms: ms, error: msg };
        }
        var cand = res.json && res.json.candidates && res.json.candidates[0];
        var text = cand ? ((cand.content && cand.content.parts) || []).map(function (p) { return p.text || ''; }).join('') : '';
        return { ok: true, ms: ms, text: text.trim(), thinking: thinking };
      } catch (e) {
        return { ok: false, ms: Date.now() - started, error: e.message };
      }
    }

    return { ok: false, ms: Date.now() - started, error: 'Model rejected every request shape.' };
  }

  /**
   * One text-only round trip, for chores that are not transcription — such as
   * rewriting a Devanagari transcript in Roman letters.
   * opts: { apiKey, model, prompt, maxOutputTokens, jsonSchema }
   */
  async function generateText(opts) {
    var body = {
      contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
      generationConfig: { temperature: 0 }
    };
    if (opts.maxOutputTokens) body.generationConfig.maxOutputTokens = opts.maxOutputTokens;
    if (opts.jsonSchema) {
      body.generationConfig.responseMimeType = 'application/json';
      body.generationConfig.responseSchema = opts.jsonSchema;
    }

    var res = await request(opts.apiKey, 'POST',
      '/' + API_VERSION + '/models/' + encodeURIComponent(opts.model) + ':generateContent', body);

    if (res.status !== 200) {
      var err = new Error(errorMessage(res));
      err.status = res.status;
      throw err;
    }

    var cand = res.json && res.json.candidates && res.json.candidates[0];
    if (!cand) throw new Error('"' + opts.model + '" returned no candidates.');
    if (cand.finishReason && cand.finishReason !== 'STOP') {
      throw new Error('"' + opts.model + '" stopped early (' + cand.finishReason + ').');
    }

    var text = '';
    var parts = (cand.content && cand.content.parts) || [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i].text && !parts[i].thought) text += parts[i].text;
    }
    return text;
  }

  /** 1.2s of quiet tone, so the audio path can be probed without a timeline. */
  function toneWav(seconds) {
    var rate = 16000;
    var n = Math.floor(rate * (seconds || 1.2));
    var pcm = Buffer.alloc(n * 2);
    for (var i = 0; i < n; i++) {
      var v = Math.sin(2 * Math.PI * 220 * i / rate) * 0.2 * 32767;
      pcm.writeInt16LE(Math.round(v), i * 2);
    }
    var header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + pcm.length, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(pcm.length, 40);
    return Buffer.concat([header, pcm]);
  }

  /** Runs the real transcription path on a tiny synthetic clip. */
  async function testAudio(apiKey, model) {
    var started = Date.now();
    try {
      var res = await transcribe({
        apiKey: apiKey,
        model: model,
        wavBuffer: toneWav(1.2),
        duration: 1.2,
        language: 'auto',
        wordsPerLine: 2,
        maxLines: 1
      });
      return {
        ok: true,
        ms: Date.now() - started,
        firstByteMs: res.firstByteMs,
        cues: res.cues.length
      };
    } catch (e) {
      return { ok: false, ms: Date.now() - started, error: e.message };
    }
  }

  /**
   * Transcribes one audio slice.
   * opts: { apiKey, model, wavBuffer, duration, language, wordsPerLine, maxLines, onRetry, onProgress }
   * returns { cues, usage, ms, firstByteMs }
   */
  async function transcribe(opts) {
    var token = opts.token || null;
    var modelKey = String(opts.model || '').toLowerCase();

    /* Dedicated transcribe models can return the exact time of every word;
       use that instead of estimating word positions from the waveform. If the
       endpoint is unavailable, fall through to plain transcription. */
    if (/transcribe/.test(modelKey)) {
      try {
        var worded = await transcribeWords({
          apiKey: opts.apiKey,
          model: opts.model,
          wavBuffer: opts.wavBuffer
        });
        if (token && token.cancelled) throw cancelError();
        return {
          cues: [],
          words: worded.words,
          transcript: worded.transcript,
          usage: worded.usage,
          raw: '',
          finish: 'STOP',
          ms: worded.ms,
          headersMs: null,
          firstByteMs: null,
          streamed: false
        };
      } catch (e) {
        if (e && e.cancelled) throw e;
        /* A quota cap applies to the text fallback too, so don't spend another
           request proving it. */
        if (e.status === 429) throw e;
        if (opts.onNote) opts.onNote('word timestamps unavailable (' + e.message + '); timing from the waveform');
      }
    }

    var plans = thinkingFor(opts.model);
    var planIndex = 0;
    var thinking = plans.length ? plans[0] : null;
    // Dedicated *-transcribe models reject responseSchema; don't ask twice.
    var jsonMode = !/transcribe/.test(modelKey);

    function makeBody(config, useJson) {
      return buildBody({
        audioBase64: opts.wavBuffer.toString('base64'),
        duration: opts.duration,
        language: opts.language,
        wordsPerLine: opts.wordsPerLine,
        maxLines: opts.maxLines,
        thinking: config,
        jsonMode: useJson !== false
      });
    }

    var body = makeBody(thinking, jsonMode);

    var attempt = 0;
    var maxAttempts = 4;
    var timeouts = 0;
    var lastError = '';
    var startedAll = Date.now();

    while (attempt < maxAttempts) {
      if (token && token.cancelled) throw cancelError();
      attempt++;
      var res;

      try {
        res = await streamGenerate(opts.apiKey, opts.model, body, opts.onProgress, token);
      } catch (e) {
        if (e && e.cancelled) throw e;
        lastError = 'Network error: ' + e.message;

        if (e.timedOut) {
          timeouts++;
          // A model that answers with silence will not answer faster the
          // third time; stop instead of burning another minute.
          if (timeouts >= 2) {
            throw new Error('"' + opts.model + '" produced no output twice — ' + lastError +
              ' This is the model reasoning, not the network. Pick a different model, ' +
              'or press "test" to compare text vs audio.');
          }
        } else if (attempt >= maxAttempts) {
          throw new Error(lastError);
        }

        if (opts.onRetry) opts.onRetry(attempt, lastError);
        await delay(1000 * Math.pow(2, attempt - 1));
        continue;
      }

      if (res.status === 200) {
        thinkingChoice[modelKey] = thinking || false;

        if (res.blocked) throw new Error('The request was blocked by the API (' + res.blocked + ').');

        var finish = res.finish || '';
        if (finish && finish !== 'STOP') {
          if (finish === 'MAX_TOKENS') {
            throw new Error('Response was truncated (MAX_TOKENS). Shorten the chunk length in Advanced, or pick a model with a larger output budget.');
          }
          throw new Error('Generation stopped early: ' + finish + '.');
        }

        var text = res.text || '';
        var transcript = res.transcript || '';
        return {
          cues: parseCues(text),
          transcript: transcript,
          usage: res.usage || null,
          raw: text,
          finish: finish,
          ms: Date.now() - startedAll,
          headersMs: res.headersMs,
          firstByteMs: res.firstByteMs,
          streamed: true
        };
      }

      lastError = errorMessage(res);

      /* Some models (the dedicated *-transcribe ones, for instance) have no
         JSON mode. The prompt already asks for JSON, so drop the schema and
         let the text come back as plain output. */
      if (res.status === 400 && jsonMode &&
          /json mode|responsemimetype|responseschema|json output/i.test(lastError)) {
        jsonMode = false;
        body = makeBody(thinking, jsonMode);
        if (opts.onRetry) opts.onRetry(attempt, 'this model has no JSON mode; retrying with plain output');
        continue;
      }

      /* The API did not recognise the thinking field. Try the next spelling,
         then give up and send the request without it. */
      if (res.status === 400 && thinking && /thinking/i.test(lastError)) {
        if (planIndex + 1 < plans.length) {
          planIndex++;
          thinking = plans[planIndex];
          body = makeBody(thinking, jsonMode);
          if (opts.onRetry) opts.onRetry(attempt, 'the API rejected one thinking setting; trying another shape');
          continue;
        }
        thinkingChoice[modelKey] = false;
        thinking = null;
        plans = [];
        body = makeBody(null, jsonMode);
        if (opts.onRetry) opts.onRetry(attempt, 'this model does not accept a thinking setting; retrying without it');
        continue;
      }

      if (!RETRY_STATUS[res.status] || attempt >= maxAttempts) throw new Error(lastError);
      if (opts.onRetry) opts.onRetry(attempt, lastError);
      await delay(1500 * Math.pow(2, attempt - 1));
    }

    throw new Error(lastError || 'Transcription failed.');
  }

  return {
    ok: true,
    validateKey: validateKey,
    audioModels: audioModels,
    transcribe: transcribe,
    testModel: testModel,
    generateText: generateText,
    testAudio: testAudio,
    cancel: cancel,
    thinkingPlans: thinkingPlans,
    parseCues: parseCues
  };
})();
