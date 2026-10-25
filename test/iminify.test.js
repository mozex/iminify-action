import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIminify, DailyLimitError, IminifyError } from '../src/iminify.js';
import { bytes, fakeFetch, json } from './fake-fetch.js';

const API = 'https://www.iminify.com/api/v1';

const client = (handlers, sleeps = []) => {
    const fake = fakeFetch(handlers);
    const iminify = createIminify({ token: 'secret-token', userAgent: 'iminify-action/test', fetch: fake.fetch, sleep: async (ms) => sleeps.push(ms) });

    return { ...fake, iminify, sleeps };
};

test('an upload sends the file with the level, the metadata choice and alt text off', async () => {
    const { iminify, calls } = client([() => json(202, { data: { id: 'img-1', status: 'queued' } })]);

    const image = await iminify.upload({ bytes: Buffer.from('png-bytes'), name: 'hero.png', level: 'lossless', keepMetadata: true });

    assert.equal(image.id, 'img-1');
    assert.equal(calls[0].url, `${API}/images`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');
    assert.equal(calls[0].headers['User-Agent'], 'iminify-action/test');
    assert.equal(calls[0].body.get('level'), 'lossless');
    assert.equal(calls[0].body.get('keep_metadata'), 'true');
    assert.equal(calls[0].body.get('alt_text'), 'false');
    assert.equal(calls[0].body.get('file').name, 'hero.png');
    assert.equal(await calls[0].body.get('file').text(), 'png-bytes');
    assert.equal(calls[0].body.has('format'), false, 'no format, so the file keeps its own');
});

test('rate_limited is waited out for its Retry-After, then the same call goes again', async () => {
    const { iminify, calls, sleeps } = client([
        () => json(429, { message: 'Too many requests.', code: 'rate_limited' }, { 'Retry-After': '17' }),
        () => json(429, { message: 'Too many requests.', code: 'rate_limited' }, { 'Retry-After': '900' }),
        () => json(202, { data: { id: 'img-1' } }),
    ]);

    await iminify.upload({ bytes: Buffer.from('x'), name: 'a.png', level: 'smart', keepMetadata: false });

    assert.equal(calls.length, 3);
    assert.deepEqual(sleeps, [17_000, 120_000], 'a long Retry-After is capped at two minutes');
    assert.equal(calls[2].body.get('file').name, 'a.png', 'the form goes again whole');
});

test('the daily limit stops at once with the API\'s message', async () => {
    const { iminify, calls } = client([
        () => json(429, { message: "You've used your 40 images for today.", code: 'daily_limit_reached' }, { 'Retry-After': '3600' }),
    ]);

    await assert.rejects(iminify.upload({ bytes: Buffer.from('x'), name: 'a.png', level: 'smart' }), (error) => {
        assert.ok(error instanceof DailyLimitError);
        assert.equal(error.message, "You've used your 40 images for today.");
        assert.equal(error.retryAfter, 3600);

        return true;
    });
    assert.equal(calls.length, 1);
});

test('a server error or a network failure is tried again, a refusal is not', async () => {
    const { iminify, calls } = client([
        () => json(502, null),
        () => {
            throw new TypeError('fetch failed');
        },
        () => json(200, { data: { id: 'img-1', status: 'completed' } }),
    ]);

    assert.equal((await iminify.waitFor('img-1')).status, 'completed');
    assert.equal(calls.length, 3);

    const refused = client([() => json(422, { message: 'The file is too large.', code: 'validation_failed' })]);

    await assert.rejects(refused.iminify.upload({ bytes: Buffer.from('x'), name: 'a.png', level: 'smart' }), (error) => {
        assert.ok(error instanceof IminifyError);
        assert.equal(error.code, 'validation_failed');
        assert.equal(error.isFatal, false);

        return true;
    });
    assert.equal(refused.calls.length, 1);
});

test('a wrong token or an unverified account is fatal', async () => {
    for (const [status, code] of [[401, 'unauthenticated'], [403, 'email_not_verified'], [403, 'account_banned']]) {
        const { iminify } = client([() => json(status, { message: 'No.', code })]);

        await assert.rejects(iminify.waitFor('img-1'), (error) => error instanceof IminifyError && error.isFatal);
    }
});

test('waitFor polls until the image has finished', async () => {
    const { iminify, calls, sleeps } = client([
        () => json(200, { data: { id: 'img-1', status: 'queued' } }),
        () => json(200, { data: { id: 'img-1', status: 'optimizing' } }),
        () => json(200, { data: { id: 'img-1', status: 'already-optimized' } }),
    ]);

    assert.equal((await iminify.waitFor('img-1', { interval: 1500 })).status, 'already-optimized');
    assert.equal(calls[0].url, `${API}/images/img-1`);
    assert.deepEqual(sleeps, [1500, 1500]);
});

test('a download sends the token only to Iminify', async () => {
    const { iminify, calls } = client([() => bytes('optimized')]);

    assert.equal((await iminify.download(`${API}/images/img-1/download`)).toString(), 'optimized');
    assert.equal(calls[0].headers.Authorization, 'Bearer secret-token');

    assert.throws(() => iminify.download('https://example.com/steal'), /Refused to send the token to https:\/\/example\.com/);
    assert.equal(calls.length, 1);
});
