const assert = require("node:assert/strict");
const { test } = require("node:test");
const { checkStreams } = require("./test_playability");

const url = "https://api.media.invalid/samples/a?sig=a%2Bb";
const headers = { "User-Agent": "fixture", Authorization: "Bearer fixture-a" };

function mediaResponse(status = 200) {
  return new Response("#EXTM3U\n#EXT-X-TARGETDURATION:4\n", { status });
}

test("checks identical successful requests once per invocation and counts their result once", async (t) => {
  const otherUrl = "https://api.media.invalid/samples/a?sig=a+b";
  const requests = [];
  t.mock.method(globalThis, "fetch", async (target, options) => {
    requests.push([target, [...options.headers], options.method ?? "GET"]);
    return mediaResponse(target === url ? 206 : 200);
  });
  const sample = [
    { url, headers },
    { url, headers: [["authorization", "Bearer fixture-a"], ["user-agent", "fixture"]] },
    { url: otherUrl, headers },
    { url: "https://api.media.invalid/outside-sample", headers }
  ];

  const first = await checkStreams(sample);
  const firstCount = requests.length;
  const second = await checkStreams(sample);
  t.diagnostic(`Mock HTTP requests per invocation: ${firstCount}, ${requests.length - firstCount}`);

  const expectedHeaders = [
    ["authorization", "Bearer fixture-a"], ["range", "bytes=0-4095"], ["user-agent", "fixture"]
  ];
  const expectedRequests = [[url, expectedHeaders, "GET"], [otherUrl, expectedHeaders, "GET"]];
  assert.deepEqual(requests.slice(0, firstCount), expectedRequests);
  assert.deepEqual(requests.slice(firstCount), expectedRequests);
  assert.deepEqual(first, {
    media: 2, failed: 0, unverified: 0, checked: 2,
    status: "HTTP MEDIA FOUND", details: "HTTP 206 (Media manifest signature)"
  });
  assert.deepEqual(second, first);
});

test("keeps different header values at the same URL as separate requests and results", async (t) => {
  const requests = [];
  t.mock.method(globalThis, "fetch", async (target, options) => {
    requests.push([target, options.headers.get("authorization")]);
    return mediaResponse();
  });

  const result = await checkStreams([
    { url, headers },
    { url, headers: { ...headers, Authorization: "Bearer fixture-b" } },
    { url, headers }
  ]);
  t.diagnostic(`Mock HTTP requests with two authorization values: ${requests.length}`);

  assert.deepEqual(requests, [[url, "Bearer fixture-a"], [url, "Bearer fixture-b"]]);
  assert.equal(result.media, 2);
  assert.equal(result.checked, 2);
});

test("retries identical checks after HTTP failure or transport rejection", async (t) => {
  for (const failure of ["http", "transport"]) {
    await t.test(failure, async (t) => {
      let requests = 0;
      t.mock.method(globalThis, "fetch", async () => {
        if (++requests > 1) return mediaResponse();
        if (failure === "transport") throw new Error("fixture network error");
        return new Response(null, { status: 404 });
      });

      const result = await checkStreams(Array.from({ length: 3 }, () => ({ url, headers })));
      t.diagnostic(`Mock HTTP requests after ${failure} failure: ${requests}`);

      assert.equal(requests, 2);
      assert.deepEqual(result, {
        media: 1, failed: Number(failure === "http"), unverified: Number(failure === "transport"),
        checked: 2, status: "HTTP MEDIA FOUND", details: "HTTP 200 (Media manifest signature)"
      });
    });
  }
});
