/*
 * editor.js — cue-by-cue editor for the last generated caption run.
 *
 * Premiere's scripting API can create a caption track from an SRT and nothing
 * else: it cannot read, change or delete one. Edits therefore happen here, are
 * written to an SRT, and are imported as a new caption track at the same
 * timecodes. The tab says that plainly instead of pretending the old track is
 * patched in place.
 *
 * An SRT can also be opened here, and the cues exported as SRT or plain text.
 * A word replacer and a word remover edit every cue at once.
 * A file the user opened is kept as the source and is never written to; saves
 * and imports go to new files under %APPDATA%\CaptionAI.
 *
 * The last run is mirrored to %APPDATA%\CaptionAI\editor.json so reopening the
 * panel — or a Premiere restart — does not lose the cues.
 */
var Editor = (function () {
  if (typeof NODE === 'undefined' || !NODE.ok ||
      typeof Config === 'undefined' || !Config.ok ||
      typeof Srt === 'undefined') {
    return { init: function () {}, setRun: function () {} };
  }

  var fs = NODE.fs;
  var path = NODE.path;

  var STORE = path.join(Config.DATA_DIR, 'editor.json');
  var EDIT_DIR = path.join(Config.DATA_DIR, 'edits');
  var TRANSCRIPT_DIR = path.join(Config.DATA_DIR, 'transcripts');
  var REPLACEMENTS = path.join(Config.DATA_DIR, 'replacements.json');
  var REMOVALS = path.join(Config.DATA_DIR, 'remove-words.json');

  var state = {
    path: '',          // the panel's own SRT for this run
    source: '',        // an SRT the user imported; never written to
    sequence: '',
    cues: [],
    dirty: false,
    busy: false
  };
  var ui = {};
  var built = false;
  var saveTimer = 0;
  var pairs = [];        // find/replace rules, kept in replacements.json
  var pairTimer = 0;
  var removals = [];     // words to delete, kept in remove-words.json
  var removalTimer = 0;

  function $(id) { return document.getElementById(id); }

  function cueText(cue) {
    if (!cue) return '';
    if (cue.lines && cue.lines.length) return cue.lines.join('\n');
    return typeof cue.text === 'string' ? cue.text : '';
  }

  /** A cue the editor can handle, or null. Times in seconds, text with \n. */
  function normalise(cue) {
    var start = Number(cue && cue.start);
    var end = Number(cue && cue.end);
    var text = cueText(cue).replace(/\r\n?/g, '\n').trim();
    if (!isFinite(start) || !isFinite(end) || !text) return null;
    start = Math.max(0, start);
    if (end <= start) return null;
    return { start: start, end: end, text: text };
  }

  /** Accepts 00:01:02,340 · 01:02.340 · 62.34 (and dots for commas). */
  function parseTime(value) {
    var s = String(value === undefined || value === null ? '' : value)
      .trim().replace(/\s+/g, '');
    if (!s) return null;

    var m = /^(\d{1,2}):(\d{2}):(\d{2})[.,](\d{1,3})$/.exec(s);
    if (m) {
      return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) +
        Number(m[4]) / Math.pow(10, m[4].length);
    }
    m = /^(\d{1,3}):(\d{2})[.,](\d{1,3})$/.exec(s);
    if (m) {
      return Number(m[1]) * 60 + Number(m[2]) +
        Number(m[3]) / Math.pow(10, m[3].length);
    }
    m = /^(\d+(?:[.,]\d{1,3})?)$/.exec(s);
    if (m) return Number(m[1].replace(',', '.'));

    return null;
  }

  /** SRT text for the current cues; manual line breaks are kept. */
  function srtText(cues) {
    var list = [];
    for (var i = 0; i < cues.length; i++) {
      var lines = String(cues[i].text || '')
        .split('\n')
        .map(function (line) { return line.replace(/\s+/g, ' ').trim(); })
        .filter(Boolean);
      if (!lines.length) continue;
      list.push({
        start: cues[i].start,
        end: cues[i].end,
        text: lines.join(' '),
        lines: lines
      });
    }
    return Srt.build(list);
  }

  /** The transcript as plain text: one cue per line, timecodes left out. */
  function transcriptText(cues) {
    var out = [];
    for (var i = 0; i < cues.length; i++) {
      var line = String(cues[i].text || '')
        .split('\n')
        .map(function (part) { return part.replace(/\s+/g, ' ').trim(); })
        .filter(Boolean)
        .join(' ');
      if (line) out.push(line);
    }
    return out.join('\n') + (out.length ? '\n' : '');
  }

  function setStatus(text, cls) {
    if (!ui.status) return;
    ui.status.textContent = text || '';
    ui.status.className = 'editor-status' + (cls ? ' ' + cls : '');
    ui.status.classList.toggle('hidden', !text);
  }

  function badge() {
    if (!ui.badge) return;
    var n = state.cues.length;
    ui.badge.textContent = n
      ? n + (n === 1 ? ' cue' : ' cues') + (state.dirty ? ' *' : '')
      : 'no run';
    ui.badge.className = 'badge' + (n ? ' ok' : '');
    ui.badge.title = state.dirty ? 'Edits are not saved yet' : '';
  }

  function suggestions() {
    var n = 0;
    for (var i = 0; i < state.cues.length; i++) {
      if (state.cues[i].suggest) n++;
    }
    return n;
  }

  function updateFixAll() {
    if (!ui.fixAll) return;
    var n = suggestions();
    ui.fixAll.classList.toggle('hidden', !n);
    ui.fixAll.textContent = 'Fix all (' + n + ')';
  }

  function setBusy(busy) {
    state.busy = busy;
    if (ui.check) {
      ui.check.disabled = busy;
      ui.check.textContent = busy ? 'Checking…' : 'Check spelling';
    }
    if (ui.importBtn) ui.importBtn.disabled = busy;
    if (ui.saveBtn) ui.saveBtn.disabled = busy;
    if (ui.importSrtBtn) ui.importSrtBtn.disabled = busy;
    if (ui.importSrtEmpty) ui.importSrtEmpty.disabled = busy;
    if (ui.exportSrtBtn) ui.exportSrtBtn.disabled = busy || !state.cues.length;
    if (ui.exportBtn) ui.exportBtn.disabled = busy || !state.cues.length;
    if (ui.replaceMenu) ui.replaceMenu.disabled = busy || !state.cues.length;
    if (ui.removeMenu) ui.removeMenu.disabled = busy || !state.cues.length;
  }

  function menuOpen() {
    return !!(ui.menu && !ui.menu.classList.contains('hidden'));
  }

  function setMenu(open) {
    if (!ui.menu || !ui.menuBtn) return;
    ui.menu.classList.toggle('hidden', !open);
    ui.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function loadPairs() {
    try {
      if (!fs.existsSync(REPLACEMENTS)) return;
      var raw = JSON.parse(fs.readFileSync(REPLACEMENTS, 'utf8'));
      var list = raw && Array.isArray(raw.pairs) ? raw.pairs : [];
      pairs = list.slice(0, 40).map(function (pair) {
        return {
          find: String((pair && pair.find) || ''),
          replace: String((pair && pair.replace) || '')
        };
      });
    } catch (e) { pairs = []; }
  }

  function savePairs() {
    try {
      Config.ensureDirs();
      fs.writeFileSync(REPLACEMENTS,
        JSON.stringify({ version: 1, pairs: pairs }, null, 2), 'utf8');
    } catch (e) { /* a lost list must not break the panel */ }
  }

  function savePairsSoon() {
    clearTimeout(pairTimer);
    pairTimer = setTimeout(savePairs, 500);
  }

  function renderPairs() {
    if (!ui.replaceList) return;

    if (!pairs.length) pairs.push({ find: '', replace: '' });
    ui.replaceList.innerHTML = '';

    pairs.forEach(function (pair, index) {
      var row = document.createElement('div');
      row.className = 'replacer-row';
      row.dataset.i = String(index);

      var find = document.createElement('input');
      find.type = 'text';
      find.dataset.role = 'find';
      find.value = pair.find;
      find.placeholder = 'wrong word';
      find.spellcheck = false;
      find.setAttribute('aria-label', 'Word to replace ' + (index + 1));

      var arrow = document.createElement('span');
      arrow.className = 'cue-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';

      var rep = document.createElement('input');
      rep.type = 'text';
      rep.dataset.role = 'replace';
      rep.value = pair.replace;
      rep.placeholder = 'correct word';
      rep.spellcheck = false;
      rep.setAttribute('aria-label', 'Replace word ' + (index + 1) + ' with');

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'cue-del';
      rm.dataset.role = 'rm';
      rm.title = 'Remove this replacement';
      rm.setAttribute('aria-label', rm.title);
      rm.textContent = '×';

      row.appendChild(find);
      row.appendChild(arrow);
      row.appendChild(rep);
      row.appendChild(rm);
      ui.replaceList.appendChild(row);
    });
  }

  function onPairInput(e) {
    var row = e.target.closest ? e.target.closest('.replacer-row') : null;
    if (!row) return;
    var pair = pairs[Number(row.dataset.i)];
    if (!pair) return;
    var role = e.target.dataset.role;
    if (role !== 'find' && role !== 'replace') return;
    pair[role] = e.target.value;
    savePairsSoon();
  }

  function onPairClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-role="rm"]') : null;
    if (!btn) return;
    var row = btn.closest('.replacer-row');
    if (!row) return;
    pairs.splice(Number(row.dataset.i), 1);
    clearTimeout(pairTimer);
    savePairs();
    renderPairs();
  }

  function setReplacer(open) {
    if (!ui.replacePanel) return;
    if (open) setRemover(false);
    ui.replacePanel.classList.toggle('hidden', !open);
    if (!open) return;
    renderPairs();
    var first = ui.replaceList.querySelector('input');
    if (first) first.focus();
  }

  function loadRemovals() {
    try {
      if (!fs.existsSync(REMOVALS)) return;
      var raw = JSON.parse(fs.readFileSync(REMOVALS, 'utf8'));
      var list = raw && Array.isArray(raw.words) ? raw.words : [];
      removals = list.slice(0, 60).map(function (word) {
        return String(word || '');
      });
    } catch (e) { removals = []; }
  }

  function saveRemovals() {
    try {
      Config.ensureDirs();
      fs.writeFileSync(REMOVALS,
        JSON.stringify({ version: 1, words: removals }, null, 2), 'utf8');
    } catch (e) { /* a lost list must not break the panel */ }
  }

  function saveRemovalsSoon() {
    clearTimeout(removalTimer);
    removalTimer = setTimeout(saveRemovals, 500);
  }

  function renderRemovals() {
    if (!ui.removeList) return;

    if (!removals.length) removals.push('');
    ui.removeList.innerHTML = '';

    removals.forEach(function (word, index) {
      var row = document.createElement('div');
      row.className = 'replacer-row';
      row.dataset.i = String(index);

      var input = document.createElement('input');
      input.type = 'text';
      input.dataset.role = 'word';
      input.value = word;
      input.placeholder = 'word to remove';
      input.spellcheck = false;
      input.setAttribute('aria-label', 'Word to remove ' + (index + 1));

      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'cue-del';
      rm.dataset.role = 'rm';
      rm.title = 'Remove this word from the list';
      rm.setAttribute('aria-label', rm.title);
      rm.textContent = '×';

      row.appendChild(input);
      row.appendChild(rm);
      ui.removeList.appendChild(row);
    });
  }

  function onRemovalInput(e) {
    if (e.target.dataset.role !== 'word') return;
    var row = e.target.closest ? e.target.closest('.replacer-row') : null;
    if (!row) return;
    var index = Number(row.dataset.i);
    if (removals[index] === undefined) return;
    removals[index] = e.target.value;
    saveRemovalsSoon();
  }

  function onRemovalClick(e) {
    var btn = e.target.closest ? e.target.closest('[data-role="rm"]') : null;
    if (!btn) return;
    var row = btn.closest('.replacer-row');
    if (!row) return;
    removals.splice(Number(row.dataset.i), 1);
    clearTimeout(removalTimer);
    saveRemovals();
    renderRemovals();
  }

  function setRemover(open) {
    if (!ui.removePanel) return;
    if (open) setReplacer(false);
    ui.removePanel.classList.toggle('hidden', !open);
    if (!open) return;
    renderRemovals();
    var first = ui.removeList.querySelector('input');
    if (first) first.focus();
  }

  function escapePattern(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Whole-word, case-insensitive; falls back to \b on old engines. */
  function patternFor(find) {
    var escaped = escapePattern(find);
    try {
      return new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'giu');
    } catch (e) {
      return new RegExp('\\b' + escaped + '\\b', 'gi');
    }
  }

  function keepCase(matched, replacement) {
    if (!replacement) return '';
    var lower = matched.toLowerCase();
    var upper = matched.toUpperCase();
    if (matched === upper && matched !== lower) return replacement.toUpperCase();
    var head = matched.charAt(0);
    if (head && head === head.toUpperCase() && head !== head.toLowerCase()) {
      return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    }
    return replacement;
  }

  function applyReplacements() {
    var rules = pairs.filter(function (pair) {
      return String(pair.find || '').trim() !== '';
    }).map(function (pair) {
      return {
        find: String(pair.find).trim(),
        replace: String(pair.replace || ''),
        re: patternFor(String(pair.find).trim())
      };
    });

    if (!rules.length) {
      setStatus('Type the word to replace first.', 'warn');
      return;
    }
    if (!state.cues.length) {
      setStatus('There are no cues to replace in.', 'warn');
      return;
    }

    var hits = 0;
    var changedCues = 0;

    for (var i = 0; i < state.cues.length; i++) {
      var text = state.cues[i].text;
      var next = text;

      for (var r = 0; r < rules.length; r++) {
        var rule = rules[r];
        if (rule.replace === rule.find) continue;
        next = next.replace(rule.re, function (matched) {
          hits++;
          return keepCase(matched, rule.replace);
        });
      }

      if (next !== text) {
        state.cues[i].text = next;
        delete state.cues[i].suggest;
        changedCues++;
      }
    }

    var kept = state.cues.filter(function (cue) {
      return String(cue.text || '').trim() !== '';
    });
    var dropped = state.cues.length - kept.length;
    if (!hits && !dropped) {
      setStatus('No matches for those words in the cues.', 'warn');
      return;
    }

    state.cues = kept;
    savePairs();
    markDirty();
    render();
    if (!hits) {
      setStatus(dropped + (dropped === 1 ? ' empty cue was' : ' empty cues were') + ' dropped.', 'warn');
      return;
    }
    setStatus('Replaced ' + hits + (hits === 1 ? ' word' : ' words') +
      ' in ' + changedCues + (changedCues === 1 ? ' cue' : ' cues') + '.' +
      (dropped ? ' ' + dropped + (dropped === 1 ? ' empty cue was' : ' empty cues were') + ' dropped.' : ''),
      dropped ? 'warn' : 'ok');
  }

  /** Cleans up the gaps a deleted word leaves behind, one line at a time. */
  function tidyLine(line) {
    return String(line)
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .replace(/,(\s*,)+/g, ',')
      .replace(/^[\s,]+|[\s,]+$/g, '')
      .trim();
  }

  function applyRemovals() {
    var terms = removals.filter(function (word) {
      return String(word || '').trim() !== '';
    }).map(function (word) {
      return {
        find: String(word).trim(),
        re: patternFor(String(word).trim())
      };
    });

    if (!terms.length) {
      setStatus('Type a word to remove first.', 'warn');
      return;
    }
    if (!state.cues.length) {
      setStatus('There are no cues to remove from.', 'warn');
      return;
    }

    var hits = 0;
    var changedCues = 0;

    for (var i = 0; i < state.cues.length; i++) {
      var text = state.cues[i].text;
      var next = text;

      for (var t = 0; t < terms.length; t++) {
        next = next.replace(terms[t].re, function () {
          hits++;
          return '';
        });
      }

      if (next === text) continue;

      next = next.split('\n').map(tidyLine).join('\n');
      state.cues[i].text = next;
      delete state.cues[i].suggest;
      changedCues++;
    }

    var kept = state.cues.filter(function (cue) {
      return String(cue.text || '').trim() !== '';
    });
    var dropped = state.cues.length - kept.length;
    if (!hits && !dropped) {
      setStatus('No matches for those words in the cues.', 'warn');
      return;
    }

    state.cues = kept;
    saveRemovals();
    markDirty();
    render();
    if (!hits) {
      setStatus(dropped + (dropped === 1 ? ' empty cue was' : ' empty cues were') + ' dropped.', 'warn');
      return;
    }
    setStatus('Removed ' + hits + (hits === 1 ? ' word' : ' words') +
      ' from ' + changedCues + (changedCues === 1 ? ' cue' : ' cues') + '.' +
      (dropped ? ' ' + dropped + (dropped === 1 ? ' empty cue was' : ' empty cues were') + ' dropped.' : ''),
      dropped ? 'warn' : 'ok');
  }

  function fit(area) {
    /* A hidden tab has no layout: scrollHeight would collapse the box. The
       tab switch calls refresh(), which fits them once they are on screen. */
    if (!area.offsetParent) return;
    area.style.height = 'auto';
    area.style.height = Math.max(24, area.scrollHeight) + 'px';
  }

  function fitAll() {
    var areas = ui.list.querySelectorAll('.cue-text');
    for (var i = 0; i < areas.length; i++) fit(areas[i]);
  }

  /** One AI suggestion under a cue: the corrected text plus two choices. */
  function suggestionBlock(cue, index) {
    var box = document.createElement('div');
    box.className = 'cue-suggest';

    var label = document.createElement('span');
    label.className = 'cue-suggest-label';
    label.textContent = 'Suggested';

    var value = document.createElement('p');
    value.className = 'cue-suggest-text';
    value.textContent = cue.suggest;

    var use = document.createElement('button');
    use.type = 'button';
    use.className = 'btn sm';
    use.dataset.role = 'apply';
    use.textContent = 'Use this';
    use.title = 'Replace cue ' + (index + 1) + ' with the suggestion';

    var keep = document.createElement('button');
    keep.type = 'button';
    keep.className = 'linkbtn';
    keep.dataset.role = 'keep';
    keep.textContent = 'keep mine';
    keep.title = 'Dismiss this suggestion';

    box.appendChild(label);
    box.appendChild(value);
    box.appendChild(use);
    box.appendChild(keep);
    return box;
  }

  function render() {
    if (!built) return;

    var has = state.cues.length > 0;
    ui.empty.classList.toggle('hidden', has);
    ui.body.classList.toggle('hidden', !has);
    if (ui.reload) ui.reload.classList.toggle('hidden', !state.path && !state.source);
    if (ui.importSrtBtn) ui.importSrtBtn.disabled = state.busy;
    if (ui.importSrtEmpty) ui.importSrtEmpty.disabled = state.busy;
    if (ui.exportSrtBtn) ui.exportSrtBtn.disabled = state.busy || !has;
    if (ui.exportBtn) ui.exportBtn.disabled = state.busy || !has;
    if (ui.replaceMenu) ui.replaceMenu.disabled = state.busy || !has;
    if (ui.removeMenu) ui.removeMenu.disabled = state.busy || !has;

    ui.meta.textContent = has
      ? (state.source
          ? 'Cues from "' + path.basename(state.source) + '". Saves go to a new file — that SRT is not overwritten.'
          : state.sequence
            ? 'Cues from "' + state.sequence + '". Fix the text or timings, then import them back.'
            : 'Cues from the last run. Fix the text or timings, then import them back.')
      : 'Generate captions on the Transcribe tab, or import your own SRT.';

    ui.list.innerHTML = '';
    if (!has) { badge(); return; }

    state.cues.forEach(function (cue, index) {
      var row = document.createElement('div');
      row.className = 'cue';
      row.dataset.i = String(index);

      var head = document.createElement('div');
      head.className = 'cue-head';

      var num = document.createElement('span');
      num.className = 'cue-num';
      num.textContent = index < 9 ? '0' + (index + 1) : String(index + 1);

      var tIn = document.createElement('input');
      tIn.type = 'text';
      tIn.className = 'cue-t';
      tIn.dataset.role = 'in';
      tIn.value = Srt.formatTime(cue.start);
      tIn.setAttribute('aria-label', 'Cue ' + (index + 1) + ' start time');

      var arrow = document.createElement('span');
      arrow.className = 'cue-arrow';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';

      var tOut = document.createElement('input');
      tOut.type = 'text';
      tOut.className = 'cue-t';
      tOut.dataset.role = 'out';
      tOut.value = Srt.formatTime(cue.end);
      tOut.setAttribute('aria-label', 'Cue ' + (index + 1) + ' end time');

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'cue-del';
      del.dataset.role = 'del';
      del.title = 'Delete cue ' + (index + 1);
      del.setAttribute('aria-label', del.title);
      del.textContent = '×';

      head.appendChild(num);
      head.appendChild(tIn);
      head.appendChild(arrow);
      head.appendChild(tOut);
      head.appendChild(del);

      var text = document.createElement('textarea');
      text.className = 'cue-text';
      text.rows = 1;
      text.spellcheck = true;
      text.dataset.role = 'text';
      text.value = cue.text;
      text.setAttribute('aria-label', 'Cue ' + (index + 1) + ' text');

      row.appendChild(head);
      row.appendChild(text);
      if (cue.suggest) row.appendChild(suggestionBlock(cue, index));
      ui.list.appendChild(row);
    });

    fitAll();
    badge();
    updateFixAll();
  }

  function persist() {
    try {
      Config.ensureDirs();
      var payload = {
        version: 1,
        path: state.path,
        source: state.source,
        sequence: state.sequence,
        savedAt: new Date().toISOString(),
        cues: state.cues.map(function (cue) {
          return { start: cue.start, end: cue.end, text: cue.text };
        })
      };
      fs.writeFileSync(STORE, JSON.stringify(payload, null, 2), 'utf8');
    } catch (e) { /* a lost draft must never break the panel */ }
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 700);
  }

  function markDirty() {
    state.dirty = true;
    badge();
    scheduleSave();
  }

  function loadDraft() {
    try {
      if (!fs.existsSync(STORE)) return;
      var raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      if (!raw || !raw.cues || !raw.cues.length) return;

      var cues = [];
      for (var i = 0; i < raw.cues.length; i++) {
        var cue = normalise(raw.cues[i]);
        if (cue) cues.push(cue);
      }
      if (!cues.length) return;

      state.path = String(raw.path || '');
      state.source = String(raw.source || '');
      state.sequence = String(raw.sequence || '');
      state.cues = cues;
      state.dirty = false;
    } catch (e) { /* a corrupt draft is ignored */ }
  }

  function rowIndex(el) {
    var row = el && el.closest ? el.closest('.cue') : null;
    return row ? Number(row.dataset.i) : -1;
  }

  function onInput(e) {
    var el = e.target;
    var index = rowIndex(el);
    if (index < 0 || !state.cues[index]) return;

    var role = el.dataset.role;
    if (role === 'text') {
      state.cues[index].text = el.value;
      if (state.cues[index].suggest) {
        delete state.cues[index].suggest;
        var tip = el.parentNode.querySelector('.cue-suggest');
        if (tip) el.parentNode.removeChild(tip);
        updateFixAll();
      }
      fit(el);
    } else if (role === 'in' || role === 'out') {
      var time = parseTime(el.value);
      if (time === null) {
        el.classList.add('invalid');
        return;                    // keep the last valid value in state
      }
      el.classList.remove('invalid');
      state.cues[index][role === 'in' ? 'start' : 'end'] = time;
    } else {
      return;
    }
    markDirty();
  }

  function onListClick(e) {
    var target = e.target && e.target.closest ? e.target.closest('[data-role]') : null;
    if (!target) return;

    var role = target.dataset.role;
    var index = rowIndex(target);
    if (index < 0 || !state.cues[index]) return;
    var cue = state.cues[index];

    if (role === 'del') {
      e.preventDefault();
      state.cues.splice(index, 1);
      state.dirty = true;
      clearTimeout(saveTimer);
      persist();
      render();
      setStatus('Cue removed.', '');
      return;
    }

    if (role === 'apply') {
      e.preventDefault();
      if (!cue.suggest) return;
      cue.text = cue.suggest;
      delete cue.suggest;
      markDirty();
      render();
      setStatus('Applied the fix to cue ' + (index + 1) + '.', 'ok');
      return;
    }

    if (role === 'keep') {
      e.preventDefault();
      delete cue.suggest;
      render();
      setStatus('Kept your text in cue ' + (index + 1) + '.', '');
    }
  }

  /** Reads the inputs; returns {ok, cues} or {ok:false, error}. */
  function collect() {
    var rows = ui.list.querySelectorAll('.cue');
    if (!rows.length) return { ok: false, error: 'There are no cues to import.' };

    var cues = [];
    var errors = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var tIn = row.querySelector('[data-role="in"]');
      var tOut = row.querySelector('[data-role="out"]');
      var area = row.querySelector('[data-role="text"]');

      var start = parseTime(tIn.value);
      var end = parseTime(tOut.value);
      var text = area.value.replace(/\r\n?/g, '\n').trim();
      var bad = false;

      if (start === null) {
        tIn.classList.add('invalid');
        errors.push('Cue ' + (i + 1) + ': the start time is not valid.');
        bad = true;
      } else {
        tIn.classList.remove('invalid');
      }

      if (end === null) {
        tOut.classList.add('invalid');
        errors.push('Cue ' + (i + 1) + ': the end time is not valid.');
        bad = true;
      } else {
        tOut.classList.remove('invalid');
      }

      if (!bad && end <= start) {
        tOut.classList.add('invalid');
        errors.push('Cue ' + (i + 1) + ': the end time must be after the start.');
        bad = true;
      }

      if (!text) {
        area.classList.add('invalid');
        errors.push('Cue ' + (i + 1) + ' has no text.');
        bad = true;
      } else {
        area.classList.remove('invalid');
      }

      if (!bad) cues.push({ start: Math.max(0, start), end: end, text: text });
    }

    if (errors.length) {
      return {
        ok: false,
        error: errors.slice(0, 2).join(' ') + (errors.length > 2 ? ' …' : '')
      };
    }

    cues.sort(function (a, b) { return a.start - b.start || a.end - b.end; });
    return { ok: true, cues: cues };
  }

  function fixedPath() {
    if (state.path) return state.path;
    var base = state.source
      ? path.basename(state.source).replace(/\.srt$/i, '')
      : Config.sanitizeName(state.sequence || 'captions') + '_' + Config.timestamp();
    state.path = path.join(Config.CAPTION_DIR, base + '_' + Config.timestamp() + '.srt');
    return state.path;
  }

  function writeSrt(target, cues) {
    try {
      fs.writeFileSync(target, srtText(cues), 'utf8');
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** Next free path for the import copy; a new path makes Premiere re-read it. */
  function importPath() {
    if (!fs.existsSync(EDIT_DIR)) fs.mkdirSync(EDIT_DIR, { recursive: true });
    var base = path.basename(state.path).replace(/\.srt$/i, '');
    var stamp = Config.timestamp();
    var target = path.join(EDIT_DIR, base + '_edited_' + stamp + '.srt');
    var n = 2;
    while (fs.existsSync(target)) {
      target = path.join(EDIT_DIR, base + '_edited_' + stamp + '_' + n + '.srt');
      n++;
    }
    return target;
  }

  function saveOnly() {
    var res = collect();
    if (!res.ok) { setStatus(res.error, 'warn'); return; }

    var target = fixedPath();
    var written = writeSrt(target, res.cues);
    if (!written.ok) {
      setStatus('Could not write the SRT: ' + written.error, 'err');
      return;
    }

    state.cues = res.cues;
    state.dirty = false;
    clearTimeout(saveTimer);
    persist();
    render();
    setStatus('Saved ' + state.cues.length + ' cues to ' + target, 'ok');
  }

  function baseName() {
    if (state.source) return path.basename(state.source).replace(/\.[^.]+$/, '');
    if (state.path) return path.basename(state.path).replace(/\.srt$/i, '');
    return Config.sanitizeName(state.sequence || 'captions') + '_' + Config.timestamp();
  }

  function samePath(a, b) {
    if (!a || !b) return false;
    var clean = function (p) {
      return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    };
    return clean(a) === clean(b);
  }

  function ensureDir(dir) {
    try {
      if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (e) { /* the write that follows reports the failure */ }
  }

  /**
   * Asks where to write. Falls back to dir/name when CEP has no dialog.
   * Returns {ok:true, target} or {ok:false, cancelled:true}.
   */
  function chooseTarget(title, dir, name, types) {
    ensureDir(dir);

    var picked = { ok: false, unavailable: true };
    try {
      picked = new CSInterface().showSaveDialog(title, dir, types, name);
    } catch (e) {
      picked = { ok: false, unavailable: true };
    }

    if (picked.ok) {
      ensureDir(path.dirname(picked.path));
      return { ok: true, target: picked.path };
    }
    if (!picked.unavailable) return { ok: false, cancelled: true };

    var target = path.join(dir, name);
    var stem = target.replace(/\.[^.]+$/, '');
    var ext = target.slice(stem.length);
    var n = 2;
    while (fs.existsSync(target) && n < 100) {
      target = stem + '_' + n + ext;
      n++;
    }
    return { ok: true, target: target };
  }

  /** Writes the transcript as plain text, to a folder the user picks. */
  function exportTranscript() {
    var text = transcriptText(state.cues);
    if (!text) {
      setStatus('There is no transcript to export yet.', 'warn');
      return;
    }

    var dir = state.source ? path.dirname(state.source) : TRANSCRIPT_DIR;
    var choice = chooseTarget('Export transcript', dir,
      baseName() + '_transcript.txt', ['txt']);
    if (!choice.ok) {
      if (choice.cancelled) setStatus('Export cancelled.', '');
      return;
    }

    try {
      fs.writeFileSync(choice.target, text, 'utf8');
    } catch (e) {
      setStatus('Could not write the transcript: ' + e.message, 'err');
      return;
    }

    var lines = text.split('\n').filter(Boolean).length;
    setStatus('Exported ' + lines + (lines === 1 ? ' line' : ' lines') +
      ' to ' + choice.target, 'ok');
  }

  /** Writes the cues as an SRT to a folder the user picks. */
  function exportSrt() {
    if (!state.cues.length) {
      setStatus('There are no cues to export yet.', 'warn');
      return;
    }

    var text = srtText(state.cues);
    if (!text) {
      setStatus('There is no cue text to export.', 'warn');
      return;
    }

    var dir = state.source ? path.dirname(state.source) : Config.CAPTION_DIR;
    var choice = chooseTarget('Export SRT', dir, baseName() + '_edited.srt', ['srt']);
    if (!choice.ok) {
      if (choice.cancelled) setStatus('Export cancelled.', '');
      return;
    }

    if (samePath(choice.target, state.source)) {
      setStatus('That is the SRT you imported. Choose another name so the original stays untouched.', 'warn');
      return;
    }

    try {
      fs.writeFileSync(choice.target, text, 'utf8');
    } catch (e) {
      setStatus('Could not write the SRT: ' + e.message, 'err');
      return;
    }

    setStatus('Exported ' + state.cues.length +
      (state.cues.length === 1 ? ' cue' : ' cues') +
      ' to ' + choice.target, 'ok');
  }

  /** Opens a user SRT. That file is kept as the source and never written to. */
  function importSrt() {
    var start = state.source ? path.dirname(state.source) : Config.CAPTION_DIR;
    var picked = { ok: false, unavailable: true };
    try {
      picked = new CSInterface().pickFile('Open an SRT file', start, ['srt']);
    } catch (e) {
      picked = { ok: false, unavailable: true };
    }

    if (picked.unavailable) {
      setStatus('The file dialog is only available inside Premiere.', 'warn');
      return;
    }
    if (!picked.ok) return;

    var text;
    try {
      text = fs.readFileSync(picked.path, 'utf8');
    } catch (e) {
      setStatus('Could not read that SRT: ' + e.message, 'err');
      return;
    }

    var parsed = Srt.parse(text);
    var cues = [];
    for (var i = 0; i < parsed.length; i++) {
      var cue = normalise(parsed[i]);
      if (cue) cues.push(cue);
    }
    if (!cues.length) {
      setStatus('No usable cues were found in ' + path.basename(picked.path) + '.', 'warn');
      return;
    }

    state.source = picked.path;
    state.path = '';
    state.sequence = '';
    state.cues = cues;
    state.dirty = false;
    clearTimeout(saveTimer);
    persist();
    render();
    setStatus('Imported ' + cues.length + (cues.length === 1 ? ' cue' : ' cues') +
      ' from ' + picked.path + '. That file is left untouched.', 'ok');
  }

  function importEdits() {
    var res = collect();
    if (!res.ok) { setStatus(res.error, 'warn'); return; }

    var canonical = fixedPath();
    var written = writeSrt(canonical, res.cues);
    if (!written.ok) {
      setStatus('Could not write the SRT: ' + written.error, 'err');
      return;
    }

    state.cues = res.cues;
    state.dirty = false;
    clearTimeout(saveTimer);
    persist();
    render();

    var target;
    try {
      target = importPath();
      fs.writeFileSync(target, srtText(state.cues), 'utf8');
    } catch (e) {
      setStatus('Could not prepare the edited SRT: ' + e.message, 'err');
      return;
    }

    setStatus('Importing ' + state.cues.length + ' cue(s)…', '');
    if (ui.importBtn) ui.importBtn.disabled = true;
    if (ui.saveBtn) ui.saveBtn.disabled = true;

    Premiere.ensureHost()
      .then(function () { return Premiere.importCaptions(target); })
      .then(function (imp) {
        if (!imp || !imp.ok) {
          setStatus('Premiere could not import the edited SRT: ' +
            ((imp && imp.error) || 'unknown error') +
            '. The file is saved at ' + canonical, 'err');
          return;
        }

        var text = 'Imported ' + state.cues.length + ' cue(s) as "' +
          (imp.item || 'captions') + '" on "' + (imp.sequence || state.sequence) + '".';

        if (state.sequence && imp.sequence && imp.sequence !== state.sequence) {
          setStatus(text + ' That is not the sequence these cues came from.', 'warn');
          return;
        }

        setStatus(text + ' Premiere adds a new caption track at the same timecodes; ' +
          'delete the previous track in the Timeline if you no longer need it.', 'ok');
      })
      .catch(function (err) {
        setStatus('Premiere could not import the edited SRT: ' +
          ((err && err.message) || err) + '. The file is saved at ' + canonical, 'err');
      })
      .then(function () {
        if (ui.importBtn) ui.importBtn.disabled = false;
        if (ui.saveBtn) ui.saveBtn.disabled = false;
      });
  }

  function reload() {
    var target = state.source || state.path;
    if (!target) {
      setStatus('There is no SRT to reload yet.', 'warn');
      return;
    }
    if (!fs.existsSync(target)) {
      setStatus('That SRT is no longer on disk: ' + target, 'warn');
      return;
    }

    var text;
    try {
      text = fs.readFileSync(target, 'utf8');
    } catch (e) {
      setStatus('Could not read the SRT: ' + e.message, 'err');
      return;
    }

    var parsed = Srt.parse(text);
    var cues = [];
    for (var i = 0; i < parsed.length; i++) {
      var cue = normalise(parsed[i]);
      if (cue) cues.push(cue);
    }
    if (!cues.length) {
      setStatus('No usable cues were found in ' + target + '.', 'warn');
      return;
    }

    state.cues = cues;
    state.dirty = false;
    clearTimeout(saveTimer);
    persist();
    render();
    setStatus('Reloaded ' + cues.length + ' cues from the SRT on disk.', 'ok');
  }

  /** Applies every pending AI suggestion at once. */
  function fixAll() {
    var applied = 0;
    for (var i = 0; i < state.cues.length; i++) {
      if (!state.cues[i].suggest) continue;
      state.cues[i].text = state.cues[i].suggest;
      delete state.cues[i].suggest;
      applied++;
    }
    if (!applied) return;

    markDirty();
    render();
    setStatus('Applied ' + applied +
      (applied === 1 ? ' suggested fix.' : ' suggested fixes.'), 'ok');
  }

  /**
   * Asks the AI to detect the language and suggest spelling fixes. Nothing is
   * changed here: every suggestion waits under its cue for "Use this" or
   * "Fix all".
   */
  function analyse() {
    if (state.busy) return;

    if (!state.cues.length) {
      setStatus('There are no cues to check.', 'warn');
      return;
    }
    if (typeof Proofread === 'undefined' || !Proofread.ok) {
      setStatus('The spelling check is unavailable (' +
        ((typeof Proofread !== 'undefined' && Proofread.error) || 'module not loaded') + ').', 'err');
      return;
    }

    var settings = null;
    try { settings = Config.load(); } catch (e) { settings = null; }
    if (!settings || !settings.apiKey) {
      setStatus('Save a Gemini API key on the Transcribe tab first.', 'warn');
      return;
    }

    var lines = [];
    var origin = [];
    for (var i = 0; i < state.cues.length; i++) {
      var parts = String(state.cues[i].text || '').split('\n');
      for (var p = 0; p < parts.length; p++) {
        lines.push(parts[p]);
        origin.push(i);
      }
    }
    if (!lines.length) {
      setStatus('There is no cue text to check.', 'warn');
      return;
    }

    setBusy(true);
    setStatus('Checking ' + state.cues.length + ' cue(s) with the AI…', '');

    Proofread.correct(lines, {
      apiKey: settings.apiKey,
      model: Proofread.pickModel(settings.model),
      language: settings.language
    }).then(function (res) {
      setBusy(false);

      if (res.error) {
        setStatus('Could not check spelling: ' + res.error, 'err');
        return;
      }
      if (res.lines.length !== lines.length) {
        setStatus('Could not check spelling: the AI returned ' + res.lines.length +
          ' line(s) for ' + lines.length + '.', 'err');
        return;
      }

      /* Flattened cue lines come back in the same order; put them back into
         the cue they came from, keeping manual line breaks. */
      var grouped = [];
      for (var c = 0; c < state.cues.length; c++) grouped.push([]);
      for (var l = 0; l < res.lines.length; l++) grouped[origin[l]].push(res.lines[l]);

      var fixed = 0;
      for (var k = 0; k < state.cues.length; k++) {
        var next = grouped[k].join('\n').trim();
        if (next && next !== state.cues[k].text) {
          state.cues[k].suggest = next;
          fixed++;
        } else {
          delete state.cues[k].suggest;
        }
      }

      render();
      var lang = res.language ? ' (' + res.language + ' detected)' : '';
      if (fixed) {
        setStatus('Spelling checked' + lang + ' — ' + fixed +
          (fixed === 1 ? ' cue has' : ' cues have') +
          ' a suggested fix. Use Fix all, or pick the ones you want.', 'ok');
      } else {
        setStatus('Spelling checked' + lang + ' — no misspellings found.', 'ok');
      }
    }).catch(function (err) {
      setBusy(false);
      setStatus('Could not check spelling: ' + ((err && err.message) || err), 'err');
    });
  }

  function setRun(srtPath, sequenceName, cues) {
    var list = [];
    for (var i = 0; i < (cues || []).length; i++) {
      var cue = normalise(cues[i]);
      if (cue) list.push(cue);
    }
    if (!list.length) return;

    state.path = String(srtPath || '');
    state.source = '';
    state.sequence = String(sequenceName || '');
    state.cues = list;
    state.dirty = false;

    clearTimeout(saveTimer);
    persist();
    render();
    setStatus(list.length + (list.length === 1 ? ' cue is' : ' cues are') +
      ' ready to edit.', 'ok');
  }

  function init() {
    if (built) return;

    ui.badge = $('editorBadge');
    ui.meta = $('editorMeta');
    ui.empty = $('editorEmpty');
    ui.body = $('editorBody');
    ui.list = $('cueList');
    ui.status = $('editorStatus');
    ui.reload = $('editorReload');
    ui.importBtn = $('editorImport');
    ui.saveBtn = $('editorSave');
    ui.importSrtBtn = $('editorImportSrt');
    ui.importSrtEmpty = $('editorImportSrtEmpty');
    ui.exportSrtBtn = $('editorExportSrt');
    ui.exportBtn = $('editorExport');
    ui.menuBtn = $('editorMenuBtn');
    ui.menu = $('editorMenu');
    ui.replaceMenu = $('editorReplaceMenu');
    ui.replacePanel = $('replacePanel');
    ui.replaceList = $('replaceList');
    ui.replaceAdd = $('replaceAdd');
    ui.replaceClose = $('replaceClose');
    ui.replaceApply = $('replaceApply');
    ui.removeMenu = $('editorRemoveMenu');
    ui.removePanel = $('removePanel');
    ui.removeList = $('removeList');
    ui.removeAdd = $('removeAdd');
    ui.removeClose = $('removeClose');
    ui.removeApply = $('removeApply');
    ui.check = $('editorCheck');
    ui.fixAll = $('editorFixAll');

    if (!ui.list || !ui.importBtn || !ui.saveBtn || !ui.check) return;
    built = true;

    ui.list.addEventListener('input', onInput);
    ui.list.addEventListener('click', onListClick);
    ui.importBtn.addEventListener('click', importEdits);
    ui.saveBtn.addEventListener('click', saveOnly);
    if (ui.importSrtBtn) {
      ui.importSrtBtn.addEventListener('click', function () { setMenu(false); importSrt(); });
    }
    if (ui.importSrtEmpty) {
      ui.importSrtEmpty.addEventListener('click', function () { importSrt(); });
    }
    if (ui.exportSrtBtn) {
      ui.exportSrtBtn.addEventListener('click', function () { setMenu(false); exportSrt(); });
    }
    if (ui.exportBtn) {
      ui.exportBtn.addEventListener('click', function () { setMenu(false); exportTranscript(); });
    }
    if (ui.replaceMenu) {
      ui.replaceMenu.addEventListener('click', function () { setMenu(false); setReplacer(true); });
    }
    if (ui.replaceClose) {
      ui.replaceClose.addEventListener('click', function () { setReplacer(false); });
    }
    if (ui.replaceAdd) {
      ui.replaceAdd.addEventListener('click', function () {
        pairs.push({ find: '', replace: '' });
        savePairs();
        renderPairs();
        var inputs = ui.replaceList.querySelectorAll('input');
        if (inputs.length) {
          var last = inputs[inputs.length - 2];
          if (last) last.focus();
        }
      });
    }
    if (ui.replaceApply) ui.replaceApply.addEventListener('click', applyReplacements);
    if (ui.replaceList) {
      ui.replaceList.addEventListener('input', onPairInput);
      ui.replaceList.addEventListener('click', onPairClick);
    }
    if (ui.removeMenu) {
      ui.removeMenu.addEventListener('click', function () { setMenu(false); setRemover(true); });
    }
    if (ui.removeClose) {
      ui.removeClose.addEventListener('click', function () { setRemover(false); });
    }
    if (ui.removeAdd) {
      ui.removeAdd.addEventListener('click', function () {
        removals.push('');
        saveRemovals();
        renderRemovals();
        var inputs = ui.removeList.querySelectorAll('input');
        if (inputs.length) inputs[inputs.length - 1].focus();
      });
    }
    if (ui.removeApply) ui.removeApply.addEventListener('click', applyRemovals);
    if (ui.removeList) {
      ui.removeList.addEventListener('input', onRemovalInput);
      ui.removeList.addEventListener('click', onRemovalClick);
    }
    ui.check.addEventListener('click', analyse);

    if (ui.menuBtn) {
      ui.menuBtn.addEventListener('click', function () { setMenu(!menuOpen()); });
    }
    document.addEventListener('click', function (e) {
      if (!menuOpen()) return;
      var wrap = ui.menuBtn && ui.menuBtn.parentNode;
      if (wrap && wrap.contains && wrap.contains(e.target)) return;
      setMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !menuOpen()) return;
      setMenu(false);
      if (ui.menuBtn) ui.menuBtn.focus();
    });
    if (ui.fixAll) ui.fixAll.addEventListener('click', fixAll);
    if (ui.reload) ui.reload.addEventListener('click', reload);

    /* A narrower panel reflows cue text; keep the textareas matching it. */
    window.addEventListener('resize', fitAll);

    loadPairs();
    loadRemovals();
    loadDraft();
    render();
  }

  return {
    init: init,
    setRun: setRun,
    refresh: function () {
      if (!built) return;
      badge();
      fitAll();
    }
  };
})();
