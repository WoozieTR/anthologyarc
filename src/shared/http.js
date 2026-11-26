/**
 * Common HTTP utilities for Nuvio Providers
 * Handles timeout signals, browser User-Agents, and safe fetches.
 */

var withDeadline = require('./http_deadline.js').withDeadline;

var DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    var controller = new AbortController();
    setTimeout(function () {
        controller.abort();
    }, ms);
    return controller.signal;
}

function headersWithUserAgent(headers) {
    if (typeof Headers === 'function' && headers instanceof Headers) {
        var copy = new Headers(headers);
        if (!copy.get('User-Agent')) copy.set('User-Agent', DEFAULT_UA);
        return copy;
    }
    if (Array.isArray(headers)) {
        var entries = headers.slice();
        if (!entries.some(function (entry) {
            return entry[0].toLowerCase() === 'user-agent' && entry[1];
        })) entries.push(['User-Agent', DEFAULT_UA]);
        return entries;
    }
    var fields = Object.assign({}, headers);
    if (!Object.keys(fields).some(function (key) {
        return key.toLowerCase() === 'user-agent' && fields[key];
    })) fields['User-Agent'] = DEFAULT_UA;
    return fields;
}

function fetchWithTimeout(url, options, ms) {
    var deadline = Date.now() + (ms || 10000);
    var fetchOptions = Object.assign({}, options);
    fetchOptions.headers = headersWithUserAgent(fetchOptions.headers);
    var signal = fetchOptions.signal;
    var controller = !signal && typeof AbortController === 'function' ? new AbortController() : null;
    if (controller) fetchOptions.signal = controller.signal;

    return withDeadline(deadline, signal, function (error) {
        if (controller) controller.abort(error);
    }, function () {
        return fetch(url, fetchOptions);
    });
}

module.exports = {
    DEFAULT_UA,
    timeoutSignal,
    fetchWithTimeout
};
