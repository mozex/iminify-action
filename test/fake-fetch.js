/**
 * A fetch that answers from a list of handlers in order and records every request, so a test
 * states exactly the calls it expects.
 */
export function fakeFetch(handlers) {
    const calls = [];
    const queue = [...handlers];

    const fetch = async (url, options = {}) => {
        const call = { url: String(url), method: options.method ?? 'GET', headers: options.headers ?? {}, body: options.body };

        calls.push(call);

        const handler = queue.shift();

        if (!handler) {
            throw new Error(`Unexpected request: ${call.method} ${call.url}`);
        }

        return handler(call);
    };

    return { fetch, calls, pending: () => queue.length };
}

export const json = (status, payload, headers = {}) => new Response(null === payload ? null : JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
});

export const bytes = (content) => new Response(content, { status: 200, headers: { 'Content-Type': 'image/png' } });

export const noSleep = async () => {};
