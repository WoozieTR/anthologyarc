const manifest = require("../manifest.json");
const path = require("path");

const SAMPLE_BYTES = 4096;
const REQUEST_TIMEOUT_MS = 6000;

function inspectSample(sample) {
  if (!sample.length) return { outcome: "failed", reason: "Empty body" };

  const text = sample.toString("utf8").trimStart();
  if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b|\{|\[)/i.test(text)) {
    return { outcome: "failed", reason: "HTML or JSON body" };
  }
  if ((/^#EXTM3U[ \t]*\r?\n/.test(text) && /^#EXT-X-[A-Z0-9-]+[:\r\n]/m.test(text)) ||
      /^(?:<\?xml[^?]*\?>\s*)?<MPD(?=[\s>])/.test(text)) {
    return { outcome: "media", reason: "Media manifest signature" };
  }

  const bytes = sample.toString("hex", 0, 4);
  if ((sample.length >= 12 && sample.toString("latin1", 4, 8) === "ftyp") ||
      bytes === "1a45dfa3" || // WebM / Matroska
      bytes === "4f676753" || // Ogg
      bytes === "664c6143" || // FLAC
      (sample[0] === 0x47 && sample[188] === 0x47 && sample[376] === 0x47)) {
    return { outcome: "media", reason: "Binary media signature" };
  }
  return { outcome: "unverified", reason: "Unknown media signature" };
}

async function checkHttp(url, headers = {}) {
  const requestHeaders = new Headers(headers || {});
  requestHeaders.set("Range", `bytes=0-${SAMPLE_BYTES - 1}`);

  async function probe() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let response;
    let reader;
    try {
      response = await fetch(url, { headers: requestHeaders, signal: controller.signal });
      const { status } = response;
      const type = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      if (!response.ok) {
        const outcome = status === 404 || status === 410 ? "failed" : "unverified";
        return { outcome, status, reason: type };
      }
      if (!response.body || response.headers.get("content-length") === "0") {
        return { outcome: "failed", status, reason: "Empty body" };
      }
      if (type === "text/html" || type === "application/xhtml+xml" ||
          type.endsWith("/json") || type.endsWith("+json")) {
        return { outcome: "failed", status, reason: type };
      }

      reader = response.body.getReader();
      const sample = Buffer.alloc(SAMPLE_BYTES);
      let length = 0;
      while (length < sample.length) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value.subarray(0, sample.length - length);
        sample.set(chunk, length);
        length += chunk.length;
      }

      return { status, ...inspectSample(sample.subarray(0, length)) };
    } catch (err) {
      return { outcome: "unverified", status: controller.signal.aborted ? "TIMEOUT" : "ERR", reason: err.message };
    } finally {
      clearTimeout(timeout);
      // Stop reading even when the server ignores Range or the read fails.
      if (reader) {
        reader.cancel().catch(() => {});
        reader.releaseLock();
      } else {
        response?.body?.cancel().catch(() => {});
      }
      controller.abort();
    }
  }

  const first = await probe();
  if (first.outcome === "media" || requestHeaders.has("User-Agent")) return first;

  // Some CDNs require a browser user agent.
  requestHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  const second = await probe();
  if (second.outcome === "unverified" && first.outcome === "failed") return first;
  return second;
}

async function checkStreams(streams) {
  const counts = { media: 0, unverified: 0, failed: 0 };
  const details = {};
  const sample = streams.slice(0, 3);
  for (const stream of sample) {
    const check = stream.ytId
      ? { outcome: "unverified", reason: `YouTube (${stream.ytId})` }
      : stream.url
        ? await checkHttp(stream.url, stream.headers)
        : { outcome: "unverified", reason: "No URL to check" };
    counts[check.outcome]++;
    details[check.outcome] ??= check.status
      ? `HTTP ${check.status}${check.reason ? ` (${check.reason})` : ""}`
      : check.reason;
  }

  const outcome = counts.media ? "media" : counts.unverified ? "unverified" : "failed";
  const status = { media: "HTTP MEDIA FOUND", unverified: "UNVERIFIED", failed: "HTTP CHECK FAILED" };
  return { ...counts, checked: sample.length, status: status[outcome], details: details[outcome] };
}

async function main() {
  console.log("=== STREAM HTTP MEDIA CHECK ===");
  const testResults = [];

  for (const scraper of manifest.scrapers) {
    if (scraper.enabled === false) {
      testResults.push({ id: scraper.id, name: scraper.name, count: 0, status: "SKIPPED ⏭️", details: "Disabled in manifest" });
      console.log(`[${scraper.name}] ⏭️ SKIPPED (disabled)`);
      continue;
    }
    const fullPath = path.resolve(__dirname, "..", scraper.filename);
    try {
      const mod = require(fullPath);
      let streams = [];

      if (scraper.id === "sinewix") {
        streams = await mod.getStreams({ id: "603", type: "movie" });
      } else if (scraper.id === "animecix" || scraper.id === "anizm" || scraper.id === "animom" || scraper.id === "animeprax" || scraper.id === "seicode") {
        streams = await mod.getStreams("127532", "tv", 1, 1);
      } else if (scraper.id === "sonanime") {
        streams = await mod.getStreams("46260", "series", 1, 1);
      } else if (scraper.id === "diziwatch") {
        streams = await mod.getStreams("tt0409591", "series", 1, 1);
      } else if (scraper.id === "diziboxizle") {
        streams = await mod.getStreams("246864", "tv", 1, 1);
      } else if (scraper.id === "anizium") {
        streams = await mod.getStreams("31910", "series", 1, 1);
      } else if (scraper.id === "asyaanimeleri") {
        streams = await mod.getStreams("asyaanimeleri:ep:so-i-am-the-ancestor-of-the-demonic-path-1-80-bolum", "series", 1, 1);
      } else if (scraper.id === "yabancidizi") {
        streams = await mod.getStreams("5920", "tv", 1, 1);
      } else if (scraper.id === "dizibak" || scraper.id === "dizipod" || scraper.id === "ddizibox" || scraper.id === "diziyou" || scraper.id === "dizimom") {
        streams = await mod.getStreams("1396", "tv", 1, 1);
      } else if (scraper.id === "anthology_m3u") {
        streams = await mod.getStreams("165", "movie");
      } else if (scraper.id === "hdfilmcehennemi") {
        streams = await mod.getStreams("872585", "movie");
      } else if (scraper.id === "youtube_dizifilm") {
        streams = await mod.getStreams("34587", "tv", 1, 1);
      } else if (scraper.id === "anthology_diziler") {
        streams = await mod.getStreams({ id: "241020", type: "series", season: 1, episode: 46 });
      } else if (scraper.id === "puhutv" || scraper.id === "trdiziizle") {
        streams = await mod.getStreams({ id: "39176", type: "series", season: 1, episode: 1 });
      } else if (scraper.id === "ddizi" || scraper.id === "tvdiziler") {
        streams = await mod.getStreams("213194", "tv", 1, 1);
      } else if (scraper.id === "anthology_spor") {
        streams = await mod.getStreams({ id: "tv:beINSports1.tr", type: "tv" });
      } else if (scraper.id === "anthology_ulusal") {
        streams = await mod.getStreams({ id: "tv:TRT1.tr", type: "tv" });
      } else if (scraper.id === "anthology_haber") {
        streams = await mod.getStreams({ id: "tv:NTV.tr", type: "tv" });
      } else if (scraper.id === "anthology_belgesel_cocuk") {
        streams = await mod.getStreams({ id: "tv:TravelXP.tr", type: "tv" });
      } else if (scraper.id === "anthology_muzik") {
        streams = await mod.getStreams({ id: "tv:DreamTurk.tr", type: "tv" });
      } else if (scraper.id === "anthology_sinema") {
        streams = await mod.getStreams({ id: "tv:FX.tr", type: "tv" });
      } else if (scraper.id === "m3u.anthology.addon") {
        streams = await mod.getStreams({ id: "tv:ATV.tr", type: "tv" });
      } else if (scraper.supportedTypes && scraper.supportedTypes.includes("movie")) {
        streams = await mod.getStreams("603", "movie");
      } else if (scraper.supportedTypes && scraper.supportedTypes.includes("tv")) {
        streams = await mod.getStreams("1396", "tv", 1, 1);
      }

      const streamList = Array.isArray(streams) ? streams : (streams && streams.streams ? streams.streams : []);
      if (streamList.length === 0) {
        testResults.push({ id: scraper.id, name: scraper.name, count: 0, status: "NO_STREAMS ❌" });
        console.log(`[${scraper.name}] ❌ NO STREAMS`);
        continue;
      }

      const check = await checkStreams(streamList);
      testResults.push({ id: scraper.id, name: scraper.name, count: streamList.length, ...check });
      console.log(`[${scraper.name}] ${check.status} (HTTP media: ${check.media}/${check.checked}) | ${check.details}`);
    } catch (e) {
      testResults.push({ id: scraper.id, name: scraper.name, count: 0, status: "ERROR ❌", details: e.message });
      console.log(`[${scraper.name}] ❌ ERROR: ${e.message}`);
    }
  }

  console.log("\n==========================================");
  console.table(testResults);
  console.log("==========================================");

  const failures = testResults.filter(r => r.status.includes("NO_STREAMS") || r.status === "HTTP CHECK FAILED" || r.status.includes("ERROR"));
  const unverified = testResults.filter(r => r.status === "UNVERIFIED").length;
  console.log(`HTTP checks found media signatures only. Playback was not tested. Providers with unverified results: ${unverified}.`);
  if (failures.length > 0) {
    console.error(`\n❌ HTTP MEDIA CHECK: ${failures.length} provider(s) failed:`, failures.map(f => `${f.name} (${f.status})`).join(", "));
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { checkHttp, checkStreams };
