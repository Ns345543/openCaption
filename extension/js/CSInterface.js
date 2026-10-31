/*
 * Minimal stand-in for Adobe's CSInterface.js.
 * Only the methods this panel actually uses are implemented.
 */
function CSInterface() {}

CSInterface.prototype.evalScript = function (script, callback) {
  if (typeof window.__adobe_cep__ === 'undefined') {
    if (callback) callback('EvalScript error.');
    return;
  }
  if (callback) {
    window.__adobe_cep__.evalScript(script, callback);
  } else {
    return window.__adobe_cep__.evalScript(script);
  }
};

CSInterface.prototype.getSystemPath = function (pathType) {
  if (typeof window.__adobe_cep__ === 'undefined') return '';
  return window.__adobe_cep__.getSystemPath(pathType);
};

CSInterface.prototype.getExtensionID = function () {
  if (typeof window.__adobe_cep__ === 'undefined') return '';
  return window.__adobe_cep__.getExtensionId();
};

CSInterface.prototype.getHostEnvironment = function () {
  if (typeof window.__adobe_cep__ === 'undefined') return null;
  try {
    return JSON.parse(window.__adobe_cep__.getHostEnvironment());
  } catch (e) {
    return null;
  }
};

CSInterface.prototype.getOSInformation = function () {
  if (typeof window.__adobe_cep__ === 'undefined') return '';
  return window.__adobe_cep__.getOSInformation();
};

CSInterface.prototype.openURLInDefaultBrowser = function (url) {
  if (typeof window.cep !== 'undefined' && window.cep.util) {
    window.cep.util.openURLInDefaultBrowser(url);
  } else {
    window.open(url);
  }
};

/** Opens a native file dialog. Returns null when cancelled. */
CSInterface.prototype.showOpenDialog = function (title, initialPath, types) {
  if (typeof window.cep === 'undefined' || !window.cep.fs) return null;
  var res = window.cep.fs.showOpenDialog(false, false, title || 'Select file', initialPath || '', types || []);
  if (!res || res.err !== 0 || !res.data || !res.data.length) return null;
  return res.data[0];
};

window.SystemPath = {
  USER_DATA: 'userData',
  COMMON_FILES: 'commonFiles',
  MY_DOCUMENTS: 'myDocuments',
  APPLICATION: 'application',
  EXTENSION: 'extension',
  HOST_APPLICATION: 'hostApplication'
};
