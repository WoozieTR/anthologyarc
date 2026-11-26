/**
 * Anthology Provider: tvdiziler
 * Built from src/tvdiziler/index.js
 * Build: v1.8.42 (anthology build system)
 */
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/shared/quality.js
var require_quality = __commonJS({
  "src/shared/quality.js"(exports2, module2) {
    function getQualityScore(s) {
      if (!s) return 0;
      if (!s.url) return 1;
      var q = ((s.quality || "") + " " + (s.title || "") + " " + (s.name || "")).toLowerCase();
      var score = 0;
      if (/\b(4k|2160p?|uhd)\b/.test(q)) score = 2160;
      else if (/\b(2k|1440p?|qhd)\b/.test(q)) score = 1440;
      else if (/\b(1080p?|fhd)\b/.test(q)) score = 1080;
      else if (/\b(720p?|hd)\b/.test(q)) score = 720;
      else if (/\b(540p?)\b/.test(q)) score = 540;
      else if (/\b(480p?|sd)\b/.test(q)) score = 480;
      else if (/\b(360p?)\b/.test(q)) score = 360;
      else if (/\b(240p?)\b/.test(q)) score = 240;
      if (score === 0 && s.title) {
        var text = s.title.toLowerCase();
        if (/\b(4k|2160p|uhd)\b/.test(text)) score = 2160;
        else if (/\b(2k|1440p|qhd)\b/.test(text)) score = 1440;
        else if (/\b(1080p|fhd)\b/.test(text)) score = 1080;
        else if (/\b(720p|hd)\b/.test(text)) score = 720;
        else if (/\b(480p|sd)\b/.test(text)) score = 480;
        else if (/\b(360p)\b/.test(text)) score = 360;
        else if (/\b(240p)\b/.test(text)) score = 240;
      }
      if (score === 0 && s.url) {
        var u = s.url.toLowerCase();
        if (/[\/_.-](2160p?|4k)[\/_.-]/.test(u)) score = 2160;
        else if (/[\/_.-](1440p?|2k)[\/_.-]/.test(u)) score = 1440;
        else if (/[\/_.-](1080p?|fhd)[\/_.-]/.test(u)) score = 1080;
        else if (/[\/_.-](720p?|hd)[\/_.-]/.test(u)) score = 720;
        else if (/[\/_.-](480p?|sd)[\/_.-]/.test(u)) score = 480;
        else if (/[\/_.-](360p?)[\/_.-]/.test(u)) score = 360;
      }
      var isDirectMp4 = s.format === "mp4" || s.type === "mp4" || !s.isHls && s.url && (s.url.endsWith(".mp4") || s.url.includes(".mp4?"));
      if (isDirectMp4 && score > 0) score += 1;
      return score;
    }
    function sortStreamsByQuality2(streams) {
      if (!Array.isArray(streams) || streams.length === 0) return streams;
      return streams.slice().sort(function(a, b) {
        return getQualityScore(b) - getQualityScore(a);
      });
    }
    module2.exports = {
      getQualityScore,
      sortStreamsByQuality: sortStreamsByQuality2
    };
  }
});

// src/shared/config.js
var require_config = __commonJS({
  "src/shared/config.js"(exports2, module2) {
    var CONFIG_URL = "https://raw.githubusercontent.com/falsisdev/anthology/main/config.json";
    var CONFIG_TTL_MS = 10 * 60 * 1e3;
    var CONFIG_FAILURE_COOLDOWN_MS = 30 * 1e3;
    var CONFIG_FETCH_TIMEOUT_MS = 8 * 1e3;
    var _cfg = null;
    var _cfgTime = null;
    var _cfgInFlight = null;
    function _cfgLocalRead() {
      try {
        if (typeof require === "undefined") return null;
        var fs = require("fs");
        var path = require("path");
        if (!fs || !path || typeof fs.existsSync !== "function") return null;
        var dir = typeof __dirname !== "undefined" ? __dirname : "";
        var candidates = [
          path.resolve(dir, "..", "config.json"),
          // providers/<name>.js
          path.resolve(dir, "..", "..", "config.json"),
          // src/<name>/index.js
          path.resolve(dir, "config.json")
        ];
        for (var i = 0; i < candidates.length; i++) {
          if (fs.existsSync(candidates[i])) {
            return JSON.parse(fs.readFileSync(candidates[i], "utf8"));
          }
        }
      } catch (e) {
        return null;
      }
      return null;
    }
    function _cfgFetch() {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var options = {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          "Accept": "application/json"
        }
      };
      if (controller) options.signal = controller.signal;
      var deadline = Date.now() + CONFIG_FETCH_TIMEOUT_MS;
      var timeoutError = new Error("config.json timeout");
      var timer;
      var timeout = new Promise(function(_, reject) {
        timer = setTimeout(function() {
          reject(timeoutError);
        }, CONFIG_FETCH_TIMEOUT_MS);
      });
      var request = Promise.resolve().then(function() {
        return fetch(CONFIG_URL, options);
      }).then(function(res) {
        if (Date.now() >= deadline) throw timeoutError;
        if (!res || !res.ok) throw new Error("config.json " + (res && res.status));
        if (typeof res.json === "function") return res.json();
        return res.text().then(function(t) {
          return JSON.parse(t);
        });
      });
      return Promise.race([request, timeout]).then(function(config) {
        if (Date.now() >= deadline) throw timeoutError;
        return config;
      }).catch(function(e) {
        if (e === timeoutError && controller) controller.abort();
        throw e;
      }).finally(function() {
        clearTimeout(timer);
      });
    }
    function loadConfig2() {
      var now = Date.now();
      if (_cfg && now - _cfgTime < CONFIG_TTL_MS) return Promise.resolve(_cfg);
      if (_cfgInFlight) return _cfgInFlight;
      var local = _cfgLocalRead();
      if (local && typeof local === "object") {
        _cfg = local;
        _cfgTime = Date.now();
        return Promise.resolve(_cfg);
      }
      if (!_cfg && _cfgTime !== null && now - _cfgTime < CONFIG_FAILURE_COOLDOWN_MS) {
        return Promise.resolve(null);
      }
      _cfgInFlight = Promise.resolve().then(_cfgFetch).then(function(c) {
        _cfg = c && typeof c === "object" ? c : {};
        _cfgTime = Date.now();
        return _cfg;
      }).catch(function() {
        _cfg = null;
        _cfgTime = Date.now();
        return _cfg;
      }).finally(function() {
        _cfgInFlight = null;
      });
      return _cfgInFlight;
    }
    function val2(pathStr) {
      if (!_cfg || !pathStr) return void 0;
      var parts = String(pathStr).split(".");
      var cur = _cfg;
      for (var i = 0; i < parts.length; i++) {
        if (cur == null || typeof cur !== "object") return void 0;
        cur = cur[parts[i]];
      }
      return cur;
    }
    function wrapAll2(obj, pre) {
      var out = {};
      for (var k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          if (typeof obj[k] === "function") {
            (function(name, fn) {
              out[name] = function() {
                var self = this;
                var args = arguments;
                var chain = pre ? pre() : Promise.resolve();
                return chain.then(function() {
                  return fn.apply(self, args);
                });
              };
            })(k, obj[k]);
          } else {
            out[k] = obj[k];
          }
        }
      }
      return out;
    }
    if (typeof module2 !== "undefined" && module2.exports) {
      module2.exports = { loadConfig: loadConfig2, val: val2, wrapAll: wrapAll2 };
    }
  }
});

// src/shared/http.js
var require_http = __commonJS({
  "src/shared/http.js"(exports2, module2) {
    var DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    function timeoutSignal2(ms) {
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        return AbortSignal.timeout(ms);
      }
      var controller = new AbortController();
      setTimeout(function() {
        controller.abort();
      }, ms);
      return controller.signal;
    }
    function fetchWithTimeout(url, options, ms) {
      ms = ms || 1e4;
      options = options || {};
      if (!options.signal) {
        options.signal = timeoutSignal2(ms);
      }
      if (!options.headers) {
        options.headers = {};
      }
      if (!options.headers["User-Agent"] && !options.headers["user-agent"]) {
        options.headers["User-Agent"] = DEFAULT_UA;
      }
      return fetch(url, options);
    }
    module2.exports = {
      DEFAULT_UA,
      timeoutSignal: timeoutSignal2,
      fetchWithTimeout
    };
  }
});

// src/shared/turkish_series.js
var require_turkish_series = __commonJS({
  "src/shared/turkish_series.js"(exports2, module2) {
    var TMDB_API_BASE = "https://api.themoviedb.org/3";
    function normalizeSeriesId2(raw) {
      var out = { id: "", kind: "unknown", season: 0, episode: 0 };
      if (typeof raw !== "string") return out;
      var val2 = raw.trim();
      var seg = val2.split(":");
      if (seg.length >= 3 && /^\d+$/.test(seg[seg.length - 1]) && /^\d+$/.test(seg[seg.length - 2])) {
        out.season = parseInt(seg[seg.length - 2], 10);
        out.episode = parseInt(seg[seg.length - 1], 10);
        seg = seg.slice(0, seg.length - 2);
        val2 = seg.join(":");
      } else if (seg.length === 2 && /^\d+$/.test(seg[1])) {
        out.episode = parseInt(seg[1], 10);
        val2 = seg[0];
      }
      var core = String(val2).trim();
      core = core.replace(/^(cinemata|cine|tmdb|tvdb|imdb|metadata|mal|id|movieid|seriesid|showid|slug|tv):/i, "");
      if (/^tt\d+$/i.test(core)) {
        out.id = core;
        out.kind = "imdb";
      } else if (/^\d+$/.test(core)) {
        out.id = core;
        out.kind = "tmdb";
      } else if (core) {
        out.id = core;
        out.kind = "title";
      }
      return out;
    }
    function asciiFold2(s) {
      s = String(s || "");
      try {
        if (typeof s.normalize === "function") s = s.normalize("NFD");
      } catch (e) {
      }
      s = s.replace(/[\u0300-\u036f]/g, "");
      s = s.toLowerCase();
      var map = { "\xE7": "c", "\u011F": "g", "\u0131": "i", "\u0130": "i", "\xF6": "o", "\u015F": "s", "\xFC": "u", "\xE2": "a", "\xEE": "i", "\xFB": "u" };
      var out = "";
      for (var i = 0; i < s.length; i++) {
        var ch = s.charAt(i);
        out += map[ch] !== void 0 ? map[ch] : ch;
      }
      return out;
    }
    function cleanTitle(t) {
      return asciiFold2(String(t || "")).replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
    }
    function tokensMatch(a, b) {
      var ta = cleanTitle(a).split(" ").filter(function(x) {
        return x.length > 1;
      });
      var tb = cleanTitle(b).split(" ").filter(function(x) {
        return x.length > 1;
      });
      if (!ta.length || !tb.length) return 0;
      var hits = 0;
      for (var i = 0; i < ta.length; i++) {
        for (var j = 0; j < tb.length; j++) {
          if (ta[i] === tb[j]) {
            hits++;
            break;
          }
        }
      }
      return hits / Math.max(ta.length, tb.length);
    }
    function tmdbJson(url) {
      return __async(this, null, function* () {
        try {
          var res = yield fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
              "Accept": "application/json"
            }
          });
          if (!res.ok) return null;
          return yield res.json();
        } catch (e) {
          return null;
        }
      });
    }
    function pickResults(data, preferTv) {
      if (!data) return null;
      if (preferTv) {
        if (data.tv_results && data.tv_results[0]) return { type: "tv", item: data.tv_results[0] };
        if (data.movie_results && data.movie_results[0]) return { type: "movie", item: data.movie_results[0] };
      } else {
        if (data.movie_results && data.movie_results[0]) return { type: "movie", item: data.movie_results[0] };
        if (data.tv_results && data.tv_results[0]) return { type: "tv", item: data.tv_results[0] };
      }
      return null;
    }
    function resolveSeriesInfo2(rawId, mediaType, apiKey) {
      return __async(this, null, function* () {
        var out = { title: "", origTitle: "", numericId: "", imdbId: "", aliases: [], seasons: [], kind: "unknown", type: "tv" };
        var key = apiKey || "500330721680edb6d5f7f12ba7cd9023";
        var norm = normalizeSeriesId2(rawId);
        if (!norm.id) return out;
        out.kind = norm.kind;
        var wantTv = mediaType === "tv" || mediaType === "series" || mediaType === "show" || norm.season > 0 || norm.kind !== "movie";
        if (mediaType === "movie") wantTv = false;
        var numericId = "";
        var name = "";
        var original = "";
        var foundType = wantTv ? "tv" : "movie";
        if (norm.kind === "imdb") {
          var fd = yield tmdbJson(TMDB_API_BASE + "/find/" + norm.id + "?api_key=" + key + "&external_source=imdb_id&language=tr-TR");
          var hit = pickResults(fd, wantTv);
          if (!hit && wantTv) {
            hit = pickResults(fd, false);
          }
          if (hit) {
            foundType = hit.type;
            numericId = String(hit.item.id);
            name = hit.item.name || hit.item.title || "";
            original = hit.item.original_name || hit.item.original_title || "";
          }
        } else if (norm.kind === "tmdb") {
          numericId = norm.id;
        } else {
          var sd = yield tmdbJson(TMDB_API_BASE + "/search/tv?query=" + encodeURIComponent(norm.id) + "&api_key=" + key + "&language=tr-TR&page=1");
          var results = sd && sd.results || [];
          var best = null;
          var bestScore = -1;
          var target = cleanTitle(norm.id);
          for (var i = 0; i < results.length; i++) {
            var r = results[i];
            var score = tokensMatch(r.name, norm.id);
            if (cleanTitle(r.name) === target) score = 1;
            if (score > bestScore) {
              bestScore = score;
              best = r;
            }
          }
          if (!best && results.length > 0) best = results[0];
          if (best) {
            numericId = String(best.id);
            name = best.name || "";
            original = best.original_name || "";
          }
        }
        if (!numericId) return out;
        out.numericId = numericId;
        out.type = foundType;
        var resource = TMDB_API_BASE + "/" + foundType + "/" + numericId;
        var [dres, ext, trs, alt] = yield Promise.all([
          tmdbJson(resource + "?api_key=" + key + "&language=tr-TR"),
          tmdbJson(resource + "/external_ids?api_key=" + key),
          tmdbJson(resource + "/translations?api_key=" + key),
          foundType === "movie" ? tmdbJson(resource + "/alternative_titles?api_key=" + key + "&country=TR") : null
        ]);
        if (dres) {
          name = dres.name || dres.title || name;
          original = dres.original_name || dres.original_title || original;
          if (foundType === "tv" && dres.seasons) out.seasons = dres.seasons;
        }
        out.title = name || norm.id;
        out.origTitle = original || name || norm.id;
        if (ext && ext.imdb_id) {
          out.imdbId = ext.imdb_id;
          out.aliases.push(ext.imdb_id);
        }
        if (trs && trs.translations) {
          for (var t = 0; t < trs.translations.length; t++) {
            var trName = trs.translations[t].data && trs.translations[t].data.name;
            if (trName && trName !== name && trName !== original) {
              out.aliases.push(trName);
            }
          }
        }
        if (alt && alt.titles) {
          for (var a = 0; a < alt.titles.length; a++) {
            var tn = alt.titles[a].title;
            if (tn && tn !== name && tn !== original && out.aliases.indexOf(tn) === -1) out.aliases.push(tn);
          }
        }
        var seen = {};
        seen[asciiFold2(name)] = true;
        seen[asciiFold2(original)] = true;
        var aliases = [];
        for (var k = 0; k < out.aliases.length; k++) {
          var fa = asciiFold2(out.aliases[k]);
          if (!fa || seen[fa]) continue;
          seen[fa] = true;
          aliases.push(out.aliases[k]);
        }
        if (aliases.length > 8) aliases.length = 8;
        out.aliases = aliases;
        return out;
      });
    }
    function seriesSearchTitles2(show) {
      var titles = [];
      function push(t) {
        t = String(t || "").trim();
        if (!t) return;
        for (var k = 0; k < titles.length; k++) {
          if (asciiFold2(titles[k]) === asciiFold2(t)) return;
          if (asciiFold2(titles[k]) === asciiFold2(t).replace(/[^a-z0-9]+/g, " ").trim() && asciiFold2(t).replace(/[^a-z0-9]+/g, " ").trim() === asciiFold2(titles[k]).replace(/[^a-z0-9]+/g, " ").trim()) return;
        }
        titles.push(t);
      }
      push(show && show.title);
      push(show && (show.orig || show.origTitle));
      push(show && show.name);
      var als = show && (show.alt || show.aliases);
      if (als) {
        for (var j = 0; j < als.length; j++) push(als[j]);
      }
      return titles;
    }
    module2.exports = {
      normalizeSeriesId: normalizeSeriesId2,
      resolveSeriesInfo: resolveSeriesInfo2,
      seriesSearchTitles: seriesSearchTitles2,
      asciiFold: asciiFold2
    };
  }
});

// src/tvdiziler/index.js
var { sortStreamsByQuality } = require_quality();
var { loadConfig, val, wrapAll } = require_config();
var { timeoutSignal } = require_http();
var { asciiFold, normalizeSeriesId, seriesSearchTitles, resolveSeriesInfo } = require_turkish_series();
var _cfgReady = null;
function cfgReady() {
  if (!_cfgReady) {
    _cfgReady = loadConfig().then(function() {
      var v = val("urls.series.tvdiziler.base");
      if (v) BASE_URL = String(v).replace(/\/+$/, "");
      if (HEADERS) HEADERS.Referer = BASE_URL + "/";
    });
  }
  return _cfgReady;
}
var BASE_URL = "https://tvdiziler.tv";
var TMDB_API_KEY = "500330721680edb6d5f7f12ba7cd9023";
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "tr-TR,tr;q=0.9,en;q=0.8",
  "Referer": BASE_URL + "/"
};
function diagnostic(stage, fields) {
  try {
    if (typeof console !== "undefined" && typeof console.log === "function") {
      console.log("[TvDiziler] " + stage + " " + JSON.stringify(fields));
    }
  } catch (e) {
  }
}
function safeFetch(url, options, ms) {
  options = options || {};
  ms = ms || 1e4;
  if (typeof process !== "undefined" && process.versions && process.versions.node) {
    try {
      var https = require("https");
      var http = require("http");
      var u = new URL(url);
      var mod = u.protocol === "http:" ? http : https;
      return new Promise(function(resolve, reject) {
        var req = mod.request({
          hostname: u.hostname,
          port: u.port || (u.protocol === "http:" ? 80 : 443),
          path: u.pathname + u.search,
          method: options.method || "GET",
          headers: options.headers || {}
        }, function(res) {
          var data = "";
          res.on("data", function(chunk) {
            data += chunk;
          });
          res.on("end", function() {
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              headers: res.headers,
              text: function() {
                return __async(this, null, function* () {
                  return data;
                });
              },
              json: function() {
                return __async(this, null, function* () {
                  return JSON.parse(data);
                });
              }
            });
          });
        });
        req.setTimeout(ms, function() {
          req.destroy(new Error("Request timeout"));
        });
        req.on("error", reject);
        if (options.body) req.write(options.body);
        req.end();
      });
    } catch (e) {
    }
  }
  if (!options.signal) {
    options.signal = timeoutSignal(ms);
  }
  return fetch(url, options);
}
function resolveYouTubeMp4(ytId) {
  return __async(this, null, function* () {
    try {
      var key = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
      var res = yield safeFetch("https://www.youtube.com/youtubei/v1/player?key=" + key, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "20.10.38"
            }
          },
          videoId: ytId
        })
      }, 3500);
      if (res.ok) {
        var data = yield res.json();
        if (data.streamingData) {
          if (data.streamingData.hlsManifestUrl) {
            return {
              url: data.streamingData.hlsManifestUrl,
              quality: "1080p",
              isHls: true,
              format: "hls",
              headers: {
                "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
              }
            };
          }
          if (data.streamingData.formats) {
            var formats = data.streamingData.formats.filter(function(f) {
              return f.url && (f.mimeType || "").includes("mp4");
            });
            if (formats.length > 0) {
              return {
                url: formats[0].url,
                quality: formats[0].qualityLabel || "360p",
                isHls: false,
                format: "mp4",
                headers: {
                  "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
                }
              };
            }
          }
        }
      }
    } catch (e) {
    }
    return null;
  });
}
function cleanSeriesTitle(title) {
  return String(title || "").replace(/\s*\(\d{4}\)\s*$/, "").trim();
}
function decodeSearchTitle(title) {
  return title.replace(/&(?:nbsp|#([0-9]+)|#x([0-9a-f]+));/gi, (entity, decimal, hex) => {
    if (decimal === void 0 && hex === void 0) return " ";
    const codePoint = decimal === void 0 ? parseInt(hex, 16) : Number(decimal);
    if (codePoint === 0 || codePoint > 1114111 || codePoint >= 55296 && codePoint <= 57343) {
      return entity;
    }
    return codePoint === 160 ? " " : String.fromCodePoint(codePoint);
  });
}
function seriesKey(title) {
  return asciiFold(title).replace(/[^a-z0-9]/g, "");
}
var TITLE_LOG_LIMIT = 96;
function isLoggableSeriesTitle(title) {
  return title.length <= 512 && /^[\p{L}\p{M}0-9 .,'’()!–—-]+$/u.test(title) && !/\.[a-z]|\b(?:bearer|authorization|cookie|password|token|api[ -]?key)\b/i.test(title) && !/[a-z0-9]{24}|\d(?:[ .()-]*\d){6}/i.test(title);
}
function logRejectedSeriesTitle(expected, expectedKey, candidate, decoded, decodedKey) {
  const safeExpected = expected !== null && isLoggableSeriesTitle(expected);
  const safeCandidate = candidate.length <= 512 && isLoggableSeriesTitle(decoded);
  diagnostic("series_title_mismatch", {
    expected_title: safeExpected ? expected.slice(0, TITLE_LOG_LIMIT) : null,
    candidate_title: safeCandidate ? candidate.slice(0, TITLE_LOG_LIMIT) : null,
    decoded_candidate_title: safeCandidate ? decoded.slice(0, TITLE_LOG_LIMIT) : null,
    expected_key: safeExpected ? expectedKey.slice(0, TITLE_LOG_LIMIT) : null,
    candidate_key: safeCandidate ? seriesKey(cleanSeriesTitle(candidate)).slice(0, TITLE_LOG_LIMIT) : null,
    decoded_candidate_key: safeCandidate ? decodedKey.slice(0, TITLE_LOG_LIMIT) : null
  });
}
function lastPathSegment(href) {
  return href.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop();
}
function showSlugKey(href) {
  return seriesKey(lastPathSegment(href).replace(/-(?:(?:\d+-)?son-bolum|izle)(?:-|$).*$/i, ""));
}
function parseEpisodeLink(href) {
  const slug = asciiFold(lastPathSegment(href));
  const match = slug.match(/^(.+?)-sezon-(\d+)-bolumu?-(\d+)(?:-|$)/) || slug.match(/^(.+?)(?:-(\d+)-sezon)?-(\d+)-bolumu?(?:-|$)/);
  if (!match) return null;
  return { series: seriesKey(match[1]), season: match[2] ? Number(match[2]) : null, episode: Number(match[3]) };
}
var SEASON_LABEL = "(?:([0-9]+)\\s*\\.?\\s*(?:sezon|season)|(?:sezon|season)\\s*[:#-]?\\s*([0-9]+))\\b";
var EPISODE_LABEL = "(?:([0-9]+)\\s*\\.?\\s*(?:bolumu?|episode|ep|b)|(?:bolumu?|episode|ep)\\s*[:#-]?\\s*([0-9]+)|b([0-9]+))\\b";
function episodeLabels(text) {
  const labels = new RegExp("\\b(?:" + SEASON_LABEL + "|" + EPISODE_LABEL + ")", "g");
  const seasons = [];
  const episodes = [];
  for (const match of text.matchAll(labels)) {
    if (match[1] || match[2]) seasons.push(Number(match[1] || match[2]));
    else episodes.push(Number(match[3] || match[4] || match[5]));
  }
  return { seasons, episodes };
}
function matchesEpisodeNumbers(labels, season, episode, cumEpisode) {
  if (labels.seasons.some((number) => number !== season)) return false;
  return labels.episodes.every((number) => number === cumEpisode || labels.seasons.length > 0 && number === episode);
}
function matchesYouTubeEpisode(videoTitle, title, season, episode, cumEpisode) {
  const text = asciiFold(videoTitle);
  const series = asciiFold(cleanSeriesTitle(title)).match(/[a-z0-9]+/g);
  if (!series) return false;
  const separator = "[^a-z0-9]*";
  const seriesLabel = series.join("[^a-z0-9]+");
  const episodeLabel = "(?:" + SEASON_LABEL + separator + ")?" + EPISODE_LABEL;
  const titleFirst = new RegExp("(?:^|[|\u2013\u2014])" + separator + seriesLabel + separator + episodeLabel);
  const episodeFirst = new RegExp("^" + separator + episodeLabel + separator + seriesLabel + "(?:" + separator + "$|\\s*[|\u2013\u2014-])");
  if (!titleFirst.test(text) && !episodeFirst.test(text)) return false;
  const labels = episodeLabels(text);
  return labels.episodes.length > 0 && matchesEpisodeNumbers(labels, season, episode, cumEpisode);
}
function cumulativeEpisode(seasons, season, episode) {
  const entries = Array.isArray(seasons) ? seasons : [];
  let total = episode;
  for (let s = 1; s < season; s++) {
    const previous = entries.find((entry) => entry && entry.season_number === s);
    if (!previous || !Number.isInteger(previous.episode_count) || previous.episode_count <= 0) return null;
    total += previous.episode_count;
  }
  return total;
}
function matchEpisode(episodes, keys, season, episode, cumEpisode) {
  let cumulativeMatch = null;
  const counts = { origin: "episode_list", accepted: 0, rejected: 0, invalid_link: 0, series_mismatch: 0, number_mismatch: 0 };
  for (const entry of episodes) {
    const identity = parseEpisodeLink(entry.href);
    if (!identity || !keys.includes(identity.series)) {
      counts.rejected++;
      if (identity) counts.series_mismatch++;
      else counts.invalid_link++;
      continue;
    }
    const labels = episodeLabels(asciiFold(entry.title));
    if (identity.season !== null) labels.seasons.push(identity.season);
    labels.episodes.push(identity.episode);
    if (entry.epNum) labels.episodes.push(entry.epNum);
    if (!matchesEpisodeNumbers(labels, season, episode, cumEpisode)) {
      counts.rejected++;
      counts.number_mismatch++;
      continue;
    }
    counts.accepted++;
    if (labels.seasons.length > 0) {
      diagnostic("episode_match", counts);
      return entry;
    }
    if (!cumulativeMatch) cumulativeMatch = entry;
  }
  diagnostic("episode_match", counts);
  return cumulativeMatch;
}
function getValidTmdbKey() {
  if (typeof TMDB_API_KEY === "string" && TMDB_API_KEY.length === 32 && !TMDB_API_KEY.startsWith("http")) {
    return TMDB_API_KEY;
  }
  return "500330721680edb6d5f7f12ba7cd9023";
}
function resolveOfficialYouTubeFallback(title, season, episode, cumEpisode) {
  return __async(this, null, function* () {
    const counts = { origin: "youtube_fallback", accepted: 0, rejected: 0, duration: 0, title_mismatch: 0 };
    try {
      var queries = [];
      if (season > 1) {
        queries.push(title + " " + season + ". Sezon " + episode + ". B\xF6l\xFCm");
        if (cumEpisode && cumEpisode !== episode) {
          queries.push(title + " " + cumEpisode + ". B\xF6l\xFCm");
        }
      }
      queries.push(title + " " + episode + ". B\xF6l\xFCm");
      var key = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
      for (var query of queries) {
        try {
          var res = yield safeFetch("https://www.youtube.com/results?search_query=" + encodeURIComponent(query), {
            headers: {
              "User-Agent": HEADERS["User-Agent"]
            },
            signal: timeoutSignal(3500)
          });
          if (!res.ok) continue;
          var html = yield res.text();
          var vidMatches = [...html.matchAll(/"videoId":"([a-zA-Z0-9_-]{11})"/g)].map(function(m) {
            return m[1];
          });
          var uniqueVids = [...new Set(vidMatches)].slice(0, 3);
          for (var ytId of uniqueVids) {
            try {
              var pRes = yield safeFetch("https://www.youtube.com/youtubei/v1/player?key=" + key, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
                },
                body: JSON.stringify({
                  context: { client: { clientName: "ANDROID", clientVersion: "20.10.38" } },
                  videoId: ytId
                }),
                signal: timeoutSignal(3e3)
              });
              if (!pRes.ok) continue;
              var data = yield pRes.json();
              var duration = parseInt(data.videoDetails && data.videoDetails.lengthSeconds || "0");
              var vTitle = data.videoDetails && data.videoDetails.title || "";
              if (duration >= 900 && matchesYouTubeEpisode(vTitle, title, season, episode, cumEpisode)) {
                var streams = [];
                if (data.streamingData && data.streamingData.hlsManifestUrl) {
                  streams.push({
                    name: "TvDiziler",
                    title: "\u231C TvDiziler \u231F | Resmi YouTube HLS (" + vTitle.slice(0, 50) + ")",
                    url: data.streamingData.hlsManifestUrl,
                    quality: "1080p",
                    provider: "tvdiziler",
                    format: "hls",
                    isHls: true,
                    headers: {
                      "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
                    }
                  });
                }
                if (data.streamingData && data.streamingData.formats) {
                  var formats = data.streamingData.formats.filter(function(f) {
                    return f.url && (f.mimeType || "").includes("mp4");
                  });
                  if (formats.length > 0) {
                    streams.push({
                      name: "TvDiziler",
                      title: "\u231C TvDiziler \u231F | Resmi YouTube MP4 (" + (formats[0].qualityLabel || "720p") + ")",
                      url: formats[0].url,
                      quality: formats[0].qualityLabel || "720p",
                      provider: "tvdiziler",
                      format: "mp4",
                      isHls: false,
                      headers: {
                        "User-Agent": "com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip"
                      }
                    });
                  }
                }
                streams.push({
                  name: "TvDiziler",
                  title: "\u231C TvDiziler \u231F | YouTube (" + vTitle.slice(0, 50) + ")",
                  ytId,
                  provider: "tvdiziler"
                });
                if (streams.length > 0) {
                  counts.accepted++;
                  diagnostic("episode_match", counts);
                  return streams;
                }
              } else {
                counts.rejected++;
                if (duration >= 900) counts.title_mismatch++;
                else counts.duration++;
              }
            } catch (e) {
            }
          }
        } catch (e) {
        }
      }
    } catch (e) {
    }
    diagnostic("episode_match", counts);
    return null;
  });
}
function resolveTmdbInfo(id, mediaType) {
  return __async(this, null, function* () {
    try {
      var info = yield resolveSeriesInfo(id, mediaType, getValidTmdbKey());
      return {
        title: info.title,
        origTitle: info.origTitle,
        numericId: info.numericId || null,
        seasons: info.seasons,
        aliases: info.aliases,
        kind: info.kind,
        type: info.type
      };
    } catch (e) {
      return { title: "", origTitle: "", numericId: null, seasons: [], aliases: [], kind: "unknown", type: "tv" };
    }
  });
}
function searchTvDiziler(query) {
  return __async(this, null, function* () {
    try {
      var searchUrl = BASE_URL + "/search?qr=" + encodeURIComponent(query);
      var res = yield safeFetch(searchUrl, {
        method: "POST",
        headers: {
          "User-Agent": HEADERS["User-Agent"],
          "X-Requested-With": "XMLHttpRequest",
          "Accept": "application/json, text/javascript, */*; q=0.01",
          "Referer": BASE_URL + "/"
        }
      });
      if (!res.ok) {
        res = yield safeFetch(searchUrl, {
          method: "GET",
          headers: {
            "User-Agent": HEADERS["User-Agent"],
            "X-Requested-With": "XMLHttpRequest",
            "Accept": "application/json, text/javascript, */*; q=0.01",
            "Referer": BASE_URL + "/"
          }
        });
      }
      if (!res.ok) return [];
      var json = yield res.json();
      if (!json || !json.data) return [];
      var items = [];
      var cardRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.tv\/)?(dizi\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
      var m;
      while ((m = cardRegex.exec(json.data)) !== null) {
        var slug = m[1];
        var inner = m[2];
        var titleMatch = inner.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
        var title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
        var imgMatch = inner.match(/(?:data-src|src)=["']([^"']+)["']/i);
        var poster = imgMatch ? imgMatch[1].startsWith("http") ? imgMatch[1] : BASE_URL + "/" + imgMatch[1].replace(/^\/+/, "") : "";
        if (slug && title) {
          items.push({ slug, title, poster });
        }
      }
      return items;
    } catch (e) {
      return [];
    }
  });
}
function getCatalog(args) {
  return __async(this, null, function* () {
    try {
      var query = args && args.search || args && args.extra && args.extra.search || args && args.query || "";
      if (query) {
        var results = yield searchTvDiziler(query);
        var metas = results.map(function(r) {
          return {
            id: "tvdiziler:show:" + r.slug,
            type: "tv",
            name: r.title,
            poster: r.poster || "https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png",
            background: r.poster || "https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png",
            genres: ["Yerli Dizi", "TvDiziler"],
            description: r.title + " - TvDiziler"
          };
        });
        return { metas };
      }
      var metas = [];
      try {
        var res = yield safeFetch(BASE_URL + "/dizi-izle", { headers: HEADERS }, 5e3);
        if (res.ok) {
          var html = yield res.text();
          var cardRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.[^/"']+\/)?(dizi\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
          var seen = /* @__PURE__ */ new Set();
          var m;
          while ((m = cardRegex.exec(html)) !== null) {
            var slug = m[1];
            if (!slug || seen.has(slug)) continue;
            seen.add(slug);
            var inner = m[2];
            var titleMatch = inner.match(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/i);
            var title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "";
            if (!title) continue;
            var imgMatch = inner.match(/(?:data-src|src)=["']([^"']+)["']/i);
            var poster = imgMatch ? imgMatch[1].startsWith("http") ? imgMatch[1] : BASE_URL + "/" + imgMatch[1].replace(/^\/+/, "") : "https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png";
            metas.push({
              id: "tvdiziler:show:" + slug,
              type: "tv",
              name: title,
              poster,
              background: poster,
              genres: ["Yerli Dizi", "TvDiziler"],
              description: title + " - TvDiziler"
            });
            if (metas.length >= 50) break;
          }
        }
      } catch (e) {
      }
      if (metas.length === 0) {
        try {
          var tmdbRes = yield safeFetch("https://api.themoviedb.org/3/discover/tv?api_key=" + getValidTmdbKey() + "&with_original_language=tr&sort_by=popularity.desc&language=tr-TR", {}, 6e3);
          if (tmdbRes.ok) {
            var tmdbData = yield tmdbRes.json();
            var results = tmdbData && tmdbData.results || [];
            for (var i = 0; i < results.length; i++) {
              var item = results[i];
              var name = item.name || item.original_name || "";
              if (!name) continue;
              var pUrl = item.poster_path ? "https://image.tmdb.org/t/p/w500" + item.poster_path : "https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png";
              metas.push({
                id: String(item.id),
                type: "tv",
                name,
                poster: pUrl,
                background: item.backdrop_path ? "https://image.tmdb.org/t/p/w780" + item.backdrop_path : pUrl,
                genres: ["Yerli Dizi", "TvDiziler"],
                description: item.overview || name + " - TvDiziler"
              });
            }
          }
        } catch (e) {
        }
      }
      return { metas };
    } catch (e) {
      return { metas: [] };
    }
  });
}
function getMeta(args) {
  return __async(this, null, function* () {
    try {
      var rawId = typeof args === "string" ? args : args && args.id ? args.id : "";
      if (!rawId) return { meta: null };
      if (rawId.startsWith("tvdiziler:ep:")) {
        var epSlug = rawId.replace("tvdiziler:ep:", "");
        var epUrl = BASE_URL + "/" + epSlug.replace(/^\/+/, "");
        var res = yield safeFetch(epUrl, { headers: HEADERS });
        if (!res.ok) return { meta: null };
        var html = yield res.text();
        var titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
        var title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "TvDiziler B\xF6l\xFCm";
        var ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        var poster = ogImg ? ogImg[1] : "https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png";
        var numMatch = title.match(/(\d+)\s*\.?\s*bölüm/i) || epSlug.match(/-(\d+)-bolum/i);
        var epNum = numMatch ? parseInt(numMatch[1]) : 1;
        return {
          meta: {
            id: rawId,
            type: "tv",
            name: title,
            poster,
            background: poster,
            description: title + " - TvDiziler",
            genres: ["Yerli Dizi", "TvDiziler"],
            videos: [{
              id: rawId,
              title,
              season: 1,
              episode: epNum
            }]
          }
        };
      }
      if (rawId.startsWith("tvdiziler:show:")) {
        var showSlug = rawId.replace("tvdiziler:show:", "");
        var showUrl = BASE_URL + "/" + showSlug.replace(/^\/+/, "");
        var res = yield safeFetch(showUrl, { headers: HEADERS });
        if (!res.ok) return { meta: null };
        var html = yield res.text();
        var titleMatch = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)<\/title>/i);
        var rawTitle = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, "").trim() : "TvDiziler";
        var title = rawTitle.replace(/\s*\(?\d{4}\)?\s*$/i, "").trim() || rawTitle;
        var ogImg = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        var poster = ogImg ? ogImg[1] : "https://raw.githubusercontent.com/falsisdev/anthology/main/assets/logo_1_transparent.png";
        var ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
        var description = ogDesc ? ogDesc[1] : title + " - TvDiziler Ar\u015Fivi";
        var epRegex = /<a data-navigo class="truncate" href="([^"]+)">Bölüm <data[^>]*>([^<]+)<\/data><\/a>\s*<h6[^>]*>\s*<a[^>]*itemprop="name">([^<]+)<\/a>/gi;
        var videos = [];
        var seen = /* @__PURE__ */ new Set();
        var em;
        while ((em = epRegex.exec(html)) !== null) {
          var href = em[1];
          if (seen.has(href)) continue;
          seen.add(href);
          var epNum = parseInt(em[2]) || 0;
          var epTitle = em[3].trim();
          var sMatch = epTitle.match(/(\d+)\s*\.?\s*sezon\s*(\d+)\s*\.?\s*bölüm/i);
          var season = 1;
          var episode = epNum;
          if (sMatch) {
            season = parseInt(sMatch[1]);
            episode = parseInt(sMatch[2]);
          }
          videos.push({
            id: "tvdiziler:ep:" + href,
            title: epTitle || epNum + ". B\xF6l\xFCm",
            season,
            episode
          });
        }
        if (videos.length === 0) {
          var fbRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.tv\/)?([a-zA-Z0-9_-]*bolum[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
          var fbm;
          while ((fbm = fbRegex.exec(html)) !== null) {
            var href = fbm[1];
            if (seen.has(href)) continue;
            seen.add(href);
            var epText = fbm[2].replace(/<[^>]+>/g, "").trim();
            var numMatch = epText.match(/(\d+)\s*\.?\s*bölüm/i) || href.match(/-(\d+)-bolum/i);
            var epNum = numMatch ? parseInt(numMatch[1]) : 1;
            videos.push({
              id: "tvdiziler:ep:" + href,
              title: epText || epNum + ". B\xF6l\xFCm",
              season: 1,
              episode: epNum
            });
          }
        }
        videos.sort(function(a, b) {
          return a.season - b.season || a.episode - b.episode;
        });
        return {
          meta: {
            id: rawId,
            type: "tv",
            name: title,
            poster,
            background: poster,
            description,
            genres: ["Yerli Dizi", "TvDiziler"],
            videos
          }
        };
      }
      return { meta: null };
    } catch (e) {
      return { meta: null };
    }
  });
}
function extractStreamsFromEpisodePage(epUrl) {
  return __async(this, null, function* () {
    try {
      var epRes = yield safeFetch(epUrl, {
        headers: {
          "User-Agent": HEADERS["User-Agent"],
          "Referer": BASE_URL + "/"
        }
      });
      if (!epRes.ok) return [];
      var html = yield epRes.text();
      var streams = [];
      var seenUrls = /* @__PURE__ */ new Set();
      var btnRegex = /<[a-zA-Z0-9]+[^>]+(?:data-hhs|data-hs)=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[a-zA-Z0-9]+>/gi;
      var bm;
      while ((bm = btnRegex.exec(html)) !== null) {
        var rawHhs = bm[1];
        var label = bm[2].replace(/<[^>]+>/g, "").trim() || "Tek Par\xE7a";
        var parts = rawHhs.split(",").map(function(s) {
          return s.trim();
        }).filter(Boolean);
        for (var item of parts) {
          if (item.startsWith("/vid/ply/") || item.includes("/vid/ply/")) {
            var plyUrl = item.startsWith("http") ? item : BASE_URL + (item.startsWith("/") ? "" : "/") + item;
            try {
              var plyRes = yield safeFetch(plyUrl, {
                headers: Object.assign({}, HEADERS, { Referer: epUrl })
              });
              if (plyRes.ok) {
                var plyHtml = yield plyRes.text();
                var srcMatch = plyHtml.match(/sources\s*:\s*\[\s*\{[^}]*file\s*:\s*["']([^"']+)["']/i) || plyHtml.match(/file\s*:\s*["']([^"']+)["']/i);
                if (srcMatch) {
                  var streamUrl = srcMatch[1].replace(/\\\/|\//g, function(m) {
                    return m === "\\/" ? "/" : m;
                  }).replace(/\\\//g, "/");
                  if (!seenUrls.has(streamUrl)) {
                    seenUrls.add(streamUrl);
                    var isHls = streamUrl.includes(".m3u8");
                    var quality = "1080p";
                    if (streamUrl.includes("720") || streamUrl.includes("1280x720")) quality = "720p";
                    else if (streamUrl.includes("480")) quality = "480p";
                    else if (streamUrl.includes("360")) quality = "360p";
                    var streamHeaders = {
                      "User-Agent": HEADERS["User-Agent"]
                    };
                    if (streamUrl.includes("twimg.com")) {
                      streamHeaders["Referer"] = "https://twitter.com/";
                      streamHeaders["Origin"] = "https://twitter.com";
                    } else if (streamUrl.includes("ciner.com.tr")) {
                      streamHeaders["Referer"] = "https://www.ciner.com.tr/";
                    } else {
                      streamHeaders["Referer"] = BASE_URL + "/";
                    }
                    streams.push({
                      name: "TvDiziler",
                      title: "\u231C TvDiziler \u231F | " + label + " (" + (isHls ? "HLS" : "MP4") + " " + quality + ")",
                      url: streamUrl,
                      quality,
                      format: isHls ? "hls" : "mp4",
                      isHls,
                      provider: "tvdiziler",
                      headers: streamHeaders,
                      behaviorHints: {
                        notWebReady: true,
                        proxyHeaders: {
                          request: streamHeaders
                        }
                      }
                    });
                  }
                }
              }
            } catch (e) {
            }
          }
          var ytMatch = item.match(/(?:git\.php\?id=|v=|youtu\.be\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
          if (ytMatch) {
            var ytId = ytMatch[1];
            if (!seenUrls.has(ytId)) {
              seenUrls.add(ytId);
              var ytStream = yield resolveYouTubeMp4(ytId);
              if (ytStream && ytStream.url) {
                var isHls = !!ytStream.isHls;
                var fmt = ytStream.format || (isHls ? "hls" : "mp4");
                var qualLabel = isHls ? "HLS " + ytStream.quality : "MP4 " + ytStream.quality;
                streams.push({
                  name: "TvDiziler",
                  title: "\u231C TvDiziler \u231F | " + (label || "YouTube") + " (" + qualLabel + ")",
                  url: ytStream.url,
                  quality: ytStream.quality,
                  format: fmt,
                  isHls,
                  provider: "tvdiziler",
                  headers: ytStream.headers,
                  behaviorHints: {
                    notWebReady: true,
                    proxyHeaders: {
                      request: ytStream.headers
                    }
                  }
                });
              }
              streams.push({
                name: "TvDiziler",
                title: "\u231C TvDiziler \u231F | YouTube (" + (label || "Resmi") + ")",
                ytId,
                provider: "tvdiziler"
              });
            }
          }
        }
      }
      var ifrRegex = /<iframe[^>]+src=["']([^"']+)["']/gi;
      var im;
      while ((im = ifrRegex.exec(html)) !== null) {
        var src = im[1];
        if (src.startsWith("//")) src = "https:" + src;
        var ytMatch = src.match(/(?:embed\/|v=)([a-zA-Z0-9_-]{11})/);
        if (ytMatch && !seenUrls.has(ytMatch[1])) {
          var ifrYtId = ytMatch[1];
          seenUrls.add(ifrYtId);
          var ifrYtStream = yield resolveYouTubeMp4(ifrYtId);
          if (ifrYtStream && ifrYtStream.url) {
            var ifrIsHls = !!ifrYtStream.isHls;
            var ifrFmt = ifrYtStream.format || (ifrIsHls ? "hls" : "mp4");
            var ifrQualLabel = ifrIsHls ? "HLS " + ifrYtStream.quality : "MP4 " + ifrYtStream.quality;
            streams.push({
              name: "TvDiziler",
              title: "\u231C TvDiziler \u231F | YouTube (" + ifrQualLabel + ")",
              url: ifrYtStream.url,
              quality: ifrYtStream.quality,
              format: ifrFmt,
              isHls: ifrIsHls,
              provider: "tvdiziler",
              headers: ifrYtStream.headers,
              behaviorHints: {
                notWebReady: true,
                proxyHeaders: {
                  request: ifrYtStream.headers
                }
              }
            });
          }
          streams.push({
            name: "TvDiziler",
            title: "\u231C TvDiziler \u231F | YouTube (Resmi)",
            ytId: ifrYtId,
            provider: "tvdiziler"
          });
        }
      }
      return streams;
    } catch (e) {
      return [];
    }
  });
}
function getStreams(tmdbIdOrArgs, mediaType, seasonNum, episodeNum) {
  return __async(this, null, function* () {
    try {
      if (typeof tmdbIdOrArgs === "object" && tmdbIdOrArgs && tmdbIdOrArgs.id) {
        return getStreams(tmdbIdOrArgs.id, mediaType || tmdbIdOrArgs.type, seasonNum || tmdbIdOrArgs.season, episodeNum || tmdbIdOrArgs.episode);
      }
      if (typeof tmdbIdOrArgs === "string" && tmdbIdOrArgs.startsWith("tvdiziler:ep:")) {
        yield cfgReady();
        var epSlug = tmdbIdOrArgs.replace("tvdiziler:ep:", "");
        var epUrl = BASE_URL + "/" + epSlug.replace(/^\/+/, "");
        var directStreams = yield extractStreamsFromEpisodePage(epUrl);
        if (directStreams.length > 0) {
          diagnostic("result", { origin: "direct_episode", count: directStreams.length });
        } else {
          diagnostic("empty_result", { reason: "direct_episode_empty" });
        }
        return directStreams;
      }
      var id = tmdbIdOrArgs;
      var season = parseInt(seasonNum) || 1;
      var episode = parseInt(episodeNum) || 1;
      var nrm = normalizeSeriesId(id);
      if (nrm.season > 0) season = nrm.season;
      if (nrm.episode > 0) episode = nrm.episode;
      if (nrm.kind === "title") id = nrm.id;
      else if (nrm.id) id = nrm.id;
      else if (typeof id === "string" && id.includes(":")) {
        var parts = id.split(":");
        id = parts[0];
        if (parts.length >= 3) {
          season = parseInt(parts[1]) || season;
          episode = parseInt(parts[2]) || episode;
        }
      }
      var [info] = yield Promise.all([resolveTmdbInfo(id, mediaType), cfgReady()]);
      var searchTitles = seriesSearchTitles(info);
      if (nrm.kind === "title" && searchTitles.length === 0) searchTitles.push(String(id || "").trim());
      if (searchTitles.length === 0) {
        diagnostic("empty_result", { reason: "missing_titles" });
        return [];
      }
      var cumEpisode = cumulativeEpisode(info.seasons, season, episode);
      for (var title of searchTitles) {
        var cleanQuery = cleanSeriesTitle(title);
        var cleanTarget = seriesKey(cleanQuery);
        if (!cleanTarget) continue;
        var results = yield searchTvDiziler(cleanQuery);
        var titleMismatch = 0;
        var suffixMatch;
        var matchedShow = results.find((result) => {
          const decoded = decodeSearchTitle(result.title);
          const candidateTitle = cleanSeriesTitle(decoded);
          const decodedKey = seriesKey(candidateTitle);
          if (decodedKey === cleanTarget) return true;
          const watchSuffix = candidateTitle.match(/\s+[iİ]zle$/i);
          const candidateKey = watchSuffix ? seriesKey(cleanSeriesTitle(candidateTitle.slice(0, watchSuffix.index))) : decodedKey;
          if (candidateKey === cleanTarget) {
            if (!suffixMatch) suffixMatch = result;
            return false;
          }
          titleMismatch++;
          const expected = nrm.kind === "title" && cleanQuery === cleanSeriesTitle(nrm.id) ? null : cleanQuery;
          logRejectedSeriesTitle(expected, cleanTarget, result.title, decoded, candidateKey);
          return false;
        }) || suffixMatch;
        var missingSlug = matchedShow && !matchedShow.slug ? 1 : 0;
        diagnostic("series_match", {
          accepted: matchedShow && matchedShow.slug ? 1 : 0,
          rejected: titleMismatch + missingSlug,
          title_mismatch: titleMismatch,
          missing_slug: missingSlug
        });
        if (!matchedShow || !matchedShow.slug) continue;
        var seriesKeys = [cleanTarget, showSlugKey(matchedShow.slug)];
        var showUrl = BASE_URL + "/" + matchedShow.slug.replace(/^\/+/, "");
        var sRes = yield safeFetch(showUrl, { headers: HEADERS });
        if (!sRes.ok) continue;
        var sHtml = yield sRes.text();
        var epRegex = /<a data-navigo class="truncate" href="([^"]+)">Bölüm <data[^>]*>([^<]+)<\/data><\/a>\s*<h6[^>]*>\s*<a[^>]*itemprop="name">([^<]+)<\/a>/gi;
        var episodes = [];
        var em;
        while ((em = epRegex.exec(sHtml)) !== null) {
          episodes.push({
            href: em[1],
            epNum: Number(em[2]) || 0,
            title: em[3].trim()
          });
        }
        if (episodes.length === 0) {
          var fbRegex = /<a[^>]+href=["'](?:https:\/\/tvdiziler\.tv\/)?(\/?[a-zA-Z0-9_-]*bolum[^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
          var fbm;
          while ((fbm = fbRegex.exec(sHtml)) !== null) {
            episodes.push({
              href: fbm[1],
              title: fbm[2].replace(/<[^>]+>/g, " ").trim()
            });
          }
        }
        var targetEp = matchEpisode(episodes, seriesKeys, season, episode, cumEpisode);
        if (targetEp) {
          var epUrl = BASE_URL + "/" + targetEp.href.replace(/^\/+/, "");
          var streams = yield extractStreamsFromEpisodePage(epUrl);
          if (streams.length > 0) {
            diagnostic("result", { origin: "episode_list", count: streams.length });
            return streams;
          }
        }
      }
      if (searchTitles.length > 0) {
        var mainTitle = searchTitles[0];
        var ytStreams = yield resolveOfficialYouTubeFallback(mainTitle, season, episode, cumEpisode);
        if (ytStreams && ytStreams.length > 0) {
          diagnostic("result", { origin: "youtube_fallback", count: ytStreams.length });
          return ytStreams;
        }
      }
      diagnostic("empty_result", { reason: "no_streams" });
      return [];
    } catch (e) {
      diagnostic("empty_result", { reason: "error" });
      return [];
    }
  });
}
if (typeof getStreams === "function") {
  _origGetStreams = getStreams;
  getStreams = function() {
    return __async(this, arguments, function* () {
      var res = yield _origGetStreams.apply(this, arguments);
      return sortStreamsByQuality(res);
    });
  };
}
var _origGetStreams;
if (typeof module !== "undefined" && module.exports) {
  module.exports = wrapAll({ getMeta, getCatalog }, cfgReady);
  module.exports.getStreams = getStreams;
}
if (typeof globalThis !== "undefined") {
  globalThis.getStreams = getStreams;
  globalThis.getMeta = getMeta;
  globalThis.getCatalog = getCatalog;
}

if (typeof globalThis !== 'undefined' && typeof module !== 'undefined' && module.exports) {
    if (module.exports.getStreams) globalThis.getStreams = module.exports.getStreams;
    if (module.exports.getCatalog) globalThis.getCatalog = module.exports.getCatalog;
    if (module.exports.getMeta) globalThis.getMeta = module.exports.getMeta;
    if (module.exports.getSubtitles) globalThis.getSubtitles = module.exports.getSubtitles;
}

