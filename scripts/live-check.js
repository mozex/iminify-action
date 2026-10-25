// Sends test/fixtures/gradient.png through the real Iminify API with the action's own client,
// checks that a smaller PNG comes back, then deletes the image from the account. It reads the
// token from IMINIFY_TOKEN and skips when there is none, so the workflow passes on a fork.
import { readFileSync } from 'node:fs';
import { createIminify } from '../src/iminify.js';

const token = process.env.IMINIFY_TOKEN;

if (!token) {
    console.log('::notice::IMINIFY_TOKEN is not set, so the live check was skipped.');
    process.exit(0);
}

const iminify = createIminify({
    token,
    apiUrl: process.env.IMINIFY_API_URL || undefined,
    userAgent: 'iminify-action/live-check',
    log: console.log,
});
const original = readFileSync(new URL('../test/fixtures/gradient.png', import.meta.url));
const queued = await iminify.upload({ bytes: original, name: 'gradient.png', level: 'smart', keepMetadata: false });

try {
    const image = await iminify.waitFor(queued.id);

    if ('completed' !== image.status || !(image.saved_bytes > 0) || 'png' !== image.optimized.format) {
        throw new Error(`Expected a smaller PNG, got ${image.status} (${image.optimized?.format ?? 'no file'}).`);
    }

    const optimized = await iminify.download(image.optimized.download_url);

    if (optimized.length !== image.optimized.size || optimized.length >= original.length) {
        throw new Error(`The download is ${optimized.length} bytes, against ${image.optimized.size} reported and ${original.length} sent.`);
    }

    if (null !== image.alt_text) {
        throw new Error('The upload asked for alt text, which the action never does.');
    }

    console.log(`gradient.png: ${original.length} bytes to ${optimized.length} bytes.`);
} finally {
    await iminify.remove(queued.id);
}
