var deadlineHelpers = require('./http_deadline.js');
var withDeadline = deadlineHelpers.withDeadline;
var canListen = deadlineHelpers.canListen;

function nodeRequest(mod, url, options, deadline) {
    var req;
    function destroy() {
        if (req) req.destroy();
    }

    return withDeadline(deadline, options.signal, destroy, function () {
        return new Promise(function (resolve, reject) {
            var receivedResponse = false;
            function onPrematureClose() {
                var error = new Error(receivedResponse ? 'aborted' : 'socket hang up');
                error.code = 'ECONNRESET';
                reject(error);
            }
            req = mod.request({
                hostname: url.hostname,
                port: url.port || (url.protocol === 'http:' ? 80 : 443),
                path: url.pathname + url.search,
                method: options.method || 'GET',
                headers: options.headers || {}
            }, function (res) {
                receivedResponse = true;
                var data = '';
                var ended = false;
                res.on('error', reject);
                res.on('aborted', onPrematureClose);
                res.on('close', function () {
                    if (!ended) onPrematureClose();
                });
                res.on('data', function (chunk) { data += chunk; });
                res.on('end', function () {
                    ended = true;
                    if (!res.complete) {
                        onPrematureClose();
                        return;
                    }
                    resolve({
                        ok: res.statusCode >= 200 && res.statusCode < 300,
                        status: res.statusCode,
                        headers: res.headers,
                        text: async function () { return data; },
                        json: async function () { return JSON.parse(data); }
                    });
                });
            });
            req.on('error', reject);
            req.on('close', function () {
                if (!receivedResponse) onPrematureClose();
            });
            try {
                if (options.body) req.write(options.body);
                req.end();
            } catch (e) {
                reject(e);
                destroy();
            }
        });
    });
}

async function nativeRequest(url, options, deadline) {
    var signal = options.signal;
    var controller = typeof AbortController === 'function' && (!signal || canListen(signal))
        ? new AbortController() : null;
    var fetchOptions = controller ? Object.assign({}, options, { signal: controller.signal }) : options;
    function cancel(error) {
        if (controller) controller.abort(error);
    }

    var response = await withDeadline(deadline, signal, cancel, function () {
        return fetch(url, fetchOptions);
    });

    // Callers can inspect status without reading the body. Only arm a timer
    // while waiting, and use the original deadline if a body read is needed.
    if (!response) return response;
    var result = { ok: response.ok, status: response.status, headers: response.headers };
    ['text', 'json'].forEach(function (method) {
        if (typeof response[method] !== 'function') return;
        result[method] = function () {
            return withDeadline(deadline, signal, cancel, function () {
                return response[method]();
            });
        };
    });
    return result;
}

function safeFetch(url, options, ms) {
    options = options || {};
    var deadline = Date.now() + (ms || 10000);
    // Preserve the Node HTTP/1.1 transport and native Fetch fallback.
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        try {
            var https = require('https');
            var http = require('http');
            var parsed = new URL(url);
            return nodeRequest(parsed.protocol === 'http:' ? http : https, parsed, options, deadline);
        } catch (e) {}
    }
    return nativeRequest(url, options, deadline);
}

module.exports = { safeFetch: safeFetch };
