/**
 * Anthology Runtime Config Loader
 *
 * TEK KAYNAK DOSYASI: repo kökündeki config.json
 *   https://raw.githubusercontent.com/falsisdev/anthology/main/config.json
 *
 * Provider'lar derlenmiş varsayılan URL sabitleriyle çalışır; bu modül
 * config.json'u runtime'da çekerek (veya Node geliştirme ortamında yerel
 * dosyadan okuyarak) ilgili sabitleri üzerine yazar. config.json erişilemezse
 * derlenmiş varsayılanlar aynen çalışmaya devam eder (gerileme yok).
 *
 * Nuvio (QuickJS) uyumludur: fetch, Promise ve zamanlayıcılar kullanılır.
 * AbortController varsa istek iptal edilebilir.
 */

var CONFIG_URL = "https://raw.githubusercontent.com/falsisdev/anthology/main/config.json";
var CONFIG_TTL_MS = 10 * 60 * 1000;
var CONFIG_FAILURE_COOLDOWN_MS = 30 * 1000;
var CONFIG_FETCH_TIMEOUT_MS = 8 * 1000;

var _cfg = null;
var _cfgTime = null;
var _cfgInFlight = null;

function _cfgLocalRead() {
    // Node ortamı (dev/test/serve): repo kökündeki config.json'i doğrudan oku.
    // Nuvio'da require('fs'/'path') undefined döndüğü için sessizce null'a düşer.
    try {
        if (typeof require === 'undefined') return null;
        var fs = require('fs');
        var path = require('path');
        if (!fs || !path || typeof fs.existsSync !== 'function') return null;
        var dir = (typeof __dirname !== 'undefined') ? __dirname : '';
        var candidates = [
            path.resolve(dir, '..', 'config.json'),       // providers/<name>.js
            path.resolve(dir, '..', '..', 'config.json'), // src/<name>/index.js
            path.resolve(dir, 'config.json')
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (fs.existsSync(candidates[i])) {
                return JSON.parse(fs.readFileSync(candidates[i], 'utf8'));
            }
        }
    } catch (e) { return null; }
    return null;
}

function _cfgFetch() {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Accept': 'application/json'
        }
    };
    if (controller) options.signal = controller.signal;

    var deadline = Date.now() + CONFIG_FETCH_TIMEOUT_MS;
    var timeoutError = new Error('config.json timeout');
    var timer;
    var timeout = new Promise(function (_, reject) {
        timer = setTimeout(function () { reject(timeoutError); }, CONFIG_FETCH_TIMEOUT_MS);
    });
    var request = Promise.resolve().then(function () {
        return fetch(CONFIG_URL, options);
    }).then(function (res) {
        if (Date.now() >= deadline) throw timeoutError;
        if (!res || !res.ok) throw new Error('config.json ' + (res && res.status));
        if (typeof res.json === 'function') return res.json();
        return res.text().then(function (t) { return JSON.parse(t); });
    });

    // Cache only the result of the race, including the completed body parse.
    return Promise.race([request, timeout]).then(function (config) {
        // Synchronous parsing can delay the timer callback.
        if (Date.now() >= deadline) throw timeoutError;
        return config;
    }).catch(function (e) {
        if (e === timeoutError && controller) controller.abort();
        throw e;
    }).finally(function () {
        clearTimeout(timer);
    });
}

function loadConfig() {
    var now = Date.now();
    if (_cfg && (now - _cfgTime < CONFIG_TTL_MS)) return Promise.resolve(_cfg);
    if (_cfgInFlight) return _cfgInFlight;

    var local = _cfgLocalRead();
    if (local && typeof local === 'object') {
        _cfg = local;
        _cfgTime = Date.now();
        return Promise.resolve(_cfg);
    }

    if (!_cfg && _cfgTime !== null && (now - _cfgTime < CONFIG_FAILURE_COOLDOWN_MS)) {
        return Promise.resolve(null);
    }

    _cfgInFlight = Promise.resolve()
        .then(_cfgFetch)
        .then(function (c) {
            _cfg = (c && typeof c === 'object') ? c : {};
            _cfgTime = Date.now();
            return _cfg;
        })
        .catch(function () {
            // Çevresel blok / ağ hatası: varsayılanlar kalsın.
            _cfg = null;
            _cfgTime = Date.now();
            return _cfg;
        })
        .finally(function () {
            _cfgInFlight = null;
        });
    return _cfgInFlight;
}

function val(pathStr) {
    if (!_cfg || !pathStr) return undefined;
    var parts = String(pathStr).split('.');
    var cur = _cfg;
    for (var i = 0; i < parts.length; i++) {
        if (cur == null || typeof cur !== 'object') return undefined;
        cur = cur[parts[i]];
    }
    return cur;
}

function wrapAll(obj, pre) {
    var out = {};
    for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
            if (typeof obj[k] === 'function') {
                (function (name, fn) {
                    out[name] = function () {
                        var self = this;
                        var args = arguments;
                        var chain = pre ? pre() : Promise.resolve();
                        return chain.then(function () { return fn.apply(self, args); });
                    };
                })(k, obj[k]);
            } else {
                out[k] = obj[k];
            }
        }
    }
    return out;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = { loadConfig: loadConfig, val: val, wrapAll: wrapAll };
}