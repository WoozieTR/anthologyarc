// Bound the wait even when the transport cannot cancel an in-flight operation.
function withDeadline(deadline, signal, cancel, operation) {
    var timer;
    var onAbort;
    var cancelled = false;
    var timeoutError = new Error('Request timeout');

    function cancelRequest(error) {
        if (cancelled) return;
        cancelled = true;
        try { cancel(error); } catch (e) {}
    }

    function stop(reject, error) {
        reject(error);
        cancelRequest(error);
    }

    function abortReason() {
        if (signal.reason !== undefined) return signal.reason;
        var error = new Error('The operation was aborted');
        error.name = 'AbortError';
        return error;
    }

    function checkDeadline() {
        if (Date.now() >= deadline) {
            cancelRequest(timeoutError);
            throw timeoutError;
        }
    }

    var limit = new Promise(function (_, reject) {
        if (signal && signal.aborted) {
            stop(reject, abortReason());
            return;
        }
        timer = setTimeout(function () { stop(reject, timeoutError); }, Math.max(0, deadline - Date.now()));
        if (canListen(signal)) {
            onAbort = function () { stop(reject, abortReason()); };
            signal.addEventListener('abort', onAbort);
        }
    });

    var request = Promise.resolve().then(function () {
        if (signal && signal.aborted) throw abortReason();
        checkDeadline();
        return operation();
    }).then(function (value) {
        // Synchronous body processing can delay the timer callback.
        checkDeadline();
        return value;
    });

    return Promise.race([limit, request]).finally(function () {
        if (timer !== undefined) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
    });
}

function canListen(signal) {
    return signal && typeof signal.addEventListener === 'function' &&
        typeof signal.removeEventListener === 'function';
}

module.exports = { withDeadline: withDeadline, canListen: canListen };
