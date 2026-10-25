import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../src/run.js';
import { DailyLimitError, IminifyError } from '../src/iminify.js';
import { GitHubError } from '../src/github.js';
import { blobSha } from '../src/files.js';
import { MARKER, commitMessage, knownBlobs } from '../src/report.js';

const HEAD = '1111111111111111111111111111111111111111';

const env = (inputs = {}, extra = {}) => ({
    GITHUB_EVENT_NAME: 'pull_request',
    GITHUB_REPOSITORY: 'acme/site',
    GITHUB_ACTOR: 'octocat',
    'INPUT_TOKEN': 'imt-secret',
    'INPUT_GITHUB-TOKEN': 'gh-token',
    'INPUT_LEVEL': 'smart',
    'INPUT_KEEP-METADATA': 'false',
    'INPUT_COMMIT': 'true',
    'INPUT_COMMENT': 'true',
    'INPUT_IGNORE': '',
    ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
    ...extra,
});

const event = (overrides = {}) => ({
    pull_request: { number: 7, user: { login: 'octocat' }, head: { sha: HEAD, ref: 'feature', repo: { full_name: 'acme/site' } }, ...overrides },
});

const kit = () => {
    const log = { info: [], notice: [], warning: [], mask: [], outputs: {}, summary: '' };

    return {
        log,
        info: (message) => log.info.push(message),
        notice: (message) => log.notice.push(message),
        warning: (message) => log.warning.push(message),
        error: () => {},
        mask: (secret) => log.mask.push(secret),
        setOutput: (name, value) => (log.outputs[name] = value),
        summary: (markdown) => (log.summary += markdown),
    };
};

/** The original bytes in the repository, and what Iminify makes of each. */
const BLOBS = {
    a1: Buffer.alloc(4000, 'a'),
    b2: Buffer.alloc(3000, 'b'),
    c3: Buffer.alloc(2000, 'c'),
    d4: Buffer.alloc(1000, 'd'),
};
const SMALLER = { 'hero.png': Buffer.alloc(1000, 'A'), 'photo.jpg': Buffer.alloc(2000, 'B'), 'logo.webp': Buffer.alloc(500, 'C') };

const fakeGitHub = ({ files, commits = [], comments = [], head = HEAD, commitError = null }) => {
    const calls = { blobs: [], created: [], commits: [], comments: [] };
    const github = {
        pull: async () => ({ head: { sha: head, ref: 'feature' } }),
        pullFiles: async () => files,
        pullCommits: async () => commits,
        comments: async () => comments,
        blob: async (sha) => BLOBS[sha],
        createBlob: async (bytes) => {
            calls.created.push(bytes);

            return blobSha(bytes);
        },
        commitTree: async (commit) => {
            calls.commits.push(commit);

            if (commitError) {
                throw commitError;
            }

            return '2222222222222222222222222222222222222222';
        },
        createComment: async (number, body) => calls.comments.push({ create: number, body }),
        updateComment: async (id, body) => calls.comments.push({ update: id, body }),
    };

    return { github, calls };
};

/** Iminify as a script: per file name, what the upload throws or how the image ends ("completed as webp" for another format). */
const fakeIminify = (outcomes) => {
    const calls = { uploads: [], tokens: [] };
    const images = {};

    return {
        calls,
        make: ({ token }) => {
            calls.tokens.push(token);

            return {
                upload: async ({ bytes, name, level, keepMetadata }) => {
                    calls.uploads.push({ name, level, keepMetadata, size: bytes.length });

                    const outcome = outcomes[name];

                    if (outcome instanceof Error) {
                        throw outcome;
                    }

                    const [status, format] = outcome.split(' as ');

                    images[name] = { id: name, status, format: format ?? name.split('.').pop(), original: { size: bytes.length } };

                    return { id: name, status: 'queued' };
                },
                waitFor: async (id) => {
                    const image = images[id];
                    const smaller = SMALLER[id];

                    if ('completed' === image.status && smaller) {
                        return { ...image, saved_bytes: image.original.size - smaller.length, optimized: { format: image.format, download_url: `https://www.iminify.com/api/v1/images/${id}/download` } };
                    }

                    return { ...image, saved_bytes: 'completed' === image.status ? 0 : null, optimized: null };
                },
                download: async (url) => SMALLER[url.split('/').at(-2)],
            };
        },
    };
};

const FILES = [
    { filename: 'public/hero.png', status: 'added', sha: 'a1' },
    { filename: 'public/photo.jpg', status: 'modified', sha: 'b2' },
    { filename: 'public/logo.webp', status: 'added', sha: 'c3' },
    { filename: 'README.md', status: 'modified', sha: 'zz' },
];

test('it compresses the new images, commits the smaller ones and reports the savings', async () => {
    const { github, calls } = fakeGitHub({ files: FILES });
    const iminify = fakeIminify({ 'hero.png': 'completed', 'photo.jpg': 'completed', 'logo.webp': 'already-optimized' });
    const k = kit();

    const result = await run({ env: env({ level: 'ultra', 'keep-metadata': 'true' }), event: event(), kit: k, makeGitHub: () => github, makeIminify: iminify.make });

    assert.deepEqual(iminify.calls.tokens, ['imt-secret']);
    assert.deepEqual(k.log.mask, ['imt-secret']);
    assert.deepEqual(iminify.calls.uploads, [
        { name: 'hero.png', level: 'ultra', keepMetadata: true, size: 4000 },
        { name: 'photo.jpg', level: 'ultra', keepMetadata: true, size: 3000 },
        { name: 'logo.webp', level: 'ultra', keepMetadata: true, size: 2000 },
    ]);

    assert.deepEqual(calls.created, [SMALLER['hero.png'], SMALLER['photo.jpg']]);
    assert.equal(calls.commits.length, 1);
    assert.equal(calls.commits[0].branch, 'feature');
    assert.equal(calls.commits[0].parent, HEAD);
    assert.deepEqual(calls.commits[0].entries, [
        { path: 'public/hero.png', sha: blobSha(SMALLER['hero.png']) },
        { path: 'public/photo.jpg', sha: blobSha(SMALLER['photo.jpg']) },
    ]);
    assert.match(calls.commits[0].message, new RegExp(`Iminify-Blob: ${blobSha(SMALLER['hero.png'])}`));

    assert.equal(result.optimized[0].path, 'public/logo.webp');
    assert.equal(calls.comments.length, 1);
    assert.equal(calls.comments[0].create, 7);

    const body = calls.comments[0].body;

    assert.ok(body.startsWith(MARKER));
    assert.ok(body.includes('**Iminify compressed 2 images and saved 3.9 KB (57.1%).**'));
    assert.deepEqual(
        [...knownBlobs({ comment: body })].sort(),
        [blobSha(SMALLER['hero.png']), blobSha(SMALLER['photo.jpg']), 'c3'].sort(),
        'the comment remembers the written blobs and the image that was already small',
    );

    assert.deepEqual(k.log.outputs, { compressed: '2', 'saved-bytes': '4000', commit: '2222222222222222222222222222222222222222' });
    assert.ok(k.log.summary.includes('| `public/hero.png` | 3.9 KB | 1000 B | 75.0% |'));
});

test('a later push sends only what the action has not handled, and updates its comment', async () => {
    const written = blobSha(SMALLER['hero.png']);
    const commits = [{ commit: { message: commitMessage([{ path: 'public/hero.png', before: 4000, after: 1000, outputSha: written }]) } }];
    const comments = [
        { id: 90, body: 'An unrelated comment' },
        { id: 91, body: `${MARKER}\nEarlier report\n\n<!-- iminify-action-blobs: c3 -->\n` },
    ];
    const files = [
        { filename: 'public/hero.png', status: 'added', sha: written },
        { filename: 'public/logo.webp', status: 'added', sha: 'c3' },
        { filename: 'public/photo.jpg', status: 'added', sha: 'b2' },
    ];
    const { github, calls } = fakeGitHub({ files, commits, comments });
    const iminify = fakeIminify({ 'photo.jpg': 'completed' });

    await run({ env: env(), event: event(), kit: kit(), makeGitHub: () => github, makeIminify: iminify.make });

    assert.deepEqual(iminify.calls.uploads.map((upload) => upload.name), ['photo.jpg']);
    assert.equal(calls.comments[0].update, 91);
    assert.deepEqual([...knownBlobs({ comment: calls.comments[0].body })].sort(), [blobSha(SMALLER['photo.jpg']), 'c3'].sort());
});

test('with nothing new it calls Iminify for nothing and leaves the comment alone', async () => {
    const { github, calls } = fakeGitHub({ files: [{ filename: 'docs/a.md', status: 'added', sha: 'x' }] });
    const iminify = fakeIminify({});
    const k = kit();

    assert.equal(await run({ env: env(), event: event(), kit: k, makeGitHub: () => github, makeIminify: iminify.make }), null);
    assert.deepEqual(iminify.calls.tokens, []);
    assert.deepEqual(calls.comments, []);
    assert.deepEqual(k.log.outputs, { compressed: '0', 'saved-bytes': '0', commit: '' });
});

test('the ignore input keeps paths out', async () => {
    const { github } = fakeGitHub({ files: FILES });
    const iminify = fakeIminify({ 'photo.jpg': 'completed' });

    await run({ env: env({ ignore: 'public/*.png\n*.webp' }), event: event(), kit: kit(), makeGitHub: () => github, makeIminify: iminify.make });

    assert.deepEqual(iminify.calls.uploads.map((upload) => upload.name), ['photo.jpg']);
});

test('when the day\'s images run out, the rest are listed for the next push', async () => {
    const { github, calls } = fakeGitHub({ files: FILES });
    const iminify = fakeIminify({ 'hero.png': 'completed', 'photo.jpg': new DailyLimitError("You've used your 40 images for today.", 3600) });

    const result = await run({ env: env(), event: event(), kit: kit(), makeGitHub: () => github, makeIminify: iminify.make });

    assert.deepEqual(iminify.calls.uploads.map((upload) => upload.name), ['hero.png', 'photo.jpg']);
    assert.deepEqual(result.leftOver, ['public/photo.jpg', 'public/logo.webp']);
    assert.equal(calls.commits.length, 1, 'what was compressed is still committed');
    assert.ok(calls.comments[0].body.includes("ran out before 2 images (`public/photo.jpg`, `public/logo.webp`)"));
});

test('one image that fails is reported while the rest go on', async () => {
    const { github } = fakeGitHub({ files: FILES });
    const iminify = fakeIminify({ 'hero.png': 'failed', 'photo.jpg': new IminifyError('The file is too large for your plan.', { status: 422, code: 'validation_failed' }), 'logo.webp': 'completed as png' });
    const k = kit();

    const result = await run({ env: env(), event: event(), kit: k, makeGitHub: () => github, makeIminify: iminify.make });

    assert.deepEqual(result.failed, [
        { path: 'public/photo.jpg', message: 'The file is too large for your plan.' },
        { path: 'public/hero.png', message: 'Iminify could not compress it.' },
        { path: 'public/logo.webp', message: 'Iminify returned it as png, so it was left as it is.' },
    ]);
    assert.deepEqual(result.compressed, [], 'a file in another format is never written under the old name');
    assert.equal(k.log.warning.length, 3);
});

test('a wrong token stops the run', async () => {
    const { github, calls } = fakeGitHub({ files: FILES });
    const iminify = fakeIminify({ 'hero.png': new IminifyError('Unauthenticated.', { status: 401, code: 'unauthenticated' }) });

    await assert.rejects(run({ env: env(), event: event(), kit: kit(), makeGitHub: () => github, makeIminify: iminify.make }), /Unauthenticated/);
    assert.deepEqual(calls.comments, []);
});

test('a branch that moved during the run gets no commit, and the images are not remembered', async () => {
    const { github, calls } = fakeGitHub({ files: FILES, commitError: new GitHubError('Update is not a fast forward', 422) });
    const iminify = fakeIminify({ 'hero.png': 'completed', 'photo.jpg': 'completed', 'logo.webp': 'already-optimized' });
    const k = kit();

    const result = await run({ env: env(), event: event(), kit: k, makeGitHub: () => github, makeIminify: iminify.make });

    assert.equal(result.commit, null);
    assert.ok(calls.comments[0].body.includes('They were not committed: the branch moved'));
    assert.deepEqual([...knownBlobs({ comment: calls.comments[0].body })], ['c3']);
    assert.equal(k.log.outputs.commit, '');
});

test('a token that cannot push fails the step after the comment is written', async () => {
    const { github, calls } = fakeGitHub({ files: FILES, commitError: new GitHubError('Resource not accessible by integration', 403) });
    const iminify = fakeIminify({ 'hero.png': 'completed', 'photo.jpg': 'already-optimized', 'logo.webp': 'already-optimized' });

    await assert.rejects(
        run({ env: env(), event: event(), kit: kit(), makeGitHub: () => github, makeIminify: iminify.make }),
        /contents: write/,
    );
    assert.equal(calls.comments.length, 1);
});

test('with commit off it only reports, and remembers the originals it measured', async () => {
    const { github, calls } = fakeGitHub({ files: FILES });
    const iminify = fakeIminify({ 'hero.png': 'completed', 'photo.jpg': 'already-optimized', 'logo.webp': 'already-optimized' });

    await run({ env: env({ commit: 'false' }), event: event(), kit: kit(), makeGitHub: () => github, makeIminify: iminify.make });

    assert.deepEqual(calls.created, []);
    assert.deepEqual(calls.commits, []);
    assert.ok(calls.comments[0].body.includes('The commit input is off'));
    assert.deepEqual([...knownBlobs({ comment: calls.comments[0].body })].sort(), ['a1', 'b2', 'c3']);
});

test('with comment off it writes no comment', async () => {
    const { github, calls } = fakeGitHub({ files: FILES });
    const iminify = fakeIminify({ 'hero.png': 'completed', 'photo.jpg': 'completed', 'logo.webp': 'completed' });

    await run({ env: env({ comment: 'false' }), event: event(), kit: kit(), makeGitHub: () => github, makeIminify: iminify.make });

    assert.deepEqual(calls.comments, []);
    assert.equal(calls.commits.length, 1);
});

test('a fork, a Dependabot pull request and a moved branch are skipped without a call to Iminify', async () => {
    const iminify = fakeIminify({});

    for (const [environment, payload, head, notice] of [
        [env(), event({ head: { sha: HEAD, ref: 'feature', repo: { full_name: 'someone/site' } } }), HEAD, /comes from a fork/],
        [env({ token: '' }, { GITHUB_ACTOR: 'dependabot[bot]' }), event(), HEAD, /Dependabot/],
        [env(), event(), '3333333333333333333333333333333333333333', /the branch is at 3333333 now/],
    ]) {
        const { github } = fakeGitHub({ files: FILES, head });
        const k = kit();

        assert.equal(await run({ env: environment, event: payload, kit: k, makeGitHub: () => github, makeIminify: iminify.make }), null);
        assert.match(k.log.notice[0], notice);
    }

    assert.deepEqual(iminify.calls.tokens, []);
});

test('a missing token, a wrong event or a wrong level fails with what to change', async () => {
    const run_ = (environment) => run({ env: environment, event: event(), kit: kit(), makeGitHub: () => fakeGitHub({ files: [] }).github, makeIminify: fakeIminify({}).make });

    await assert.rejects(run_(env({ token: '' })), /token input is empty/);
    await assert.rejects(run_(env({}, { GITHUB_EVENT_NAME: 'pull_request_target' })), /never pull_request_target/);
    await assert.rejects(run_(env({}, { GITHUB_EVENT_NAME: 'push' })), /came from push/);
    await assert.rejects(run_(env({ level: 'none' })), /smart, ultra or lossless/);
    await assert.rejects(run_(env({ commit: 'yes' })), /commit input must be true or false/);
});
