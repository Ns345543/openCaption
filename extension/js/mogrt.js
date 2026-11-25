/*
 * mogrt.js — custom text .mogrt library manager and ZIP inspector.
 *
 * Only user-imported text Motion Graphics Templates (.mogrt) are stored and
 * shown (%APPDATA%\CaptionAI\mogrts\). Each .mogrt archive is parsed in Node.js
 * to extract metadata (name, Premiere vs After Effects author, exposed text
 * fields), thumbnail (thumb.png), and hover preview video (thumb.mp4).
 */
var Mogrt = (function () {
  'use strict';

  if (typeof NODE === 'undefined' || !NODE.ok ||
      typeof Config === 'undefined' || !Config.ok) {
    return { ok: false, error: 'Node.js or Config is unavailable.' };
  }

  var fs = NODE.fs;
  var path = NODE.path;
  var zlib = NODE.zlib;
  var crypto = NODE.crypto;

  var CUSTOM_DIR = path.join(Config.DATA_DIR, 'mogrts');
  var STYLE_DIR = path.join(Config.DATA_DIR, 'styles');
  var CACHE_DIR = path.join(CUSTOM_DIR, '.cache');
  var STYLE_CACHE_DIR = path.join(STYLE_DIR, '.cache');

  function ensureDirs() {
    [CUSTOM_DIR, STYLE_DIR, CACHE_DIR, STYLE_CACHE_DIR].forEach(function (dir) {
      try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      } catch (e) { /* ignore */ }
    });
  }

  /* ----------------------------------------------------------- ZIP parser */

  function findEocd(buf) {
    var minOff = Math.max(0, buf.length - 65558);
    for (var i = buf.length - 22; i >= minOff; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
  }

  function listZipEntries(buf) {
    var eocd = findEocd(buf);
    if (eocd < 0) throw new Error('Not a valid .mogrt archive (missing ZIP directory).');
    var cdOffset = buf.readUInt32LE(eocd + 16);
    var cdCount = buf.readUInt16LE(eocd + 10);
    var entries = {};
    var p = cdOffset;

    for (var i = 0; i < cdCount; i++) {
      if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
      var compMethod = buf.readUInt16LE(p + 10);
      var compSize = buf.readUInt32LE(p + 20);
      var nameLen = buf.readUInt16LE(p + 28);
      var extraLen = buf.readUInt16LE(p + 30);
      var commLen = buf.readUInt16LE(p + 32);
      var localOff = buf.readUInt32LE(p + 42);
      var name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
      entries[name] = {
        name: name,
        compMethod: compMethod,
        compSize: compSize,
        localOff: localOff
      };
      p += 46 + nameLen + extraLen + commLen;
    }
    return entries;
  }

  function readZipEntry(buf, entry) {
    if (!entry) return null;
    var lp = entry.localOff;
    if (lp + 30 > buf.length || buf.readUInt32LE(lp) !== 0x04034b50) return null;
    var nLen = buf.readUInt16LE(lp + 26);
    var eLen = buf.readUInt16LE(lp + 28);
    var start = lp + 30 + nLen + eLen;
    var data = buf.slice(start, start + entry.compSize);
    if (entry.compMethod === 0) return data;
    if (entry.compMethod === 8) return zlib.inflateRawSync(data);
    throw new Error('Unsupported ZIP compression method ' + entry.compMethod);
  }

  function pickLocalizedText(field, fallback) {
    if (!field) return fallback || '';
    if (typeof field === 'string') return field;
    if (field.strDB && Array.isArray(field.strDB) && field.strDB.length) {
      for (var i = 0; i < field.strDB.length; i++) {
        if (field.strDB[i].localeString === 'en_US' && field.strDB[i].str) {
          return String(field.strDB[i].str);
        }
      }
      for (var j = 0; j < field.strDB.length; j++) {
        if (field.strDB[j].str) return String(field.strDB[j].str);
      }
    }
    return fallback || '';
  }

  function parseControls(def) {
    var controls = (def && Array.isArray(def.clientControls)) ? def.clientControls : [];
    var textFields = [];

    function walk(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || typeof c !== 'object') continue;
        if (c.hidden) continue;
        if (Number(c.type) === 6) {
          var label = pickLocalizedText(c.uiName, 'Text ' + (textFields.length + 1));
          var sample = pickLocalizedText(c.value, '');
          textFields.push({
            index: textFields.length,
            id: String(c.id || textFields.length),
            name: label,
            sample: sample
          });
        }
        if (Array.isArray(c.children)) walk(c.children);
      }
    }

    walk(controls);
    return textFields;
  }

  function cacheKeyFor(filePath, stat) {
    var raw = path.resolve(filePath).toLowerCase() + '|' + stat.size + '|' + Math.round(stat.mtimeMs || 0);
    if (crypto && typeof crypto.createHash === 'function') {
      return crypto.createHash('md5').update(raw).digest('hex');
    }
    return raw.replace(/[^a-z0-9]+/g, '_').slice(0, 48);
  }

  function toFileUrl(filePath) {
    return 'file:///' + path.resolve(filePath).replace(/\\/g, '/').replace(/^\/+/, '');
  }

  function extractPreviewVideo(buf, entries, filePath, stat, writeCache) {
    var videoEntry = entries['thumb.mp4'] || entries['thumb_en_US.mp4'];
    if (!videoEntry || !writeCache) return '';
    try {
      ensureDirs();
      var cachePath = path.join(CACHE_DIR, cacheKeyFor(filePath, stat) + '.mp4');
      if (!fs.existsSync(cachePath)) {
        var videoBuf = readZipEntry(buf, videoEntry);
        if (videoBuf && videoBuf.length) {
          fs.writeFileSync(cachePath, videoBuf);
        }
      }
      return fs.existsSync(cachePath) ? toFileUrl(cachePath) : '';
    } catch (e) {
      return '';
    }
  }

  /** Reads metadata, thumbnail, and optional preview video from a .mogrt file. */
  function inspect(filePath, opts) {
    opts = opts || {};
    var stat = fs.statSync(filePath);
    var buf = fs.readFileSync(filePath);
    var entries = listZipEntries(buf);

    var defEntry = entries['definition.json'];
    if (!defEntry) {
      throw new Error('Missing definition.json inside ' + path.basename(filePath));
    }

    var def = JSON.parse(readZipEntry(buf, defEntry).toString('utf8'));
    var name = pickLocalizedText(def.capsuleNameLocalized, '') ||
               def.capsuleName ||
               path.basename(filePath, path.extname(filePath));
    var authorApp = String(def.authorApp || '').toLowerCase();
    var textFields = parseControls(def);

    var frameW = 1920;
    var frameH = 1080;
    try {
      var sil = def.sourceInfoLocalized || {};
      var srcInfo = sil.en_US || sil[Object.keys(sil)[0]];
      if (srcInfo && srcInfo.framesize && srcInfo.framesize.size) {
        var fw = Number(srcInfo.framesize.size.x);
        var fh = Number(srcInfo.framesize.size.y);
        if (isFinite(fw) && fw > 0 && isFinite(fh) && fh > 0) {
          frameW = fw;
          frameH = fh;
        }
      }
    } catch (eSize) { /* fallback 1920x1080 */ }

    var thumbUrl = '';
    var thumbEntry = entries['thumb.png'] || entries['thumb_en_US.png'];
    if (thumbEntry) {
      try {
        var thumbBuf = readZipEntry(buf, thumbEntry);
        if (thumbBuf && thumbBuf.length) {
          thumbUrl = 'data:image/png;base64,' + thumbBuf.toString('base64');
        }
      } catch (eThumb) { thumbUrl = ''; }
    }

    var videoUrl = extractPreviewVideo(buf, entries, filePath, stat, opts.cacheVideo !== false);
    var usedEffects = Array.isArray(def.usedEffects)
      ? def.usedEffects.map(function (fx) { return String(fx || ''); }).filter(Boolean)
      : [];

    return {
      kind: 'mogrt',
      path: path.resolve(filePath),
      fileName: path.basename(filePath),
      name: String(name || path.basename(filePath, '.mogrt')),
      authorApp: (authorApp === 'aefx' || authorApp === 'aeft') ? 'After Effects' : 'Premiere',
      source: 'custom',
      sourceWidth: frameW,
      sourceHeight: frameH,
      textFields: textFields,
      usedEffects: usedEffects,
      thumbUrl: thumbUrl,
      videoUrl: videoUrl,
      size: stat.size
    };
  }

  /* --------------------------------------------------- .prtextstyle tools */

  var PNG_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  var PNG_END_BYTES = [0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  var JPG_BYTES = [0xff, 0xd8, 0xff];
  var JPG_END_BYTES = [0xff, 0xd9];
  var PREVIEW_EXTS = ['.preview.png', '.preview.jpg', '.preview.jpeg', '.preview.webp', '.png', '.jpg', '.jpeg', '.webp'];

  function mimeForExt(ext) {
    var e = String(ext || '').toLowerCase();
    if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
    if (e === '.webp') return 'image/webp';
    return 'image/png';
  }

  function extractEmbeddedImage(buf) {
    if (!buf || !buf.length || typeof Buffer === 'undefined') return '';
    try {
      var pStart = buf.indexOf(Buffer.from(PNG_BYTES));
      if (pStart >= 0) {
        var pEnd = buf.indexOf(Buffer.from(PNG_END_BYTES), pStart + 8);
        if (pEnd > pStart && (pEnd + 8 - pStart) <= 5 * 1024 * 1024) {
          return 'data:image/png;base64,' + buf.slice(pStart, pEnd + 8).toString('base64');
        }
      }
      var jStart = buf.indexOf(Buffer.from(JPG_BYTES));
      if (jStart >= 0) {
        var maxEnd = Math.min(buf.length, jStart + 4 * 1024 * 1024);
        var slice = buf.slice(jStart, maxEnd);
        var jEnd = slice.lastIndexOf(Buffer.from(JPG_END_BYTES));
        if (jEnd > 16) {
          return 'data:image/jpeg;base64,' + slice.slice(0, jEnd + 2).toString('base64');
        }
      }
    } catch (eImg) { /* non-fatal */ }
    return '';
  }

  function findCompanionPreview(stylePath) {
    var baseNoExt = stylePath.replace(/\.prtextstyle$/i, '');
    for (var i = 0; i < PREVIEW_EXTS.length; i++) {
      var candidate = baseNoExt + PREVIEW_EXTS[i];
      try {
        if (fs.existsSync(candidate)) {
          var st = fs.statSync(candidate);
          if (st.isFile() && st.size > 0 && st.size <= 5 * 1024 * 1024) {
            var ext = path.extname(candidate);
            return 'data:' + mimeForExt(ext) + ';base64,' + fs.readFileSync(candidate).toString('base64');
          }
        }
      } catch (eRead) {}
    }
    return '';
  }

  function clearCompanionPreviews(stylePath) {
    var baseNoExt = stylePath.replace(/\.prtextstyle$/i, '');
    for (var i = 0; i < PREVIEW_EXTS.length; i++) {
      var candidate = baseNoExt + PREVIEW_EXTS[i];
      try {
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
      } catch (eDel) {}
    }
  }

  function copyCompanionFromSource(srcStylePath, destStylePath) {
    var srcBase = srcStylePath.replace(/\.prtextstyle$/i, '');
    var destBase = destStylePath.replace(/\.prtextstyle$/i, '');
    for (var i = 0; i < PREVIEW_EXTS.length; i++) {
      var srcImg = srcBase + PREVIEW_EXTS[i];
      try {
        if (fs.existsSync(srcImg) && fs.statSync(srcImg).isFile()) {
          var ext = path.extname(srcImg).toLowerCase();
          fs.copyFileSync(srcImg, destBase + '.preview' + ext);
          return;
        }
      } catch (eCopy) {}
    }
  }

  function decodeBasicXmlEntities(str) {
    return String(str || '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, '\'');
  }

  function rgbToHex(r, g, b) {
    function h(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0'); }
    return '#' + h(r) + h(g) + h(b);
  }

  function hexToRgbInt(hex, fallbackInt) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    return m ? parseInt(m[1], 16) : (fallbackInt === undefined ? 0xffffff : fallbackInt);
  }

  function parseFbColorTable(buf, tablePos) {
    try {
      if (!buf || tablePos < 0 || tablePos + 4 > buf.length) return null;
      var soff = buf.readInt32LE(tablePos);
      var vpos = tablePos - soff;
      if (vpos < 0 || vpos + 6 > buf.length) return null;
      var vlen = buf.readUInt16LE(vpos);
      var tlen = buf.readUInt16LE(vpos + 2);
      if (vlen < 6 || vlen > 16 || (vlen % 2) !== 0 || tlen > 24 || tablePos + tlen > buf.length) return null;
      function ch(slotIdx) {
        var offIdx = vpos + 4 + slotIdx * 2;
        if (offIdx + 2 > vpos + vlen) return 255;
        var foff = buf.readUInt16LE(offIdx);
        if (!foff) return 255; // FlatBuffer channel schema defaults to 255 when omitted
        return (tablePos + foff < buf.length) ? buf[tablePos + foff] : 255;
      }
      return { r: ch(0), g: ch(1), b: ch(2), hex: rgbToHex(ch(0), ch(1), ch(2)) };
    } catch (eCol) {
      return null;
    }
  }

  function parseFlatBufferStyle(rawBuf) {
    var parsed = { fillHex: '', strokeHex: '', strokeWidth: 0, alignment: 2, fontSize: 0 };
    try {
      if (!rawBuf || rawBuf.length < 64 || rawBuf.readUInt32LE(8) !== 0x11223344) return parsed;
      var rootRel = rawBuf.readUInt32LE(12);
      var rootPos = 12 + rootRel;
      if (rootPos + 8 > rawBuf.length) return parsed;
      var rootSoff = rawBuf.readInt32LE(rootPos);
      var rootVpos = rootPos - rootSoff;
      if (rootVpos < 12 || rootVpos + 6 > rawBuf.length) return parsed;
      var f0off = rawBuf.readUInt16LE(rootVpos + 4);
      if (!f0off) return parsed;
      var docRefPos = rootPos + f0off;
      var docPos = docRefPos + rawBuf.readUInt32LE(docRefPos);
      if (docPos + 8 > rawBuf.length) return parsed;

      // Locate RunStyle subtable (the run style containing strokeWidth float & fill/stroke color refs)
      for (var p = Math.max(128, docPos + 16); p <= rawBuf.length - 16; p += 2) {
        var s = rawBuf.readInt32LE(p);
        var vp = p - s;
        if (s > 8 && s < 256 && vp >= 12 && vp + 4 <= p) {
          var vl = rawBuf.readUInt16LE(vp);
          var tl = rawBuf.readUInt16LE(vp + 2);
          if (vl >= 36 && vl <= 80 && (vl % 2) === 0 && tl >= 12 && tl <= 64 && p + tl <= rawBuf.length) {
            function slotPos(idx) {
              var vo = vp + 4 + idx * 2;
              if (vo + 2 > vp + vl) return -1;
              var fo = rawBuf.readUInt16LE(vo);
              return fo ? (p + fo) : -1;
            }
            var fillSlot = slotPos(2);
            var strokeSlot = slotPos(4);
            var strokeVisSlot = slotPos(5);
            var strokeWSlot = slotPos(6);
            var alignSlot = slotPos(24);
            var fillTbl = (fillSlot >= 0 && fillSlot + 4 <= rawBuf.length) ? parseFbColorTable(rawBuf, fillSlot + rawBuf.readUInt32LE(fillSlot)) : null;
            var strokeTbl = (strokeSlot >= 0 && strokeSlot + 4 <= rawBuf.length) ? parseFbColorTable(rawBuf, strokeSlot + rawBuf.readUInt32LE(strokeSlot)) : null;
            if (fillTbl) parsed.fillHex = fillTbl.hex;
            if (strokeTbl) parsed.strokeHex = strokeTbl.hex;
            if (strokeWSlot >= 0 && strokeWSlot + 4 <= rawBuf.length) {
              var sw = rawBuf.readFloatLE(strokeWSlot);
              var sVis = (strokeVisSlot >= 0 && strokeVisSlot < rawBuf.length) ? !!rawBuf[strokeVisSlot] : true;
              if (sVis && isFinite(sw) && sw > 0 && sw < 100) parsed.strokeWidth = Math.round(sw * 10) / 10;
            }
            if (alignSlot >= 0 && alignSlot + 4 <= rawBuf.length) {
              var al = rawBuf.readUInt32LE(alignSlot);
              if (al <= 4) parsed.alignment = al;
            }
            if (parsed.fillHex || parsed.strokeHex) break;
          }
        }
      }
    } catch (eFb) {}
    return parsed;
  }

  function applyFontTokenMeta(out, picked) {
    if (!picked) return;
    out.fontName = picked;
    var parts = picked.split('-');
    var baseFamily = parts[0].replace(/([a-z])([A-Z])/g, '$1 $2').replace(/PS$|MT$/g, '').trim();
    var stylePart = parts.slice(1).join(' ');
    out.fontFamily = baseFamily || picked;
    if (/Black|Heavy|ExtraBold|Ultra/i.test(stylePart)) out.fontWeight = '900';
    else if (/Bold|SemiBold|Demi/i.test(stylePart)) out.fontWeight = '700';
    else if (/Medium/i.test(stylePart)) out.fontWeight = '500';
    else if (/Light|Thin/i.test(stylePart)) out.fontWeight = '300';
    else out.fontWeight = '600';
    out.fontStyle = /Italic|Oblique/i.test(stylePart) ? 'italic' : 'normal';
  }

  function extractXmlStyleMeta(rawBuf) {
    var out = {
      styleLabel: '',
      fontName: '',
      fontFamily: '',
      fontWeight: '',
      fontStyle: '',
      fillHex: '#ffffff',
      strokeHex: '#000000',
      strokeWidth: 0,
      fontSize: 92,
      alignment: 2
    };
    if (!rawBuf || !rawBuf.length) return out;
    var head = rawBuf.slice(0, Math.min(rawBuf.length, 512)).toString('utf8');
    if (head.indexOf('<PremiereData') < 0 && head.indexOf('<?xml') < 0) return out;

    var xml = rawBuf.toString('utf8');
    var styleMatch = xml.match(/<StyleProjectItem\b[\s\S]*?<Name>([^<]+)<\/Name>/i);
    if (styleMatch && styleMatch[1]) {
      out.styleLabel = decodeBasicXmlEntities(styleMatch[1].trim());
    }

    var kfRegex = /<StartKeyframeValue\b[^>]*>([^<]+)<\/StartKeyframeValue>/gi;
    var kfMatch;
    while ((kfMatch = kfRegex.exec(xml)) !== null) {
      var b64 = String(kfMatch[1] || '').replace(/\s+/g, '');
      if (b64.length < 24) continue;
      try {
        var rawKf = Buffer.from(b64, 'base64');
        // Version="2" UTF-16LE JSON format (mTextParam)
        if (rawKf.length > 16) {
          var u16 = rawKf.slice(8).toString('utf16le').replace(/\0+$/, '');
          if (u16.indexOf('mTextParam') >= 0) {
            try {
              var jp = JSON.parse(u16);
              var tp = jp.mTextParam || {};
              var ss = tp.mStyleSheet || {};
              var dr = (tp.mDefaultRun && tp.mDefaultRun[0] && tp.mDefaultRun[0].mStyleParam) || null;
              var fn = (ss.mFontName && ss.mFontName.mParamValues && ss.mFontName.mParamValues[0] && ss.mFontName.mParamValues[0][1]) || (dr && dr.mFontName) || '';
              if (fn) applyFontTokenMeta(out, fn);
              if (ss.mFillColor && ss.mFillColor.mParamValues && ss.mFillColor.mParamValues[0]) {
                var fv = Number(ss.mFillColor.mParamValues[0][1]) >>> 0;
                out.fillHex = '#' + (fv & 0xffffff).toString(16).padStart(6, '0');
              } else if (dr && dr.mFillRed !== undefined) {
                out.fillHex = rgbToHex(dr.mFillRed * 255, dr.mFillGreen * 255, dr.mFillBlue * 255);
              }
              if (ss.mStrokeVisible && ss.mStrokeVisible.mParamValues && ss.mStrokeVisible.mParamValues[0] && ss.mStrokeVisible.mParamValues[0][1]) {
                if (ss.mStrokeColor && ss.mStrokeColor.mParamValues && ss.mStrokeColor.mParamValues[0]) {
                  var sv = Number(ss.mStrokeColor.mParamValues[0][1]) >>> 0;
                  out.strokeHex = '#' + (sv & 0xffffff).toString(16).padStart(6, '0');
                }
                if (ss.mStrokeWidth && ss.mStrokeWidth.mParamValues && ss.mStrokeWidth.mParamValues[0]) {
                  out.strokeWidth = Number(ss.mStrokeWidth.mParamValues[0][1]) || 2;
                }
              }
              if (ss.mFontSize && ss.mFontSize.mParamValues && ss.mFontSize.mParamValues[0]) {
                var fsz = Number(ss.mFontSize.mParamValues[0][1]);
                if (isFinite(fsz) && fsz > 10) out.fontSize = fsz;
              }
              if (isFinite(Number(tp.mAlignment))) out.alignment = Number(tp.mAlignment);
              break;
            } catch (eJ) {}
          }
        }

        // Version="3" FlatBuffer format
        var fbMeta = parseFlatBufferStyle(rawKf);
        if (fbMeta.fillHex) out.fillHex = fbMeta.fillHex;
        if (fbMeta.strokeHex) out.strokeHex = fbMeta.strokeHex;
        if (fbMeta.strokeWidth > 0) out.strokeWidth = fbMeta.strokeWidth;
        if (isFinite(fbMeta.alignment)) out.alignment = fbMeta.alignment;

        var decoded = rawKf.toString('latin1');
        var tokens = decoded.match(/[A-Za-z][A-Za-z0-9._-]{2,48}/g) || [];
        var picked = '';
        for (var i = 0; i < tokens.length; i++) {
          var t = tokens[i];
          if (/^(Root|Source|True|False|None|Aa)$/i.test(t)) continue;
          if (/^[A-Za-z0-9]+-[A-Za-z0-9-]+$/.test(t) ||
              /(Regular|Bold|Italic|Oblique|Medium|SemiBold|Black|Heavy|Light|Thin|MT|PS)$/i.test(t)) {
            picked = t;
            break;
          }
          if (!picked && t.length >= 4) picked = t;
        }
        if (picked) {
          applyFontTokenMeta(out, picked);
          break;
        }
      } catch (eB64) {}
    }
    return out;
  }

  /** Reads metadata & optional companion/embedded preview from a .prtextstyle file. */
  function inspectStyle(filePath) {
    var stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size <= 0) {
      throw new Error('Selected .prtextstyle file is empty.');
    }
    var thumbUrl = findCompanionPreview(filePath);
    var rawBuf = null;
    if (stat.size <= 25 * 1024 * 1024) {
      try {
        rawBuf = fs.readFileSync(filePath);
      } catch (eRead) { rawBuf = null; }
    }
    if (!thumbUrl && rawBuf) {
      try {
        thumbUrl = extractEmbeddedImage(rawBuf);
      } catch (eBin) { thumbUrl = ''; }
    }
    var xmlMeta = extractXmlStyleMeta(rawBuf);
    var fileTitle = path.basename(filePath, path.extname(filePath));
    return {
      kind: 'style',
      path: path.resolve(filePath),
      fileName: path.basename(filePath),
      name: fileTitle,
      styleLabel: xmlMeta.styleLabel || '',
      fontName: xmlMeta.fontName || '',
      fontFamily: xmlMeta.fontFamily || '',
      fontWeight: xmlMeta.fontWeight || '',
      fontStyle: xmlMeta.fontStyle || '',
      fillHex: xmlMeta.fillHex || '#ffffff',
      strokeHex: xmlMeta.strokeHex || '#000000',
      strokeWidth: xmlMeta.strokeWidth || 0,
      fontSize: xmlMeta.fontSize || 92,
      alignment: isFinite(xmlMeta.alignment) ? xmlMeta.alignment : 2,
      authorApp: 'Premiere Style',
      source: 'custom',
      sourceWidth: 1920,
      sourceHeight: 1080,
      textFields: [],
      thumbUrl: thumbUrl,
      videoUrl: '',
      size: stat.size
    };
  }

  /* -------------------------------------- synthesize native Premiere .mogrt */

  var CRC_TABLE = (function () {
    var t = [];
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(buf) {
    var c = 0xffffffff;
    for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function writeZip(files) {
    var localParts = [];
    var centralParts = [];
    var offset = 0;
    for (var i = 0; i < files.length; i++) {
      var nameBuf = Buffer.from(files[i].name, 'utf8');
      var dataBuf = files[i].data;
      var useDeflate = files[i].compress !== false && dataBuf.length > 64;
      var body = useDeflate ? zlib.deflateRawSync(dataBuf) : dataBuf;
      var method = useDeflate ? 8 : 0;
      var crc = crc32(dataBuf);

      var lfh = Buffer.alloc(30);
      lfh.writeUInt32LE(0x04034b50, 0);
      lfh.writeUInt16LE(20, 4);
      lfh.writeUInt16LE(0, 6);
      lfh.writeUInt16LE(method, 8);
      lfh.writeUInt16LE(0, 10);
      lfh.writeUInt16LE(0x5421, 12);
      lfh.writeUInt32LE(crc, 14);
      lfh.writeUInt32LE(body.length, 18);
      lfh.writeUInt32LE(dataBuf.length, 22);
      lfh.writeUInt16LE(nameBuf.length, 26);
      lfh.writeUInt16LE(0, 28);
      localParts.push(lfh, nameBuf, body);

      var cdh = Buffer.alloc(46);
      cdh.writeUInt32LE(0x02014b50, 0);
      cdh.writeUInt16LE(20, 4);
      cdh.writeUInt16LE(20, 6);
      cdh.writeUInt16LE(0, 8);
      cdh.writeUInt16LE(method, 10);
      cdh.writeUInt16LE(0, 12);
      cdh.writeUInt16LE(0x5421, 14);
      cdh.writeUInt32LE(crc, 16);
      cdh.writeUInt32LE(body.length, 20);
      cdh.writeUInt32LE(dataBuf.length, 24);
      cdh.writeUInt16LE(nameBuf.length, 28);
      cdh.writeUInt16LE(0, 30);
      cdh.writeUInt16LE(0, 32);
      cdh.writeUInt16LE(0, 34);
      cdh.writeUInt16LE(0, 36);
      cdh.writeUInt32LE(0, 38);
      cdh.writeUInt32LE(offset, 42);
      centralParts.push(cdh, nameBuf);

      offset += 30 + nameBuf.length + body.length;
    }

    var centralBuf = Buffer.concat(centralParts);
    var eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(files.length, 8);
    eocd.writeUInt16LE(files.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat(localParts.concat([centralBuf, eocd]));
  }

  function findBasicTitleMogrt(appPathHint) {
    var candidates = [];
    if (appPathHint) {
      candidates.push(path.join(appPathHint, 'Essential Graphics', 'Basic Title.mogrt'));
      candidates.push(path.join(path.dirname(appPathHint), 'Essential Graphics', 'Basic Title.mogrt'));
    }
    var proc = (typeof NODE !== 'undefined' && NODE.process) || (typeof process !== 'undefined' ? process : null);
    var env = (proc && proc.env) ? proc.env : {};
    var plat = (NODE.os && typeof NODE.os.platform === 'function') ? NODE.os.platform() : (proc ? proc.platform : 'win32');
    var progFiles = [
      env.ProgramFiles || 'C:\\Program Files',
      env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    ].filter(Boolean);
    for (var pi = 0; pi < progFiles.length; pi++) {
      var adobeDir = path.join(progFiles[pi], 'Adobe');
      try {
        if (fs.existsSync(adobeDir)) {
          var subs = fs.readdirSync(adobeDir).filter(function (n) { return /Adobe Premiere Pro/i.test(n); });
          subs.sort().reverse();
          subs.forEach(function (sub) {
            candidates.push(path.join(adobeDir, sub, 'Essential Graphics', 'Basic Title.mogrt'));
          });
        }
      } catch (eWin) {}
    }
    if (plat === 'darwin') {
      try {
        var apps = fs.readdirSync('/Applications').filter(function (n) { return /Adobe Premiere Pro/i.test(n); }).sort().reverse();
        apps.forEach(function (dirName) {
          var appName = fs.readdirSync(path.join('/Applications', dirName)).find(function (f) { return /\.app$/i.test(f); });
          if (appName) {
            candidates.push(path.join('/Applications', dirName, appName, 'Contents', 'Essential Graphics', 'Basic Title.mogrt'));
          }
        });
      } catch (eMac) {}
    }
    for (var ci = 0; ci < candidates.length; ci++) {
      try {
        if (fs.existsSync(candidates[ci]) && fs.statSync(candidates[ci]).isFile()) return candidates[ci];
      } catch (eCk) {}
    }
    return '';
  }

  function formatGuidFromSha1(hex) {
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
  }

  function patchPrgraphicForStyle(prgraphicBuf, styleItem) {
    var innerMap = listZipEntries(prgraphicBuf);
    var outInner = [];
    var names = Object.keys(innerMap);
    for (var ni = 0; ni < names.length; ni++) {
      var entryName = names[ni];
      var raw = readZipEntry(prgraphicBuf, innerMap[entryName]);
      var wasGzip = (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b);
      var xml = (wasGzip ? zlib.gunzipSync(raw) : raw).toString('utf8');

      xml = xml.replace(/(<ArbVideoComponentParam[\s\S]*?<StartKeyframeValue\b[^>]*BinaryHash=")([^"]*)("[^>]*>)([\s\S]*?)(<\/StartKeyframeValue>)/,
        function (_, p1, oldHash, p3, b64, p5) {
          var oldBuf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
          var jsonStr = oldBuf.slice(8).toString('utf16le').replace(/\0+$/, '');
          var data = JSON.parse(jsonStr);
          var tp = data.mTextParam || {};
          var ss = tp.mStyleSheet || {};
          var fontName = styleItem.fontName || 'Helvetica-Bold';
          var fillHex = styleItem.fillHex || '#ffffff';
          var strokeHex = styleItem.strokeHex || '#000000';
          var strokeWidth = Number(styleItem.strokeWidth || 0);
          var fontSize = Number(styleItem.fontSize || 92);

          if (ss.mFontName) ss.mFontName.mParamValues = [[0, fontName]];
          if (ss.mFontSize) ss.mFontSize.mParamValues = [[0, fontSize]];
          if (ss.mFillColor) ss.mFillColor.mParamValues = [[0, hexToRgbInt(fillHex, 0xffffff)]];
          if (ss.mFillVisible) ss.mFillVisible.mParamValues = [[0, true]];
          if (ss.mFillOverStroke) ss.mFillOverStroke.mParamValues = [[0, true]];
          if (strokeWidth > 0) {
            if (ss.mStrokeVisible) ss.mStrokeVisible.mParamValues = [[0, true]];
            if (ss.mStrokeColor) ss.mStrokeColor.mParamValues = [[0, hexToRgbInt(strokeHex, 0x000000)]];
            ss.mStrokeWidth = { mParamValues: [[0, strokeWidth]] };
          }
          if (ss.mText !== undefined) ss.mText = 'Caption';
          if (isFinite(Number(styleItem.alignment))) tp.mAlignment = Number(styleItem.alignment);

          var u16 = Buffer.from(JSON.stringify(data), 'utf16le');
          var hdr = Buffer.alloc(8);
          hdr.writeUInt32LE(u16.length, 0);
          hdr.writeUInt32LE(0, 4);
          var packed = Buffer.concat([hdr, u16]);
          var prefixHash = oldHash.slice(0, 28) || '4de5f4ac-52e0-27f0-bff8-d62c';
          var lenSuffix = (packed.length + 12).toString(16).padStart(8, '0');
          return p1 + prefixHash + lenSuffix + p3 + packed.toString('base64') + '\n\t\t' + p5;
        }
      );

      // Center internal Text Position accurately so extension Upper/Middle/Lower alignment stays exact.
      xml = xml.replace(/(<Name>Position<\/Name>[\s\S]*?<StartKeyframe>[^,]*,)([^<]*)(<\/StartKeyframe>)/,
        '$10.5,0.5,0,0,0,0,0,0,0,5,4,0,0,0,0$3');

      var xmlBuf = Buffer.from(xml, 'utf8');
      outInner.push({ name: entryName, data: wasGzip ? zlib.gzipSync(xmlBuf) : xmlBuf, compress: true });
    }
    return writeZip(outInner);
  }

  /** Builds a cached Premiere-native Text .mogrt styled from a .prtextstyle preset. */
  function buildStyleMogrt(styleItem, opts) {
    opts = opts || {};
    ensureDirs();
    if (!styleItem || !styleItem.path || !fs.existsSync(styleItem.path)) {
      return { ok: false, error: 'Selected .prtextstyle file was not found.' };
    }
    var basePath = opts.baseMogrtPath || findBasicTitleMogrt(opts.appPath);
    if (!basePath || !fs.existsSync(basePath)) {
      return { ok: false, error: 'Premiere built-in "Basic Title.mogrt" was not found to wrap the text style.' };
    }

    try {
      var stStat = fs.statSync(styleItem.path);
      var keyRaw = [
        'style-mogrt-v1',
        path.resolve(styleItem.path).toLowerCase(),
        stStat.size,
        Math.round(stStat.mtimeMs),
        styleItem.fontName || '',
        styleItem.fillHex || '',
        styleItem.strokeHex || '',
        styleItem.strokeWidth || 0
      ].join('|');
      var keyHash = crypto.createHash('sha1').update(keyRaw).digest('hex');
      var outPath = path.join(STYLE_CACHE_DIR, keyHash.slice(0, 20) + '.mogrt');

      if (!fs.existsSync(outPath)) {
        var baseBuf = fs.readFileSync(basePath);
        var entries = listZipEntries(baseBuf);
        var outFiles = [];
        var capsuleId = formatGuidFromSha1(keyHash);
        var entryNames = Object.keys(entries);

        for (var i = 0; i < entryNames.length; i++) {
          var ename = entryNames[i];
          var edata = readZipEntry(baseBuf, entries[ename]);
          if (ename === 'definition.json') {
            var def = JSON.parse(edata.toString('utf8'));
            def.capsuleID = capsuleId;
            def.capsuleName = styleItem.name || 'Text Style';
            def.capsuleNameLocalized = { strDB: [{ localeString: 'en_US', str: def.capsuleName }] };
            if (Array.isArray(def.clientControls) && def.clientControls[0]) {
              def.clientControls[0].value = { strDB: [{ localeString: 'en_US', str: 'Caption' }] };
              def.clientControls[0].fonteditinfo = {
                capPropFontEdit: true,
                capPropFontFauxStyleEdit: true,
                capPropFontSizeEdit: true,
                fontEditValue: styleItem.fontName || '',
                fontFSAllCapsValue: false,
                fontFSBoldValue: /Bold/i.test(styleItem.fontName || ''),
                fontFSItalicValue: /Italic|Oblique/i.test(styleItem.fontName || ''),
                fontFSSmallCapsValue: false,
                fontSizeEditValue: Number(styleItem.fontSize || 92)
              };
            }
            if (styleItem.fontName) {
              def.usedFontsLocalized = { en_US: [styleItem.fontName] };
            }
            outFiles.push({ name: ename, data: Buffer.from(JSON.stringify(def), 'utf8'), compress: true });
          } else if (/^project(?:_[^.]+)?\.prgraphic$/i.test(ename)) {
            outFiles.push({ name: ename, data: patchPrgraphicForStyle(edata, styleItem), compress: true });
          } else if (ename === 'thumb.png' || ename === 'thumb_en_US.png') {
            outFiles.push({ name: ename, data: edata, compress: true });
          }
        }
        fs.writeFileSync(outPath, writeZip(outFiles));
      }

      return { ok: true, path: outPath, item: inspect(outPath, { cacheVideo: false }) };
    } catch (eBuild) {
      return { ok: false, error: 'Could not prepare timeline template for text style: ' + eBuild.message };
    }
  }

  /* ------------------------------------------------------ custom library */

  function scanLibrary() {
    ensureDirs();
    var list = [];
    var files = [];

    try {
      var entries = fs.readdirSync(CUSTOM_DIR, { withFileTypes: true });
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isFile() && /\.mogrt$/i.test(entries[i].name)) {
          files.push(path.join(CUSTOM_DIR, entries[i].name));
        }
      }
    } catch (e) { /* keep empty */ }

    for (var f = 0; f < files.length; f++) {
      try {
        var item = inspect(files[f], { cacheVideo: true });
        if (item.textFields && item.textFields.length > 0) {
          list.push(item);
        }
      } catch (eRead) { /* skip unreadable or malformed template */ }
    }

    try {
      var styleEntries = fs.readdirSync(STYLE_DIR, { withFileTypes: true });
      for (var s = 0; s < styleEntries.length; s++) {
        if (styleEntries[s].isFile() && /\.prtextstyle$/i.test(styleEntries[s].name)) {
          try {
            list.push(inspectStyle(path.join(STYLE_DIR, styleEntries[s].name)));
          } catch (eStyle) { /* skip unreadable style */ }
        }
      }
    } catch (e2) { /* ignore */ }

    list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    return list;
  }

  function uniqueDestPath(dir, srcPath, extWithDot) {
    var base = path.basename(srcPath, path.extname(srcPath))
      .replace(/[\\/:*?"<>|]+/g, '_')
      .trim() || 'item';
    var dest = path.join(dir, base + extWithDot);
    var idx = 1;
    while (fs.existsSync(dest) && path.resolve(srcPath).toLowerCase() !== path.resolve(dest).toLowerCase()) {
      try {
        var existingBuf = fs.readFileSync(dest);
        var incomingBuf = fs.readFileSync(srcPath);
        if (existingBuf.length === incomingBuf.length && existingBuf.equals(incomingBuf)) {
          break;
        }
      } catch (eEq) { /* pick next name */ }
      idx++;
      dest = path.join(dir, base + '_' + idx + extWithDot);
    }
    return dest;
  }

  function importTemplate(srcPath) {
    if (!srcPath || !fs.existsSync(srcPath)) {
      return { ok: false, error: 'Selected .mogrt file was not found.' };
    }
    if (!/\.mogrt$/i.test(srcPath)) {
      return { ok: false, error: 'Please select a .mogrt file.' };
    }

    ensureDirs();

    var parsed;
    try {
      parsed = inspect(srcPath, { cacheVideo: false });
    } catch (e) {
      return { ok: false, error: 'Could not read .mogrt template: ' + e.message };
    }

    if (!parsed.textFields || !parsed.textFields.length) {
      return {
        ok: false,
        error: '"' + parsed.name + '" has no editable text fields. Please import a text MOGRT.'
      };
    }

    var dest = uniqueDestPath(CUSTOM_DIR, srcPath, '.mogrt');
    try {
      if (path.resolve(srcPath).toLowerCase() !== path.resolve(dest).toLowerCase()) {
        fs.copyFileSync(srcPath, dest);
      }
      var item = inspect(dest, { cacheVideo: true });
      return { ok: true, item: item };
    } catch (eCopy) {
      return { ok: false, error: 'Could not copy .mogrt into library: ' + eCopy.message };
    }
  }

  function importStyle(srcPath) {
    if (!srcPath || !fs.existsSync(srcPath)) {
      return { ok: false, error: 'Selected .prtextstyle file was not found.' };
    }
    if (!/\.prtextstyle$/i.test(srcPath)) {
      return { ok: false, error: 'Please select a .prtextstyle file.' };
    }

    ensureDirs();
    try {
      inspectStyle(srcPath);
    } catch (eInspect) {
      return { ok: false, error: 'Could not read .prtextstyle: ' + eInspect.message };
    }

    var dest = uniqueDestPath(STYLE_DIR, srcPath, '.prtextstyle');
    try {
      if (path.resolve(srcPath).toLowerCase() !== path.resolve(dest).toLowerCase()) {
        fs.copyFileSync(srcPath, dest);
        copyCompanionFromSource(srcPath, dest);
      }
      return { ok: true, item: inspectStyle(dest) };
    } catch (eCopy) {
      return { ok: false, error: 'Could not copy .prtextstyle into library: ' + eCopy.message };
    }
  }

  function importAsset(srcPath) {
    if (/\.prtextstyle$/i.test(srcPath || '')) return importStyle(srcPath);
    return importTemplate(srcPath);
  }

  function attachStylePreview(stylePath, imgPath) {
    if (!stylePath || !fs.existsSync(stylePath)) {
      return { ok: false, error: 'Style file was not found.' };
    }
    if (!imgPath || !fs.existsSync(imgPath)) {
      return { ok: false, error: 'Preview image was not found.' };
    }
    var ext = path.extname(imgPath).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp'].indexOf(ext) < 0) {
      return { ok: false, error: 'Please select a PNG, JPG, or WEBP preview image.' };
    }
    var target = path.resolve(stylePath);
    var styleRoot = path.resolve(STYLE_DIR);
    if (target.toLowerCase().indexOf(styleRoot.toLowerCase() + path.sep) !== 0) {
      return { ok: false, error: 'Previews can only be attached to imported styles.' };
    }
    try {
      var st = fs.statSync(imgPath);
      if (st.size > 5 * 1024 * 1024) {
        return { ok: false, error: 'Preview image must be under 5 MB.' };
      }
      clearCompanionPreviews(target);
      var dest = target.replace(/\.prtextstyle$/i, '') + '.preview' + ext;
      fs.copyFileSync(imgPath, dest);
      return { ok: true, item: inspectStyle(target) };
    } catch (eAttach) {
      return { ok: false, error: 'Could not attach preview image: ' + eAttach.message };
    }
  }

  function removeCustom(filePath) {
    if (!filePath) return { ok: false, error: 'No file path supplied.' };
    var target = path.resolve(filePath);
    var mogrtRoot = path.resolve(CUSTOM_DIR);
    var styleRoot = path.resolve(STYLE_DIR);
    var inMogrt = target.toLowerCase().indexOf(mogrtRoot.toLowerCase() + path.sep) === 0;
    var inStyle = target.toLowerCase().indexOf(styleRoot.toLowerCase() + path.sep) === 0;
    if (!inMogrt && !inStyle) {
      return { ok: false, error: 'Only custom imported MOGRTs or text styles can be removed.' };
    }
    try {
      if (fs.existsSync(target)) {
        if (inMogrt) {
          try {
            var stat = fs.statSync(target);
            var cachePath = path.join(CACHE_DIR, cacheKeyFor(target, stat) + '.mp4');
            if (fs.existsSync(cachePath)) fs.unlinkSync(cachePath);
          } catch (eCache) { /* non-fatal */ }
        } else if (inStyle) {
          clearCompanionPreviews(target);
        }
        fs.unlinkSync(target);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  return {
    ok: true,
    CUSTOM_DIR: CUSTOM_DIR,
    STYLE_DIR: STYLE_DIR,
    inspect: inspect,
    inspectStyle: inspectStyle,
    scanLibrary: scanLibrary,
    importTemplate: importTemplate,
    importStyle: importStyle,
    importAsset: importAsset,
    attachStylePreview: attachStylePreview,
    buildStyleMogrt: buildStyleMogrt,
    removeCustom: removeCustom
  };
})();
