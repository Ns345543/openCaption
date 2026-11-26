/*
 * animate.js — unified user-imported text MOGRT & .prtextstyle library,
 * smart/custom category filtering, preview cards, and timeline automation.
 *
 * - Text MOGRTs (.mogrt): placed cue-by-cue onto a video track with text
 *   injection, multi-field splitting/pairing, and auto-fit/positioning.
 * - Text Styles (.prtextstyle): previewed cleanly (embedded/attached raster
 *   or typographic style tile) and auto-imported into Premiere's Project bin
 *   ('99 openCaption / Text Styles') when captions are generated.
 */
var Animate = (function () {
  'use strict';

  var DEFAULTS = {
    activeMode: '',
    selectedPath: '',
    selectedStylePath: '',
    paramIndex: 0,
    fillMode: 'split',
    trackMode: 'auto',
    position: 'lower',
    positionY: 82,
    fitToScreen: true,
    textCase: 'as-is',
    clampOverlaps: true,
    replaceExisting: true,
    autoApply: false,
    autoStyleOnTranscribe: true,
    activeFilter: 'all',
    customCategories: [],
    itemCategories: {}
  };

  var POS_PRESETS = { upper: 18, middle: 50, lower: 82 };

  var ui = {};
  var cfg = null;
  var onPersist = null;
  var onLog = null;
  var cs = new CSInterface();
  var built = false;
  var scanned = false;
  var library = [];
  var inspectedPath = '';
  var running = false;
  var stopRequested = false;
  var progressTimer = 0;
  var searchTimer = 0;

  function $(id) { return document.getElementById(id); }

  function ensureState() {
    if (!cfg) cfg = {};
    for (var k in DEFAULTS) {
      if (Object.prototype.hasOwnProperty.call(DEFAULTS, k) && cfg[k] === undefined) {
        if (Array.isArray(DEFAULTS[k])) cfg[k] = [];
        else if (DEFAULTS[k] && typeof DEFAULTS[k] === 'object') cfg[k] = {};
        else cfg[k] = DEFAULTS[k];
      }
    }
    cfg.paramIndex = Math.max(0, Math.round(Number(cfg.paramIndex) || 0));
    if (['split', 'pair', 'single'].indexOf(cfg.fillMode) < 0) cfg.fillMode = DEFAULTS.fillMode;
    if (['upper', 'middle', 'lower', 'template'].indexOf(cfg.position) < 0) {
      cfg.position = DEFAULTS.position;
    }
    var py = Math.round(Number(cfg.positionY));
    cfg.positionY = isFinite(py) ? Math.min(92, Math.max(8, py)) : (POS_PRESETS[cfg.position] || 82);
    cfg.fitToScreen = cfg.fitToScreen !== false;
    if (['as-is', 'upper', 'title'].indexOf(cfg.textCase) < 0) cfg.textCase = DEFAULTS.textCase;
    cfg.clampOverlaps = cfg.clampOverlaps !== false;
    cfg.replaceExisting = cfg.replaceExisting !== false;
    cfg.autoApply = !!cfg.autoApply;
    cfg.autoStyleOnTranscribe = cfg.autoStyleOnTranscribe !== false;
    if (cfg.activeMode !== 'mogrt' && cfg.activeMode !== 'style') {
      if (cfg.selectedStylePath) cfg.activeMode = 'style';
      else if (cfg.selectedPath) cfg.activeMode = 'mogrt';
      else cfg.activeMode = '';
    }
    if (!cfg.activeFilter || typeof cfg.activeFilter !== 'string') cfg.activeFilter = 'all';
    if (!Array.isArray(cfg.customCategories)) cfg.customCategories = [];
    if (!cfg.itemCategories || typeof cfg.itemCategories !== 'object' || Array.isArray(cfg.itemCategories)) {
      cfg.itemCategories = {};
    }
  }

  function syncRange(el) {
    if (!el) return;
    var min = Number(el.min || 0);
    var max = Number(el.max || 100);
    var val = Number(el.value || 0);
    var pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--pct', Math.max(0, Math.min(100, pct)) + '%');
  }

  function save() {
    if (typeof onPersist === 'function') onPersist();
  }

  function logLine(msg, cls) {
    if (typeof onLog === 'function') onLog(msg, cls);
  }

  function setStatus(msg, cls) {
    if (!ui.status) return;
    if (!msg) {
      ui.status.textContent = '';
      ui.status.className = 'editor-status hidden';
      return;
    }
    ui.status.textContent = msg;
    ui.status.className = 'editor-status' + (cls ? ' ' + cls : '');
  }

  function setProgress(pct, label) {
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    if (ui.bar) ui.bar.style.width = p + '%';
    if (ui.progressTrack) {
      ui.progressTrack.classList.remove('closed');
      ui.progressTrack.classList.toggle('done', p >= 100);
    }
    if (ui.progressLabel && label !== undefined) ui.progressLabel.textContent = label;
  }

  function itemKey(item) {
    return item ? String(item.path || '').toLowerCase() : '';
  }

  function categoryOf(item) {
    var key = itemKey(item);
    return (key && cfg.itemCategories && cfg.itemCategories[key]) ? String(cfg.itemCategories[key]) : '';
  }

  function hasHeavyGpuFx(item) {
    var fx = (item && Array.isArray(item.usedEffects)) ? item.usedEffects : [];
    return fx.some(function (name) {
      return /light\s*sweep|glow|4colorgradient|drop\s*shadow|blur|bevel|cc\s/i.test(String(name || ''));
    });
  }

  function resolvedMode() {
    var hasStyle = library.some(function (it) { return it.kind === 'style'; });
    var hasMogrt = library.some(function (it) { return (it.kind || 'mogrt') === 'mogrt'; });
    if (cfg && cfg.activeMode === 'style' && hasStyle) return 'style';
    if (cfg && cfg.activeMode === 'mogrt' && hasMogrt) return 'mogrt';
    if (hasStyle && cfg && cfg.selectedStylePath) return 'style';
    if (hasMogrt && cfg && cfg.selectedPath) return 'mogrt';
    if (hasMogrt) return 'mogrt';
    if (hasStyle) return 'style';
    return '';
  }

  function findByKind(kind, wantedPath) {
    var matching = library.filter(function (item) {
      return (item.kind || 'mogrt') === kind;
    });
    if (!matching.length) return null;
    if (wantedPath) {
      var target = String(wantedPath).toLowerCase();
      for (var i = 0; i < matching.length; i++) {
        if (matching[i].path.toLowerCase() === target) return matching[i];
      }
    }
    return matching[0];
  }

  function selectedTemplate() {
    if (resolvedMode() !== 'mogrt') return null;
    return findByKind('mogrt', cfg.selectedPath);
  }

  function selectedStyle() {
    if (resolvedMode() !== 'style') return null;
    return findByKind('style', cfg.selectedStylePath);
  }

  function activeItem() {
    return resolvedMode() === 'style' ? selectedStyle() : selectedTemplate();
  }

  function inspectedItem() {
    if (!library.length) return null;
    if (inspectedPath) {
      var target = inspectedPath.toLowerCase();
      for (var i = 0; i < library.length; i++) {
        if (library[i].path.toLowerCase() === target) return library[i];
      }
    }
    return activeItem() || library[0];
  }

  function applyStyleTypography(el, item) {
    if (!el) return;
    if (item && item.kind === 'style') {
      if (item.fontFamily) {
        var fam = String(item.fontFamily).replace(/"/g, '');
        var rawFont = String(item.fontName || fam).replace(/"/g, '');
        el.style.fontFamily = '"' + fam + '", "' + rawFont + '", Georgia, sans-serif';
        el.style.fontWeight = item.fontWeight || '700';
        el.style.fontStyle = item.fontStyle || 'normal';
      } else {
        el.style.fontFamily = '';
        el.style.fontWeight = '';
        el.style.fontStyle = '';
      }
      el.style.color = item.fillHex || '';
      if (item.strokeWidth > 0 && item.strokeHex) {
        var sc = item.strokeHex;
        el.style.textShadow = '0 1px 0 ' + sc + ', 0 -1px 0 ' + sc + ', 1px 0 0 ' + sc + ', -1px 0 0 ' + sc + ', 0 2px 8px rgba(0,0,0,0.75)';
      } else {
        el.style.textShadow = '';
      }
    } else {
      el.style.fontFamily = '';
      el.style.fontWeight = '';
      el.style.fontStyle = '';
      el.style.color = '';
      el.style.textShadow = '';
    }
  }

  function samplePreviewText(item) {
    if (item && item.kind === 'style') {
      var label = item.fontName || item.styleLabel || item.name || 'Caption Style';
      return label.slice(0, 22) + ' · Aa';
    }
    var fields = (item && item.textFields) || [];
    for (var i = 0; i < fields.length; i++) {
      var s = String(fields[i].sample || '').trim();
      if (s) return s.slice(0, 28);
    }
    return (item && item.name) ? item.name.slice(0, 24) : 'Sample caption';
  }

  function formatCase(text, textCase) {
    if (textCase === 'upper') return text.toUpperCase();
    if (textCase === 'title') {
      return text.replace(/\b([a-z\u00e0-\u00ff])(\S*)/gi, function (_, first, rest) {
        return first.toUpperCase() + rest.toLowerCase();
      });
    }
    return text;
  }

  function stopVideo(videoEl) {
    if (!videoEl) return;
    try { videoEl.pause(); } catch (e0) {}
    try {
      if (videoEl.readyState > 0) videoEl.currentTime = 0;
    } catch (e1) {}
    if (videoEl.hasAttribute('src') || videoEl.hasAttribute('data-src')) {
      videoEl.removeAttribute('src');
      videoEl.removeAttribute('data-src');
      try { videoEl.load(); } catch (eLoad) {}
    }
    videoEl.classList.add('hidden');
  }

  function unloadGridVideos() {
    if (!ui.grid) return;
    var vids = ui.grid.querySelectorAll('video');
    for (var i = 0; i < vids.length; i++) stopVideo(vids[i]);
  }

  function unloadAllVideos() {
    stopVideo(ui.selectedVideo);
    unloadGridVideos();
  }

  function bindHoverPreview(container, videoEl, itemGetter) {
    if (!container) return;

    function startPreview() {
      var item = typeof itemGetter === 'function' ? itemGetter() : null;
      if (!item) return;
      container.classList.add('is-hovering');
      if (item.videoUrl && videoEl) {
        if (videoEl.getAttribute('data-src') !== item.videoUrl) {
          videoEl.setAttribute('data-src', item.videoUrl);
          videoEl.src = item.videoUrl;
        }
        videoEl.classList.remove('hidden');
        try { videoEl.currentTime = 0; } catch (eTime) {}
        try {
          var p = videoEl.play();
          if (p && typeof p.catch === 'function') {
            p.catch(function () { stopVideo(videoEl); });
          }
        } catch (ePlay) {
          stopVideo(videoEl);
        }
      }
    }

    function endPreview() {
      container.classList.remove('is-hovering');
      stopVideo(videoEl);
    }

    container.addEventListener('mouseenter', startPreview);
    container.addEventListener('mouseleave', endPreview);
    container.addEventListener('focusin', startPreview);
    container.addEventListener('focusout', endPreview);
  }

  function matchesFilter(item, filterKey) {
    if (!filterKey || filterKey === 'all') return true;
    var kind = item.kind || 'mogrt';
    if (filterKey === 'kind:mogrt') return kind === 'mogrt';
    if (filterKey === 'kind:style') return kind === 'style';
    if (filterKey === 'app:ae') return kind === 'mogrt' && item.authorApp === 'After Effects';
    if (filterKey === 'app:pr') return kind === 'mogrt' && item.authorApp === 'Premiere';
    if (filterKey === 'fields:1') return kind === 'mogrt' && (item.textFields || []).length === 1;
    if (filterKey === 'fields:multi') return kind === 'mogrt' && (item.textFields || []).length > 1;
    if (filterKey.indexOf('cat:') === 0) {
      return categoryOf(item).toLowerCase() === filterKey.slice(4).toLowerCase();
    }
    return true;
  }

  function buildFilterDefinitions() {
    var defs = [{ key: 'all', label: 'All' }];
    var mogrts = 0, styles = 0, ae = 0, pr = 0, f1 = 0, fMulti = 0;
    library.forEach(function (it) {
      if ((it.kind || 'mogrt') === 'style') {
        styles++;
      } else {
        mogrts++;
        if (it.authorApp === 'After Effects') ae++;
        else pr++;
        var fc = (it.textFields || []).length;
        if (fc === 1) f1++;
        else if (fc > 1) fMulti++;
      }
    });
    if (mogrts > 0 && styles > 0) {
      defs.push({ key: 'kind:mogrt', label: 'MOGRTs' });
      defs.push({ key: 'kind:style', label: 'Styles' });
    } else if (styles > 0) {
      defs.push({ key: 'kind:style', label: 'Styles' });
    }
    if (ae > 0) defs.push({ key: 'app:ae', label: 'After Effects' });
    if (pr > 0) defs.push({ key: 'app:pr', label: 'Premiere' });
    if (f1 > 0 && fMulti > 0) {
      defs.push({ key: 'fields:1', label: '1 Text' });
      defs.push({ key: 'fields:multi', label: 'Multi-Text' });
    }
    (cfg.customCategories || []).forEach(function (cat) {
      defs.push({ key: 'cat:' + cat, label: cat, isCustom: true });
    });
    return defs;
  }

  function renderFilterBar() {
    if (ui.filtersWrap) {
      ui.filtersWrap.classList.toggle('hidden', library.length === 0);
    }
    if (!ui.filterBar) return;

    var defs = buildFilterDefinitions();
    var hasActive = defs.some(function (d) { return d.key === cfg.activeFilter; });
    if (!hasActive) cfg.activeFilter = 'all';

    ui.filterBar.innerHTML = '';
    defs.forEach(function (d) {
      var cnt = 0;
      for (var i = 0; i < library.length; i++) {
        if (matchesFilter(library[i], d.key)) cnt++;
      }
      if (!cnt && d.key !== 'all' && !d.isCustom) return;

      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'filter-chip' + (d.key === cfg.activeFilter ? ' active' : '') + (d.isCustom ? ' is-custom' : '');
      chip.setAttribute('role', 'tab');
      chip.setAttribute('aria-selected', d.key === cfg.activeFilter ? 'true' : 'false');
      chip.setAttribute('data-filter', d.key);
      chip.textContent = d.label + ' (' + cnt + ')';
      chip.addEventListener('click', function () {
        cfg.activeFilter = d.key;
        renderFilterBar();
        renderSelected();
        renderGrid();
        save();
      });
      ui.filterBar.appendChild(chip);
    });
  }

  function renderCategoryPicker(item) {
    if (!ui.catSelect) return;
    ui.catSelect.innerHTML = '';

    var noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = 'No category';
    ui.catSelect.appendChild(noneOpt);

    (cfg.customCategories || []).forEach(function (cat) {
      var opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = 'Tag: ' + cat;
      ui.catSelect.appendChild(opt);
    });

    var newOpt = document.createElement('option');
    newOpt.value = '__new__';
    newOpt.textContent = '+ New category…';
    ui.catSelect.appendChild(newOpt);

    var curCat = item ? categoryOf(item) : '';
    if (curCat && (cfg.customCategories || []).indexOf(curCat) < 0) {
      cfg.customCategories.push(curCat);
      var extraOpt = document.createElement('option');
      extraOpt.value = curCat;
      extraOpt.textContent = 'Tag: ' + curCat;
      ui.catSelect.insertBefore(extraOpt, newOpt);
    }
    ui.catSelect.value = curCat;

    var customActiveTag = (cfg.activeFilter && cfg.activeFilter.indexOf('cat:') === 0) ? cfg.activeFilter.slice(4) : '';
    var delTarget = curCat || customActiveTag;
    if (ui.catDelBtn) {
      ui.catDelBtn.classList.toggle('hidden', !delTarget);
      ui.catDelBtn.title = delTarget ? ('Delete custom category "' + delTarget + '"') : '';
    }
  }

  var premiereAppPath = '';

  function renderStyleActionBox() {
    var mode = resolvedMode();
    var st = selectedStyle();
    var isStyleMode = (mode === 'style' && !!st);

    if (ui.styleActionBox) ui.styleActionBox.classList.toggle('hidden', !isStyleMode);
    if (ui.paramField) ui.paramField.classList.toggle('hidden', isStyleMode);
    if (ui.autoApplyWrap) ui.autoApplyWrap.classList.toggle('hidden', isStyleMode);

    if (ui.applyBtn) {
      var lbl = ui.applyBtn.querySelector ? ui.applyBtn.querySelector('.btn-label') : null;
      if (!lbl && ui.applyBtn.children && ui.applyBtn.children[0]) lbl = ui.applyBtn.children[0];
      if (lbl) lbl.textContent = isStyleMode ? 'Apply Text Style to recent captions' : 'Apply MOGRT to recent captions';
    }
    if (ui.applyHint) {
      ui.applyHint.textContent = isStyleMode
        ? 'Renders styled captions matching your selected .prtextstyle directly on the timeline track.'
        : 'Places the selected .mogrt onto the timeline at every cue\'s exact time and fills its text field automatically.';
    }
    if (!isStyleMode) return;

    if (ui.styleSelectedBadge) ui.styleSelectedBadge.textContent = st.name;
    if (ui.styleFontMeta) {
      var fontParts = [];
      if (st.fontName) fontParts.push('Font: ' + st.fontName);
      if (st.fillHex) fontParts.push(st.fillHex.toUpperCase());
      if (st.styleLabel && st.styleLabel.toLowerCase() !== st.name.toLowerCase()) {
        fontParts.push(st.styleLabel);
      }
      if (fontParts.length) {
        ui.styleFontMeta.textContent = fontParts.join(' · ');
        ui.styleFontMeta.classList.remove('hidden');
      } else {
        ui.styleFontMeta.textContent = '';
        ui.styleFontMeta.classList.add('hidden');
      }
    }
    if (ui.styleSendBtn) ui.styleSendBtn.disabled = running;
    if (ui.styleAutoImport) ui.styleAutoImport.checked = !!cfg.autoStyleOnTranscribe;
  }

  function renderSelected() {
    var mode = resolvedMode();
    cfg.activeMode = mode;
    var selMogrt = selectedTemplate();
    var selStyle = selectedStyle();
    var viewed = inspectedItem();

    if (mode === 'mogrt' && selMogrt) {
      cfg.selectedPath = selMogrt.path;
    } else if (mode === 'style' && selStyle) {
      cfg.selectedStylePath = selStyle.path;
    }

    stopVideo(ui.selectedVideo);
    if (ui.selectedBox) ui.selectedBox.classList.remove('is-hovering');

    if (ui.selectedBox) {
      if (!viewed) {
        ui.selectedBox.classList.add('hidden');
      } else {
        inspectedPath = viewed.path;
        var isStyle = viewed.kind === 'style';
        ui.selectedBox.classList.remove('hidden');
        ui.selectedBox.classList.toggle('has-video', !!viewed.videoUrl);
        ui.selectedBox.classList.toggle('is-style-card', isStyle);

        if (ui.selectedName) ui.selectedName.textContent = viewed.name;
        if (ui.selectedMeta) {
          var vCat = categoryOf(viewed);
          var catNote = vCat ? (' · #' + vCat) : '';
          if (isStyle) {
            var fontTag = viewed.fontName ? viewed.fontName : 'Premiere Text Style';
            ui.selectedMeta.textContent = fontTag + ' · .prtextstyle' +
              (viewed.thumbUrl ? ' · custom preview' : ' · typographic preview') + catNote;
          } else {
            var fields = viewed.textFields || [];
            ui.selectedMeta.textContent = viewed.authorApp + ' · ' + fields.length +
              ' text field' + (fields.length === 1 ? '' : 's') +
              (hasHeavyGpuFx(viewed) ? ' · GPU FX (safe slow pace)' : '') +
              (viewed.videoUrl ? ' · hover to preview' : '') + catNote;
          }
        }
        if (ui.selectedSim) {
          ui.selectedSim.textContent = samplePreviewText(viewed);
          applyStyleTypography(ui.selectedSim, viewed);
          ui.selectedSim.classList.toggle('hidden', !!viewed.videoUrl);
        }
        if (ui.selectedThumb && ui.selectedMono) {
          ui.selectedMono.className = 'mogrt-mono' + (isStyle ? ' is-style-glyph' : '');
          if (viewed.thumbUrl) {
            ui.selectedThumb.src = viewed.thumbUrl;
            ui.selectedThumb.classList.remove('hidden');
            ui.selectedMono.classList.add('hidden');
            applyStyleTypography(ui.selectedMono, null);
          } else {
            ui.selectedThumb.removeAttribute('src');
            ui.selectedThumb.classList.add('hidden');
            ui.selectedMono.textContent = isStyle ? 'Aa' : viewed.name.slice(0, 2).toUpperCase();
            applyStyleTypography(ui.selectedMono, viewed);
            ui.selectedMono.classList.remove('hidden');
          }
        }
        if (ui.stylePreviewBtn) ui.stylePreviewBtn.classList.toggle('hidden', !isStyle);
        renderCategoryPicker(viewed);
      }
    }

    if (ui.paramSelect) {
      ui.paramSelect.innerHTML = '';
      if (!selMogrt) {
        var emptyOpt = document.createElement('option');
        emptyOpt.value = '0';
        emptyOpt.textContent = 'Import a text .mogrt first';
        ui.paramSelect.appendChild(emptyOpt);
        ui.paramSelect.disabled = true;
      } else {
        var mFields = selMogrt.textFields || [];
        ui.paramSelect.disabled = false;
        if (mFields.length > 1) {
          var splitOpt = document.createElement('option');
          splitOpt.value = 'split:0';
          splitOpt.textContent = 'All fields (next words · ' + mFields.length + ')';
          ui.paramSelect.appendChild(splitOpt);

          var pairOpt = document.createElement('option');
          pairOpt.value = 'pair:0';
          pairOpt.textContent = 'All fields (pair ' + mFields.length + ' cues)';
          ui.paramSelect.appendChild(pairOpt);

          mFields.forEach(function (f, idx) {
            var opt = document.createElement('option');
            opt.value = 'single:' + idx;
            opt.textContent = 'Only ' + (idx + 1) + '. ' + f.name;
            ui.paramSelect.appendChild(opt);
          });

          if (cfg.paramIndex >= mFields.length) cfg.paramIndex = 0;
          ui.paramSelect.value = cfg.fillMode === 'single'
            ? ('single:' + cfg.paramIndex)
            : (cfg.fillMode + ':0');
        } else {
          mFields.forEach(function (f, idx) {
            var singleOpt = document.createElement('option');
            singleOpt.value = 'single:' + idx;
            singleOpt.textContent = f.name;
            ui.paramSelect.appendChild(singleOpt);
          });
          cfg.paramIndex = 0;
          ui.paramSelect.value = 'single:0';
        }
      }
    }

    renderStyleActionBox();
  }

  function updateCardSelection() {
    if (!ui.grid) return;
    var currentActive = activeItem();
    var activePathLower = currentActive ? currentActive.path.toLowerCase() : '';
    var cards = ui.grid.querySelectorAll('.mogrt-card');
    for (var i = 0; i < cards.length; i++) {
      var on = !!activePathLower && cards[i].getAttribute('data-path') === activePathLower;
      cards[i].classList.toggle('active', on);
      cards[i].setAttribute('aria-checked', on ? 'true' : 'false');
    }
  }

  function renderGrid() {
    if (!ui.grid) return;
    var query = String((ui.search && ui.search.value) || '').trim().toLowerCase();
    var currentActive = activeItem();
    var activePathLower = currentActive ? currentActive.path.toLowerCase() : '';

    if (ui.searchWrap) ui.searchWrap.classList.toggle('hidden', library.length < 4);

    var filtered = library.filter(function (item) {
      if (!matchesFilter(item, cfg.activeFilter)) return false;
      if (!query) return true;
      var hay = (item.name + ' ' + item.authorApp + ' ' + (item.fontName || '') + ' ' +
        (item.styleLabel || '') + ' ' + categoryOf(item) + ' ' + (item.kind || 'mogrt')).toLowerCase();
      return hay.indexOf(query) >= 0;
    });

    if (ui.countBadge) {
      ui.countBadge.textContent = String(library.length);
      ui.countBadge.className = 'badge' + (library.length ? ' ok' : '');
    }

    if (ui.emptyHint) {
      var isEmpty = filtered.length === 0;
      ui.emptyHint.classList.toggle('hidden', !isEmpty);
      if (isEmpty && ui.emptyTitle && ui.emptyBody) {
        if (!library.length) {
          ui.emptyTitle.textContent = 'Nothing imported yet';
          ui.emptyBody.textContent = 'Click "+ .mogrt…" or "+ .prtextstyle…" to add your caption presets. Hover any card to preview.';
        } else if (cfg.activeFilter && cfg.activeFilter.indexOf('cat:') === 0 && !query) {
          ui.emptyTitle.textContent = 'No items in "' + cfg.activeFilter.slice(4) + '"';
          ui.emptyBody.textContent = 'Switch back to All, click any card, and choose this category from the tag dropdown.';
        } else {
          ui.emptyTitle.textContent = 'No matching presets';
          ui.emptyBody.textContent = 'Clear the search or pick All to see all ' + library.length + ' imported preset(s).';
        }
      }
    }

    unloadGridVideos();
    ui.grid.innerHTML = '';
    var frag = document.createDocumentFragment();

    filtered.forEach(function (item) {
      var isStyle = item.kind === 'style';
      var itemLower = item.path.toLowerCase();
      var active = !!activePathLower && (itemLower === activePathLower);
      var itemCat = categoryOf(item);

      var card = document.createElement('div');
      card.className = 'mogrt-card' +
        (active ? ' active' : '') +
        (item.videoUrl ? ' has-video' : '') +
        (isStyle ? ' is-style-card' : '');
      card.setAttribute('data-path', itemLower);
      card.setAttribute('role', 'radio');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-checked', active ? 'true' : 'false');
      card.title = item.name + (isStyle ? (item.fontName ? ' (' + item.fontName + ')' : ' (.prtextstyle)') : ' — hover to preview');

      var prev = document.createElement('div');
      prev.className = 'mogrt-card-preview' + (isStyle && !item.thumbUrl ? ' style-swatch-bg' : '');

      if (item.thumbUrl) {
        var img = document.createElement('img');
        img.className = 'mogrt-thumb';
        img.loading = 'lazy';
        img.decoding = 'async';
        img.src = item.thumbUrl;
        img.alt = '';
        prev.appendChild(img);
      } else {
        var mono = document.createElement('span');
        mono.className = 'mogrt-mono' + (isStyle ? ' is-style-glyph' : '');
        mono.textContent = isStyle ? 'Aa' : item.name.slice(0, 2).toUpperCase();
        applyStyleTypography(mono, item);
        prev.appendChild(mono);
      }

      var videoEl = null;
      if (item.videoUrl) {
        videoEl = document.createElement('video');
        videoEl.className = 'mogrt-hover-video hidden';
        videoEl.muted = true;
        videoEl.loop = true;
        videoEl.playsInline = true;
        videoEl.preload = 'none';
        prev.appendChild(videoEl);
      } else {
        var sim = document.createElement('span');
        sim.className = 'mogrt-hover-sim';
        sim.setAttribute('aria-hidden', 'true');
        sim.textContent = samplePreviewText(item);
        applyStyleTypography(sim, item);
        prev.appendChild(sim);
      }

      var previewBadge = document.createElement('span');
      previewBadge.className = 'mogrt-preview-badge';
      previewBadge.textContent = item.videoUrl ? '\u25b6' : (isStyle ? 'STYLE' : 'PREVIEW');
      prev.appendChild(previewBadge);

      var del = document.createElement('button');
      del.type = 'button';
      del.className = 'mogrt-del';
      del.title = isStyle ? 'Remove text style' : 'Remove MOGRT';
      del.setAttribute('aria-label', 'Remove ' + item.name);
      del.textContent = '\u00d7';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        removeCustomItem(item);
      });
      card.appendChild(del);

      var foot = document.createElement('div');
      foot.className = 'mogrt-card-foot';

      var name = document.createElement('span');
      name.className = 'mogrt-card-name';
      name.textContent = item.name;

      foot.appendChild(name);

      if (itemCat) {
        var catTag = document.createElement('span');
        catTag.className = 'mogrt-tag is-cat';
        catTag.textContent = itemCat;
        foot.appendChild(catTag);
      }

      var tag = document.createElement('span');
      tag.className = 'mogrt-tag';
      tag.textContent = isStyle ? (item.fontName ? item.fontFamily || 'style' : 'style') : (item.textFields.length + ' txt');
      foot.appendChild(tag);

      card.appendChild(prev);
      card.appendChild(foot);

      bindHoverPreview(card, videoEl, function () { return item; });

      function selectThis() {
        inspectedPath = item.path;
        if (isStyle) {
          cfg.activeMode = 'style';
          cfg.selectedStylePath = item.path;
          cfg.selectedPath = '';
        } else {
          cfg.activeMode = 'mogrt';
          cfg.selectedPath = item.path;
          cfg.selectedStylePath = '';
          cfg.paramIndex = 0;
        }
        renderSelected();
        updateCardSelection();
        refreshCues();
        save();
      }

      card.addEventListener('click', selectThis);
      card.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          selectThis();
        }
      });

      frag.appendChild(card);
    });

    ui.grid.appendChild(frag);
  }

  function rescan() {
    if (typeof Mogrt === 'undefined' || !Mogrt.ok) {
      setStatus((typeof Mogrt !== 'undefined' && Mogrt.error) || 'Preset helper unavailable.', 'err');
      return;
    }
    scanned = true;
    library = Mogrt.scanLibrary();
    renderFilterBar();
    renderSelected();
    renderGrid();
    refreshCues();
  }

  function ensureScanned() {
    if (!scanned) rescan();
  }

  function importCustomMogrt() {
    if (typeof Mogrt === 'undefined' || !Mogrt.ok) {
      setStatus('Preset helper unavailable.', 'err');
      return;
    }
    var startDir = '';
    try { startDir = NODE.os.homedir(); } catch (e) { startDir = ''; }

    var picked = cs.showOpenDialog('Import text MOGRT (.mogrt)', startDir, ['mogrt']);
    if (!picked) return;

    var res = Mogrt.importTemplate(picked);
    if (!res.ok) {
      setStatus(res.error, 'err');
      return;
    }

    library = Mogrt.scanLibrary();
    cfg.activeMode = 'mogrt';
    cfg.selectedPath = res.item.path;
    cfg.selectedStylePath = '';
    inspectedPath = res.item.path;
    cfg.paramIndex = 0;
    if (cfg.activeFilter === 'kind:style') cfg.activeFilter = 'all';
    renderFilterBar();
    renderSelected();
    renderGrid();
    refreshCues();
    save();
    setStatus('Imported "' + res.item.name + '" (' + res.item.textFields.length + ' text field(s)).', 'ok');
    logLine('Imported text MOGRT "' + res.item.name + '".', 'ok');
  }

  function importCustomStyle() {
    if (typeof Mogrt === 'undefined' || !Mogrt.ok || typeof Mogrt.importStyle !== 'function') {
      setStatus('Style helper unavailable.', 'err');
      return;
    }
    var startDir = '';
    try { startDir = NODE.os.homedir(); } catch (e) { startDir = ''; }

    var picked = cs.showOpenDialog('Import Premiere text style (.prtextstyle)', startDir, ['prtextstyle']);
    if (!picked) return;

    var res = Mogrt.importStyle(picked);
    if (!res.ok) {
      setStatus(res.error, 'err');
      return;
    }

    library = Mogrt.scanLibrary();
    cfg.activeMode = 'style';
    cfg.selectedStylePath = res.item.path;
    cfg.selectedPath = '';
    inspectedPath = res.item.path;
    if (cfg.activeFilter === 'kind:mogrt') cfg.activeFilter = 'all';
    renderFilterBar();
    renderSelected();
    renderGrid();
    refreshCues();
    save();
    setStatus('Imported style "' + res.item.name + '.prtextstyle". It will auto-load into Premiere on Transcribe.', 'ok');
    logLine('Imported .prtextstyle "' + res.item.name + '".', 'ok');
  }

  function attachStylePreviewImage() {
    var viewed = inspectedItem();
    if (!viewed || viewed.kind !== 'style' || typeof Mogrt.attachStylePreview !== 'function') return;
    var startDir = '';
    try { startDir = NODE.os.homedir(); } catch (e) { startDir = ''; }

    var picked = cs.showOpenDialog('Attach preview image for "' + viewed.name + '"', startDir, ['png', 'jpg', 'jpeg', 'webp']);
    if (!picked) return;

    var res = Mogrt.attachStylePreview(viewed.path, picked);
    if (!res.ok) {
      setStatus(res.error, 'err');
      return;
    }
    library = Mogrt.scanLibrary();
    inspectedPath = res.item.path;
    renderFilterBar();
    renderSelected();
    renderGrid();
    setStatus('Updated preview image for "' + viewed.name + '".', 'ok');
  }

  function removeCustomItem(item) {
    if (typeof Mogrt === 'undefined' || !Mogrt.ok) return;
    var res = Mogrt.removeCustom(item.path);
    if (!res.ok) {
      setStatus(res.error, 'err');
      return;
    }
    var lower = item.path.toLowerCase();
    var removedActiveMogrt = !!(cfg.selectedPath && cfg.selectedPath.toLowerCase() === lower);
    var removedActiveStyle = !!(cfg.selectedStylePath && cfg.selectedStylePath.toLowerCase() === lower);
    if (removedActiveMogrt) {
      cfg.selectedPath = '';
      if (cfg.activeMode === 'mogrt') cfg.activeMode = '';
    }
    if (removedActiveStyle) {
      cfg.selectedStylePath = '';
      if (cfg.activeMode === 'style') cfg.activeMode = '';
    }
    if (inspectedPath && inspectedPath.toLowerCase() === lower) inspectedPath = '';
    if (cfg.itemCategories && cfg.itemCategories[lower]) delete cfg.itemCategories[lower];
    rescan();
    save();
    setStatus('Removed "' + item.name + '".', 'dim');
  }

  function openCustomFolder() {
    if (typeof Mogrt === 'undefined' || !Mogrt.ok) return;
    var viewed = inspectedItem();
    var targetDir = (viewed && viewed.kind === 'style' && Mogrt.STYLE_DIR) ? Mogrt.STYLE_DIR : Mogrt.CUSTOM_DIR;
    try {
      NODE.child_process.spawn('explorer.exe', [targetDir], { detached: true, stdio: 'ignore' }).unref();
    } catch (e) {
      setStatus('Could not open folder: ' + e.message, 'warn');
    }
  }

  function currentCues() {
    if (typeof Editor === 'undefined' || typeof Editor.getCues !== 'function') return [];
    try { return Editor.getCues() || []; } catch (e) { return []; }
  }

  function currentMeta() {
    if (typeof Editor === 'undefined' || typeof Editor.getMeta !== 'function') return { count: 0, sequence: '' };
    try { return Editor.getMeta() || { count: 0, sequence: '' }; } catch (e) { return { count: 0, sequence: '' }; }
  }

  function refreshCues() {
    var meta = currentMeta();
    var cueCount = Number(meta.count) || 0;

    if (ui.cueBadge) {
      ui.cueBadge.textContent = cueCount ? cueCount + ' cue' + (cueCount === 1 ? '' : 's') : 'no cues';
      ui.cueBadge.className = 'badge' + (cueCount ? ' ok' : '');
    }

    if (ui.cueSummary) {
      if (cueCount) {
        var seqNote = meta.sequence ? ' from "' + meta.sequence + '"' : '';
        ui.cueSummary.textContent = cueCount + ' recent cue(s)' + seqNote + ' ready for timeline placement.';
      } else {
        ui.cueSummary.textContent = 'No recent captions yet. Run Generate on the Transcribe tab or import an SRT in Editor.';
      }
    }

    if (ui.applyBtn && !running) {
      ui.applyBtn.disabled = !cueCount || !activeItem();
    }
    if (ui.styleSendBtn && !running) {
      ui.styleSendBtn.disabled = !selectedStyle();
    }
  }

  function syncControls() {
    ensureState();
    if (ui.trackSelect) ui.trackSelect.value = String(cfg.trackMode || 'auto');
    if (ui.posSeg) {
      ui.posSeg.querySelectorAll('button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-pos') === cfg.position);
      });
    }
    var isTemplatePos = cfg.position === 'template';
    if (ui.posY) {
      ui.posY.value = String(cfg.positionY);
      ui.posY.disabled = isTemplatePos;
      syncRange(ui.posY);
    }
    if (ui.posYVal) {
      ui.posYVal.textContent = isTemplatePos ? 'template' : cfg.positionY + '%';
    }
    if (ui.caseSeg) {
      ui.caseSeg.querySelectorAll('button').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-case') === cfg.textCase);
      });
    }
    if (ui.fitScreen) ui.fitScreen.checked = !!cfg.fitToScreen;
    if (ui.clamp) ui.clamp.checked = !!cfg.clampOverlaps;
    if (ui.replace) ui.replace.checked = !!cfg.replaceExisting;
    if (ui.autoApply) ui.autoApply.checked = !!cfg.autoApply;
    if (ui.styleAutoImport) ui.styleAutoImport.checked = !!cfg.autoStyleOnTranscribe;
  }

  function setBusy(busy) {
    running = busy;
    var cueCount = Number(currentMeta().count) || 0;
    if (ui.applyBtn) ui.applyBtn.disabled = busy || !cueCount || !activeItem();
    if (ui.styleSendBtn) ui.styleSendBtn.disabled = busy || !selectedStyle();
    if (ui.importBtn) ui.importBtn.disabled = busy;
    if (ui.styleImportBtn) ui.styleImportBtn.disabled = busy;
    if (ui.stopBtn) {
      ui.stopBtn.classList.toggle('hidden', !busy);
      ui.stopBtn.disabled = false;
      ui.stopBtn.textContent = 'Stop';
    }
  }

  function splitTextForFields(text, count) {
    if (count <= 1) return [text];
    var lines = String(text || '').split(/\r?\n/).map(function (l) {
      return l.replace(/\s+/g, ' ').trim();
    }).filter(Boolean);

    if (lines.length >= count) {
      var outLines = lines.slice(0, count - 1);
      outLines.push(lines.slice(count - 1).join(' '));
      return outLines;
    }

    var words = lines.join(' ').split(/\s+/).filter(Boolean);
    var out = [];
    if (words.length <= count) {
      for (var i = 0; i < count; i++) out.push(words[i] || '');
      return out;
    }

    var base = Math.floor(words.length / count);
    var extra = words.length % count;
    var at = 0;
    for (var f = 0; f < count; f++) {
      var take = base + (f < extra ? 1 : 0);
      out.push(words.slice(at, at + take).join(' '));
      at += take;
    }
    return out;
  }

  function buildPlacementJobs(prepared, fieldCount) {
    var jobs = [];
    if (fieldCount > 1 && cfg.fillMode === 'pair') {
      for (var i = 0; i < prepared.length; i += fieldCount) {
        var group = prepared.slice(i, i + fieldCount);
        var texts = [];
        for (var j = 0; j < fieldCount; j++) {
          texts.push(group[j] ? formatCase(group[j].text, cfg.textCase) : '');
        }
        jobs.push({
          start: group[0].start,
          end: group[group.length - 1].end,
          texts: texts,
          text: texts.join('\n')
        });
      }
      return jobs;
    }

    for (var k = 0; k < prepared.length; k++) {
      var cue = prepared[k];
      var formatted = formatCase(cue.text, cfg.textCase);
      if (fieldCount > 1 && cfg.fillMode === 'split') {
        var parts = splitTextForFields(formatted, fieldCount);
        jobs.push({ start: cue.start, end: cue.end, texts: parts, text: formatted });
      } else {
        jobs.push({ start: cue.start, end: cue.end, texts: null, text: formatted });
      }
    }
    return jobs;
  }

  async function sendStyleToProject(opts) {
    opts = opts || {};
    var st = selectedStyle();
    if (!st) {
      var msgNoStyle = 'Import and select a .prtextstyle preset first.';
      if (!opts.silent) setStatus(msgNoStyle, 'warn');
      return { ok: false, error: msgNoStyle };
    }
    if (typeof Premiere.importTextStyle !== 'function') {
      return { ok: false, error: 'Style import bridge unavailable.' };
    }

    try {
      var hostOk = await Premiere.ensureHost();
      if (!hostOk) throw new Error('Could not load host.jsx in Premiere Pro.');

      var res = await Premiere.importTextStyle({ path: st.path, styleName: st.styleLabel || st.name });
      if (!res || !res.ok) {
        throw new Error((res && res.error) || 'Failed importing .prtextstyle.');
      }

      var msg = res.alreadyInProject
        ? 'Style "' + st.name + '" is ready in "' + (res.bin || 'Text Styles') + '" — pick it once under Properties → Track style.'
        : 'Imported style "' + st.name + '.prtextstyle" into "' + (res.bin || 'Text Styles') + '" — pick it under Properties → Track style.';
      if (!opts.silent) setStatus(msg, 'ok');
      logLine(msg, 'ok');
      return { ok: true, alreadyInProject: !!res.alreadyInProject, item: res.item, bin: res.bin };
    } catch (e) {
      var errMsg = (e && e.message) ? e.message : String(e);
      if (!opts.silent) setStatus(errMsg, 'err');
      logLine('! .prtextstyle import failed: ' + errMsg, 'err');
      return { ok: false, error: errMsg };
    }
  }

  async function applyToRecent(opts) {
    opts = opts || {};
    if (running) return { ok: false, error: 'Already applying MOGRTs.' };

    var cues = currentCues();
    if (!cues.length) {
      var msgNoCues = 'No recent captions found. Transcribe a sequence or import an SRT first.';
      if (!opts.silent) setStatus(msgNoCues, 'warn');
      return { ok: false, error: msgNoCues };
    }

    var mode = resolvedMode();
    var selStyle = (mode === 'style') ? selectedStyle() : null;
    var sel = (mode === 'style') ? null : selectedTemplate();
    var displayLabel = selStyle ? selStyle.name : (sel ? sel.name : '');

    if (!sel && !selStyle) {
      var msgNoPreset = 'Import and select a .mogrt or .prtextstyle preset first.';
      if (!opts.silent) setStatus(msgNoPreset, 'warn');
      return { ok: false, error: msgNoPreset };
    }

    clearTimeout(progressTimer);
    stopRequested = false;
    setBusy(true);
    setStatus('', '');
    setProgress(2, selStyle ? 'preparing styled template…' : 'preparing track…');

    var prepared = cues.map(function (c) {
      return { start: Number(c.start), end: Number(c.end), text: String(c.text || '') };
    }).sort(function (a, b) { return a.start - b.start; });

    if (cfg.clampOverlaps) {
      for (var i = 0; i < prepared.length - 1; i++) {
        var nextStart = prepared[i + 1].start;
        if (prepared[i].end > nextStart - 0.01) {
          prepared[i].end = Math.max(prepared[i].start + 0.05, nextStart - 0.01);
        }
      }
    }

    var firstStyleBuild = null;
    if (selStyle) {
      if (typeof Mogrt === 'undefined' || typeof Mogrt.buildStyleMogrt !== 'function') {
        setBusy(false);
        return { ok: false, error: 'Style timeline synthesizer unavailable.' };
      }
      if (!premiereAppPath && typeof Premiere.ping === 'function') {
        try {
          var pInfo = await Premiere.ping();
          if (pInfo && pInfo.appPath) premiereAppPath = pInfo.appPath;
        } catch (ePing) {}
      }
      var firstFormattedText = formatCase(prepared[0].text, cfg.textCase);
      firstStyleBuild = Mogrt.buildStyleMogrt(selStyle, { appPath: premiereAppPath, text: firstFormattedText });
      if (!firstStyleBuild || !firstStyleBuild.ok || !firstStyleBuild.item) {
        var msgBuildErr = (firstStyleBuild && firstStyleBuild.error) || 'Could not prepare .prtextstyle for timeline placement.';
        setProgress(0, 'failed');
        if (!opts.silent) setStatus(msgBuildErr, 'warn');
        logLine('! ' + msgBuildErr, 'warn');
        setBusy(false);
        return { ok: false, error: msgBuildErr };
      }
      sel = firstStyleBuild.item;
    }

    var startedAt = Date.now();
    var fields = sel.textFields || [];
    var paramIdx = Math.max(0, parseInt(cfg.paramIndex, 10) || 0);
    var paramName = (fields[paramIdx] && fields[paramIdx].name) || (fields[0] && fields[0].name) || 'TextLayer';

    var rangeStart = prepared[0].start;
    var rangeEnd = prepared[prepared.length - 1].end;

    try {
      var hostOk = await Premiere.ensureHost();
      if (!hostOk) throw new Error('Could not load host.jsx in Premiere Pro.');

      var prep = await Premiere.prepareMogrtTrack({
        trackMode: cfg.trackMode || 'auto',
        startAt: rangeStart,
        endAt: rangeEnd,
        replaceExisting: !!cfg.replaceExisting
      });
      if (!prep || !prep.ok) {
        throw new Error((prep && prep.error) || 'Could not prepare target video track.');
      }

      if (prep.removed) {
        logLine('Cleared ' + prep.removed + ' prior MOGRT clip(s) on ' + prep.trackName + '.', 'dim');
      }

      var placed = 0;
      var textFailures = 0;
      var firstWarn = '';
      var paramNames = fields.map(function (f) { return f.name; });
      var jobs = buildPlacementJobs(prepared, selStyle ? 1 : fields.length);

      var fps = (prep.fps && isFinite(prep.fps) && prep.fps > 0) ? prep.fps : 30;
      var frameDur = 1 / fps;
      for (var ji = 0; ji < jobs.length; ji++) {
        var jStart = Math.round(jobs[ji].start * fps) / fps;
        var jEnd = Math.round(jobs[ji].end * fps) / fps;
        if (jEnd - jStart < frameDur * 2) jEnd = jStart + frameDur * 2;
        jobs[ji].start = jStart;
        jobs[ji].end = jEnd;
      }
      if (cfg.clampOverlaps) {
        for (var jc = 0; jc < jobs.length - 1; jc++) {
          if (jobs[jc].end > jobs[jc + 1].start - frameDur) {
            jobs[jc].end = Math.max(jobs[jc].start + frameDur * 2, jobs[jc + 1].start - frameDur);
          }
        }
      }

      var isAe = (sel.authorApp === 'After Effects');
      var heavyGpu = hasHeavyGpuFx(sel);
      var paceMs = heavyGpu ? 550 : (isAe ? 280 : 45);
      if (heavyGpu) {
        logLine('Heavy AE GPU effects detected (' + sel.usedEffects.slice(0, 3).join(', ') + ') — pacing gently to protect Premiere Player.', 'dim');
      }

      for (var ci = 0; ci < jobs.length; ci++) {
        if (stopRequested) break;
        var job = jobs[ci];
        var isLast = (ci === jobs.length - 1);
        var cuePath = sel.path;
        if (selStyle) {
          var cueBuild = (ci === 0 && firstStyleBuild && firstStyleBuild.item &&
            firstStyleBuild.item.textFields && firstStyleBuild.item.textFields[0] &&
            firstStyleBuild.item.textFields[0].sample === job.text)
            ? firstStyleBuild
            : Mogrt.buildStyleMogrt(selStyle, { appPath: premiereAppPath, text: job.text });
          if (!cueBuild || !cueBuild.ok || !cueBuild.path) {
            throw new Error((cueBuild && cueBuild.error) || ('Failed building styled caption ' + (ci + 1)));
          }
          cuePath = cueBuild.path;
        }

        setProgress(5 + (ci / jobs.length) * 94,
          'placing ' + (ci + 1) + '/' + jobs.length + ' on ' + prep.trackName + '…');

        var res = await Premiere.applyMogrtCue({
          path: cuePath,
          trackIndex: prep.trackIndex,
          audioTrackIndex: 0,
          start: job.start,
          end: job.end,
          text: job.text,
          texts: job.texts,
          textPrebaked: !!selStyle,
          paramName: paramName,
          paramNames: paramNames,
          paramIndex: paramIdx,
          positionMode: cfg.position,
          positionY: cfg.positionY / 100,
          fitToScreen: !!cfg.fitToScreen,
          mogrtWidth: sel.sourceWidth || 1920,
          mogrtHeight: sel.sourceHeight || 1080,
          isAfterEffects: isAe,
          heavyGpu: heavyGpu,
          refreshUI: isAe ? true : isLast
        });

        if (!res || !res.ok) {
          throw new Error((res && res.error) || ('Failed placing cue ' + (ci + 1)));
        }
        placed++;
        if (!res.textSet) {
          textFailures++;
          if (!firstWarn && res.warning) firstWarn = res.warning;
        }

        if (!isLast && !stopRequested) {
          await new Promise(function (resolve) { setTimeout(resolve, paceMs); });
        }
      }

      var elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (stopRequested) {
        setProgress(0, 'stopped after ' + placed + '/' + jobs.length);
        setStatus('Stopped — ' + placed + ' MOGRT clip(s) placed on ' + prep.trackName + '.', 'warn');
        logLine('MOGRT apply stopped after ' + placed + ' clip(s).', 'warn');
        return { ok: false, cancelled: true, placed: placed };
      }

      setProgress(100, 'done — ' + placed + ' MOGRTs on ' + prep.trackName + ' in ' + elapsed + 's');
      if (textFailures > 0) {
        var warnMsg = 'Placed ' + placed + ' clip(s) on ' + prep.trackName + ', but ' + textFailures +
          ' could not update text (' + (firstWarn || 'check MOGRT text field') + ').';
        setStatus(warnMsg, 'warn');
        logLine('! ' + warnMsg, 'warn');
      } else {
        var okMsg = 'Applied "' + (displayLabel || sel.name) + '" to ' + placed + ' caption(s) on ' + prep.trackName + ' (' + elapsed + 's).';
        setStatus(okMsg, 'ok');
        logLine(okMsg, 'ok');
      }

      progressTimer = setTimeout(function () {
        if (ui.progressTrack) ui.progressTrack.classList.add('closed');
      }, 1500);

      return { ok: true, placed: placed, trackName: prep.trackName };
    } catch (e) {
      var errMsg = (e && e.message) ? e.message : String(e);
      setProgress(0, 'failed');
      setStatus(errMsg, 'err');
      logLine('! MOGRT apply failed: ' + errMsg, 'err');
      return { ok: false, error: errMsg };
    } finally {
      if (typeof Mogrt !== 'undefined' && Mogrt.clearCache) Mogrt.clearCache();
      setBusy(false);
    }
  }

  async function autoRunAfterTranscribe() {
    var out = {};
    if (cfg && (cfg.autoApply || cfg.autoStyleOnTranscribe)) {
      ensureScanned();
    }
    var mode = resolvedMode();
    if (mode === 'style') {
      if (cfg && cfg.autoStyleOnTranscribe && selectedStyle()) {
        out.style = await sendStyleToProject({ silent: false });
        logLine('Applying selected text style to timeline captions…', 'dim');
        out.styleTimeline = await applyToRecent({ silent: false });
      }
      return out;
    }
    if (mode === 'mogrt') {
      if (cfg && cfg.autoApply && selectedTemplate()) {
        logLine('Applying selected MOGRT to recent captions…', 'dim');
        out.mogrt = await applyToRecent({ silent: false });
      }
    }
    return out;
  }

  function closeNewCatRow() {
    if (ui.catNewRow) ui.catNewRow.classList.add('hidden');
    if (ui.catNewInput) ui.catNewInput.value = '';
    var viewed = inspectedItem();
    renderCategoryPicker(viewed);
  }

  function addCustomCategory(name) {
    var clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!clean) return;
    if (!cfg.customCategories) cfg.customCategories = [];
    var exists = cfg.customCategories.find(function (c) { return c.toLowerCase() === clean.toLowerCase(); });
    var canonical = exists || clean;
    if (!exists) cfg.customCategories.push(canonical);

    var viewed = inspectedItem();
    if (viewed) cfg.itemCategories[itemKey(viewed)] = canonical;
    if (ui.catNewRow) ui.catNewRow.classList.add('hidden');
    if (ui.catNewInput) ui.catNewInput.value = '';
    renderFilterBar();
    renderSelected();
    renderGrid();
    save();
  }

  function deleteCustomCategory() {
    var viewed = inspectedItem();
    var viewedCat = viewed ? categoryOf(viewed) : '';
    var activeCat = (cfg.activeFilter && cfg.activeFilter.indexOf('cat:') === 0) ? cfg.activeFilter.slice(4) : '';
    var target = viewedCat || activeCat;
    if (!target) return;

    cfg.customCategories = (cfg.customCategories || []).filter(function (c) {
      return c.toLowerCase() !== target.toLowerCase();
    });
    for (var k in cfg.itemCategories) {
      if (Object.prototype.hasOwnProperty.call(cfg.itemCategories, k) &&
          String(cfg.itemCategories[k] || '').toLowerCase() === target.toLowerCase()) {
        delete cfg.itemCategories[k];
      }
    }
    if (cfg.activeFilter && cfg.activeFilter.toLowerCase() === ('cat:' + target.toLowerCase())) {
      cfg.activeFilter = 'all';
    }
    renderFilterBar();
    renderSelected();
    renderGrid();
    save();
  }

  function bind() {
    if (ui.importBtn) ui.importBtn.addEventListener('click', importCustomMogrt);
    if (ui.styleImportBtn) ui.styleImportBtn.addEventListener('click', importCustomStyle);
    if (ui.stylePreviewBtn) ui.stylePreviewBtn.addEventListener('click', attachStylePreviewImage);
    if (ui.styleSendBtn) ui.styleSendBtn.addEventListener('click', function () { sendStyleToProject(); });
    if (ui.folderBtn) ui.folderBtn.addEventListener('click', openCustomFolder);
    if (ui.rescanBtn) {
      ui.rescanBtn.addEventListener('click', function () {
        rescan();
        setStatus('Refreshed (' + library.length + ' preset' + (library.length === 1 ? '' : 's') + ').', 'dim');
      });
    }
    if (ui.search) {
      ui.search.addEventListener('input', function () {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderGrid, 90);
      });
    }

    if (ui.catSelect) {
      ui.catSelect.addEventListener('change', function () {
        var val = String(ui.catSelect.value || '');
        if (val === '__new__') {
          if (ui.catNewRow) ui.catNewRow.classList.remove('hidden');
          if (ui.catNewInput) {
            ui.catNewInput.value = '';
            try { ui.catNewInput.focus(); } catch (eF) {}
          }
          return;
        }
        var viewed = inspectedItem();
        if (viewed) {
          if (val) cfg.itemCategories[itemKey(viewed)] = val;
          else delete cfg.itemCategories[itemKey(viewed)];
        }
        renderFilterBar();
        renderSelected();
        renderGrid();
        save();
      });
    }

    if (ui.catNewSave) {
      ui.catNewSave.addEventListener('click', function () {
        addCustomCategory(ui.catNewInput ? ui.catNewInput.value : '');
      });
    }
    if (ui.catNewCancel) {
      ui.catNewCancel.addEventListener('click', closeNewCatRow);
    }
    if (ui.catNewInput) {
      ui.catNewInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          addCustomCategory(ui.catNewInput.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          closeNewCatRow();
        }
      });
    }
    if (ui.catDelBtn) ui.catDelBtn.addEventListener('click', deleteCustomCategory);

    bindHoverPreview(ui.selectedBox, ui.selectedVideo, inspectedItem);

    if (ui.paramSelect) {
      ui.paramSelect.addEventListener('change', function () {
        var raw = String(ui.paramSelect.value || 'split:0');
        var parts = raw.split(':');
        if (parts.length === 2) {
          cfg.fillMode = parts[0];
          cfg.paramIndex = Math.max(0, parseInt(parts[1], 10) || 0);
        } else {
          cfg.fillMode = 'single';
          cfg.paramIndex = Math.max(0, parseInt(raw, 10) || 0);
        }
        save();
      });
    }
    if (ui.trackSelect) {
      ui.trackSelect.addEventListener('change', function () {
        cfg.trackMode = ui.trackSelect.value || 'auto';
        save();
      });
    }
    if (ui.posSeg) {
      ui.posSeg.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var pos = btn.getAttribute('data-pos') || 'lower';
          cfg.position = pos;
          if (POS_PRESETS[pos] !== undefined) cfg.positionY = POS_PRESETS[pos];
          syncControls();
          save();
        });
      });
    }
    if (ui.posY) {
      ui.posY.addEventListener('input', function () {
        var v = Math.min(92, Math.max(8, Math.round(Number(ui.posY.value) || 82)));
        cfg.positionY = v;
        cfg.position = v < 36 ? 'upper' : (v <= 64 ? 'middle' : 'lower');
        syncRange(ui.posY);
        if (ui.posYVal) ui.posYVal.textContent = v + '%';
        if (ui.posSeg) {
          ui.posSeg.querySelectorAll('button').forEach(function (btn) {
            btn.classList.toggle('active', btn.getAttribute('data-pos') === cfg.position);
          });
        }
      });
      ui.posY.addEventListener('change', save);
    }
    if (ui.fitScreen) {
      ui.fitScreen.addEventListener('change', function () { cfg.fitToScreen = ui.fitScreen.checked; save(); });
    }
    if (ui.caseSeg) {
      ui.caseSeg.querySelectorAll('button').forEach(function (btn) {
        btn.addEventListener('click', function () {
          cfg.textCase = btn.getAttribute('data-case') || 'as-is';
          syncControls();
          save();
        });
      });
    }
    if (ui.clamp) {
      ui.clamp.addEventListener('change', function () { cfg.clampOverlaps = ui.clamp.checked; save(); });
    }
    if (ui.replace) {
      ui.replace.addEventListener('change', function () { cfg.replaceExisting = ui.replace.checked; save(); });
    }
    if (ui.autoApply) {
      ui.autoApply.addEventListener('change', function () { cfg.autoApply = ui.autoApply.checked; save(); });
    }
    if (ui.styleAutoImport) {
      ui.styleAutoImport.addEventListener('change', function () {
        cfg.autoStyleOnTranscribe = ui.styleAutoImport.checked;
        save();
      });
    }

    if (ui.applyBtn) ui.applyBtn.addEventListener('click', function () { applyToRecent(); });
    if (ui.stopBtn) {
      ui.stopBtn.addEventListener('click', function () {
        if (!running) return;
        stopRequested = true;
        ui.stopBtn.disabled = true;
        ui.stopBtn.textContent = 'Stopping…';
      });
    }
  }

  function init(mogrtSettings, persistFn, opts) {
    if (built) return;
    built = true;
    cfg = mogrtSettings;
    onPersist = persistFn;
    onLog = opts && opts.log;
    ensureState();

    ui = {
      rescanBtn: $('mogrtRescan'),
      countBadge: $('mogrtCountBadge'),
      importBtn: $('mogrtImportBtn'),
      styleImportBtn: $('styleImportBtn'),
      folderBtn: $('mogrtFolderBtn'),
      selectedBox: $('mogrtSelectedBox'),
      selectedThumb: $('mogrtSelectedThumb'),
      selectedVideo: $('mogrtSelectedVideo'),
      selectedMono: $('mogrtSelectedMono'),
      selectedSim: $('mogrtSelectedSim'),
      selectedName: $('mogrtSelectedName'),
      selectedMeta: $('mogrtSelectedMeta'),
      catSelect: $('assetCatSelect'),
      stylePreviewBtn: $('stylePreviewBtn'),
      catDelBtn: $('catDelBtn'),
      catNewRow: $('catNewRow'),
      catNewInput: $('catNewInput'),
      catNewSave: $('catNewSave'),
      catNewCancel: $('catNewCancel'),
      filtersWrap: $('mogrtFiltersWrap'),
      filterBar: $('mogrtFilterBar'),
      searchWrap: $('mogrtSearchWrap'),
      search: $('mogrtSearch'),
      grid: $('mogrtGrid'),
      emptyHint: $('mogrtEmptyHint'),
      emptyTitle: $('mogrtEmptyTitle'),
      emptyBody: $('mogrtEmptyBody'),
      styleActionBox: $('styleActionBox'),
      paramField: $('mogrtParamField'),
      autoApplyWrap: $('mogrtAutoApplyWrap'),
      applyHint: $('mogrtApplyHint'),
      styleSelectedBadge: $('styleSelectedBadge'),
      styleFontMeta: $('styleFontMeta'),
      styleSendBtn: $('styleSendBtn'),
      styleAutoImport: $('styleAutoImport'),
      cueBadge: $('mogrtCueBadge'),
      cueSummary: $('mogrtCueSummary'),
      paramSelect: $('mogrtParamSelect'),
      trackSelect: $('mogrtTrackSelect'),
      posSeg: $('mogrtPosition'),
      posY: $('mogrtPosY'),
      posYVal: $('mogrtPosYVal'),
      fitScreen: $('mogrtFitScreen'),
      caseSeg: $('mogrtCase'),
      clamp: $('mogrtClamp'),
      replace: $('mogrtReplace'),
      autoApply: $('mogrtAutoApply'),
      applyBtn: $('mogrtApplyBtn'),
      stopBtn: $('mogrtStopBtn'),
      progressTrack: $('mogrtProgressTrack'),
      bar: $('mogrtBar'),
      progressLabel: $('mogrtProgressLabel'),
      status: $('mogrtStatus')
    };

    bind();
    syncControls();
    refreshCues();
  }

  return {
    init: init,
    setVisible: function (visible) {
      if (visible) {
        ensureScanned();
        refreshCues();
      } else {
        unloadAllVideos();
      }
    },
    refreshCues: refreshCues,
    applyToRecent: applyToRecent,
    sendStyleToProject: sendStyleToProject,
    autoRunAfterTranscribe: autoRunAfterTranscribe
  };
})();
