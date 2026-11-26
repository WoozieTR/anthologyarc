# Media API provider contract

Use `createMediaApiProvider` from `src/shared/media_api_provider.js` with an
authorized JSON API that documents this contract. The factory exposes
`getStreams(id, mediaType, season?, episode?)`.

## Configuration

| Option | Value |
| --- | --- |
| `name` | Provider display name |
| `apiOrigin` | Canonical HTTPS origin of the API, optionally with a trailing slash |
| `streamsPath` | Root-relative endpoint path with no query or fragment |
| `streamOrigins` | Nonempty list of canonical HTTPS playback origins, optionally with trailing slashes |
| `trustManualRedirects` | Defaults to `false`. Set to `true` only for a runtime verified to honor manual redirects but omit `Response.redirected`. |

Origins match by scheme, hostname and port. Approve each playback origin
explicitly, including the API origin if it serves playback URLs.

## Request and response

The adapter sends a single GET with `Accept: application/json` and
`credentials: 'omit'`. Query parameters are `id` and `type`. TMDB IDs are positive safe
integers or their canonical decimal strings. IMDb IDs are lowercase `tt`
followed by at least seven decimal digits, with at least one nonzero digit.
The request uses the string form of the ID.

Use `movie` for films and omit or pass `null` for season and episode. Use
`series` or its caller alias `tv` for episodes. The query uses `type=series`
with `season` (a nonnegative safe integer) and `episode` (a positive safe
integer).

Return HTTP 2xx with `Content-Type: application/json` and an object like this:

```json
{
  "id": "tt0123456",
  "type": "series",
  "season": 0,
  "episode": 3,
  "streams": [
    {
      "url": "https://media.alpha.invalid/episode.m3u8",
      "format": "hls",
      "quality": "1080p"
    }
  ]
}
```

The response must echo the string ID, canonical type, and numeric episode
coordinates exactly. Movie responses may omit the coordinates or use `null`.
Each stream needs an absolute HTTPS URL on an approved origin and a `format`
of `hls` or `mp4`. URLs may carry query parameters. Credentials and URL
fragments are rejected. `quality` is an optional nonblank string.

The result is a quality-sorted array of `{ name, title, url, format, isHls }`
objects with `quality` included when supplied. Other response fields are
ignored. Invalid inputs, HTTP failures, redirects, malformed JSON, or any
invalid stream yield an empty array. An empty `streams` array is also valid.

Origin validation covers the playback URLs returned by the API. The player
handles subsequent playback requests.

## Runtime requirements

Fetch must honor `redirect: 'manual'`. A successful response must report the
exact request URL and `redirected: false`. The adapter rejects 3xx responses,
opaque redirects, and changed or missing response URLs.

NuvioDesktop 0.1.39-alpha follows redirects for other Fetch modes, omits
`Response.redirected`, and leaves `URL.href` unchanged when search parameters
are mutated. The adapter serializes the query directly. Use
`trustManualRedirects: true` with those verified Desktop bindings to accept
an omitted redirect flag. Leave it disabled when the runtime's redirect
behavior is unknown. An omitted flag then yields an empty result.

A single 10-second JavaScript timer bounds the wait for Fetch and JSON
reading. An AbortController also requests cancellation when available.
NuvioDesktop 0.1.39-alpha ignores AbortSignal, so native HTTP may continue
after the adapter returns an empty result. Its eventual response is discarded.

Two synthetic configurations in `scripts/fixtures/media_api_providers.js`
exercise the same contract with mocked HTTP responses, including a fixture
for the Desktop bindings. Run the tests offline with
`node --test scripts/test_media_api_provider.test.js`.
