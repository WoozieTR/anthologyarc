// Models the relevant 0.1.39-alpha URL and Fetch bindings without native I/O.
function mockNuvioDesktop(t, routes) {
    const NativeURL = globalThis.URL;
    t.mock.method(globalThis, 'URL', function DesktopURL(input) {
        const parsed = new NativeURL(input);
        return {
            href: input,
            protocol: parsed.protocol,
            origin: parsed.origin,
            pathname: parsed.pathname,
            search: parsed.search,
            searchParams: new URLSearchParams(parsed.search)
        };
    });

    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        for (let hops = 0; hops < 5; hops++) {
            requests.push(url);
            const route = await routes.get(url);
            if (!route) throw new Error('Missing mock HTTP route for ' + url);

            const { status = 200, location, json } = route;
            if (location && status >= 300 && status < 400 && options.redirect !== 'manual') {
                url = location;
                continue;
            }
            const headers = new Headers({ 'Content-Type': 'application/json' });
            if (location) headers.set('Location', location);
            return { ok: status >= 200 && status < 300, status, url, headers, json };
        }
        throw new Error('Unbounded mock redirect');
    });
    return requests;
}

module.exports = { mockNuvioDesktop };
