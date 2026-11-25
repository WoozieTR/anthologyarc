const assert = require("node:assert/strict");
const { test } = require("node:test");
const { checkHttp, checkStreams } = require("./test_playability");

const url = "https://media.invalid/sample";
const headers = { "USER-AGENT": "fixture" };

test("HTTP 200/206 cannot override rejected media in the stream summary", async (t) => {
  const fixtures = [
    new Response("<html>Sign in</html>", { headers: { "Content-Type": "text/html" } }),
    new Response('{"error":"Access denied"}', {
      status: 206,
      headers: { "Content-Range": "bytes 0-24/25", "Content-Type": "video/mp4" }
    }),
    new Response(null, { status: 200, headers: { "Content-Length": "0" } })
  ];
  const fetch = t.mock.method(globalThis, "fetch", async () => fixtures.shift());

  const result = await checkStreams(Array.from({ length: 3 }, () => ({ url, headers })));
  assert.equal(result.status, "HTTP CHECK FAILED");
  assert.equal(result.media, 0);
  assert.equal(result.failed, 3);
  assert.equal(fetch.mock.callCount(), 3);
  assert.ok(fetch.mock.calls.every(({ arguments: [, options] }) =>
    options.headers.get("Range") === "bytes=0-4095" && (options.method ?? "GET") === "GET"));
});

test("rejects typed JSON errors, mislabeled HTML and empty bodies without a length header", async (t) => {
  const fixtures = [
    new Response("{}", { headers: { "Content-Type": "application/problem+json" } }),
    new Response(" \n<!DOCTYPE html><title>Denied</title>", { headers: { "Content-Type": "video/mp4" } }),
    new Response(new Uint8Array(0), { headers: { "Content-Type": "video/mp4" } })
  ];
  t.mock.method(globalThis, "fetch", async () => fixtures.shift());

  for (let i = 0; i < 3; i++) assert.equal((await checkHttp(url, headers)).outcome, "failed");
});

test("recognizes media signatures across chunks regardless of MIME hints", async (t) => {
  const chunks = [Buffer.from([0, 0, 0, 24, 0x66]), Buffer.from("typisom")];
  const fixtures = [
    new Response(new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(chunks.shift());
        else controller.close();
      }
    }), { status: 206, headers: { "Content-Type": "application/octet-stream" } }),
    new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nseg.ts\n"),
    new Response('<?xml version="1.0"?>\n<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"></MPD>')
  ];
  t.mock.method(globalThis, "fetch", async () => fixtures.shift());

  const result = await checkStreams(Array.from({ length: 3 }, () => ({ url, headers })));
  assert.equal(result.status, "HTTP MEDIA FOUND");
  assert.equal(result.media, 3);
});

test("keeps opaque bytes, access errors and YouTube entries unverified", async (t) => {
  const fixtures = [
    new Response(new Uint8Array([1, 2, 3]), { status: 206, headers: { "Content-Type": "video/mp4" } }),
    new Response(null, { status: 403 })
  ];
  const fetch = t.mock.method(globalThis, "fetch", async () => fixtures.shift());

  const result = await checkStreams([{ url, headers }, { url, headers }, { ytId: "fixture" }, { url }]);
  assert.equal(result.status, "UNVERIFIED");
  assert.equal(result.unverified, 3);
  assert.equal(result.checked, 3);
  assert.equal(result.media, 0);
  assert.equal(result.failed, 0);
  assert.equal(fetch.mock.callCount(), 2);
});

test("retries with the fallback user agent and cancels both response bodies", async (t) => {
  const agents = [];
  const canceled = [];
  t.mock.method(globalThis, "fetch", async (_, options) => {
    const agent = options.headers.get("User-Agent");
    agents.push(agent);
    const body = new ReadableStream({
      start(controller) {
        const chunk = new Uint8Array(8192);
        chunk.set(Buffer.from("ftypisom"), 4);
        controller.enqueue(chunk);
      },
      cancel() {
        canceled.push(agent);
      }
    });
    return new Response(body, { status: agent ? 200 : 403 });
  });

  assert.equal((await checkHttp(url)).outcome, "media");
  assert.equal(agents[0], null);
  assert.match(agents[1], /^Mozilla\//);
  assert.deepEqual(canceled, agents);
});

test("clears request timers on fetch rejection and aborts a stalled body read", async (t) => {
  const pending = new Set();
  t.mock.method(globalThis, "setTimeout", (callback, ms) => {
    const timer = { callback, ms };
    pending.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearTimeout", (timer) => pending.delete(timer));

  let body;
  const fetch = t.mock.method(globalThis, "fetch", async (_, { signal }) => {
    body = new ReadableStream({
      start(controller) {
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      }
    });
    return new Response(body);
  });

  const check = checkHttp(url, headers);
  await Promise.resolve();
  assert.equal(pending.size, 1);
  const [timer] = pending;
  assert.equal(timer.ms, 6000);
  timer.callback();
  assert.equal((await check).status, "TIMEOUT");
  assert.equal(body.locked, false);
  assert.equal(pending.size, 0);

  fetch.mock.mockImplementation(async () => { throw new Error("fixture fetch failure"); });
  assert.equal((await checkHttp(url, headers)).outcome, "unverified");
  assert.equal(pending.size, 0);
});
