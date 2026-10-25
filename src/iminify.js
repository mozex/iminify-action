export const API_URL = 'https://www.iminify.com/api/v1';

const FINISHED = ['completed', 'already-optimized', 'failed', 'cancelled'];

export class IminifyError extends Error {
    constructor(message, { status = null, code = null } = {}) {
        super(message);
        this.name = 'IminifyError';
        this.status = status;
        this.code = code;
    }

    /** A refusal that no other image in this run would escape: a wrong or deleted token, an unverified or banned account. */
    get isFatal() {
        return 401 === this.status || ['email_not_verified', 'account_banned'].includes(this.code);
    }
}

/** The account's images for today are used up; nothing more can be queued until the window opens. */
export class DailyLimitError extends IminifyError {
    constructor(message, retryAfter) {
        super(message, { status: 429, code: 'daily_limit_reached' });
        this.name = 'DailyLimitError';
        this.retryAfter = retryAfter;
    }
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A client for the Iminify API with the waits the API asks for: `rate_limited` is waited out for
 * the seconds in Retry-After, a network failure or a 5xx is tried again a few times, and the
 * daily limit is thrown as DailyLimitError so the caller can stop queueing.
 */
export function createIminify({
    token,
    apiUrl = API_URL,
    userAgent = 'iminify-action',
    fetch = globalThis.fetch,
    sleep = defaultSleep,
    log = () => {},
}) {
    const origin = new URL(apiUrl).origin;

    async function request(url, { method = 'GET', body, timeout = 60_000, binary = false } = {}) {
        let failures = 0;
        let waits = 0;

        for (;;) {
            let response;

            try {
                response = await fetch(url, {
                    method,
                    body,
                    headers: {
                        Accept: binary ? '*/*' : 'application/json',
                        Authorization: `Bearer ${token}`,
                        'User-Agent': userAgent,
                    },
                    signal: AbortSignal.timeout(timeout),
                });
            } catch (error) {
                if (++failures >= 3) {
                    throw new IminifyError(`Iminify could not be reached: ${error.message}`);
                }

                await sleep(2000 * 2 ** failures);
                continue;
            }

            if (204 === response.status) {
                return null;
            }

            if (response.ok) {
                return binary ? Buffer.from(await response.arrayBuffer()) : (await response.json()).data;
            }

            const payload = await response.json().catch(() => ({}));
            const message = payload.message ?? `Iminify answered ${response.status}.`;
            const retryAfter = Number.parseInt(response.headers.get('retry-after') ?? '', 10);

            if (429 === response.status && 'daily_limit_reached' === payload.code) {
                throw new DailyLimitError(message, Number.isNaN(retryAfter) ? null : retryAfter);
            }

            if (429 === response.status && ++waits <= 10) {
                const seconds = Math.min(Number.isNaN(retryAfter) ? 30 : Math.max(retryAfter, 1), 120);

                log(`Iminify asked to wait ${seconds} s before the next request.`);
                await sleep(seconds * 1000);
                continue;
            }

            if (response.status >= 500 && ++failures < 3) {
                await sleep(2000 * 2 ** failures);
                continue;
            }

            throw new IminifyError(message, { status: response.status, code: payload.code ?? null });
        }
    }

    return {
        /** Queues one file with alt text off: a CI run has no use for it, and it would spend the account's AI alt texts. */
        upload: ({ bytes, name, level, keepMetadata }) => {
            const form = new FormData();

            form.append('file', new Blob([bytes]), name);
            form.append('level', level);
            form.append('keep_metadata', keepMetadata ? 'true' : 'false');
            form.append('alt_text', 'false');

            return request(`${apiUrl}/images`, { method: 'POST', body: form, timeout: 300_000 });
        },

        async waitFor(id, { interval = 3000, timeout = 900_000 } = {}) {
            const deadline = Date.now() + timeout;

            for (;;) {
                const image = await request(`${apiUrl}/images/${id}`);

                if (FINISHED.includes(image.status)) {
                    return image;
                }

                if (Date.now() >= deadline) {
                    throw new IminifyError(`The image was still ${image.status} after ${timeout / 60_000} minutes.`);
                }

                await sleep(interval);
            }
        },

        /** The key goes only to Iminify's own address, whatever the answer named. */
        download: (url) => {
            if (new URL(url).origin !== origin) {
                throw new IminifyError(`Refused to send the token to ${new URL(url).origin}.`);
            }

            return request(url, { binary: true, timeout: 300_000 });
        },

        remove: (id) => request(`${apiUrl}/images/${id}`, { method: 'DELETE' }),
    };
}
