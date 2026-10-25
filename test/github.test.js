import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, GitHubError } from '../src/github.js';
import { bytes, fakeFetch, json } from './fake-fetch.js';

const REPO = 'https://api.github.com/repos/acme/site';

const client = (handlers) => {
    const fake = fakeFetch(handlers);

    return { ...fake, github: createGitHub({ token: 'gh-token', repository: 'acme/site', fetch: fake.fetch }) };
};

test('a pull request\'s files are read page by page', async () => {
    const page = (count, offset) => Array.from({ length: count }, (_, i) => ({ filename: `f${offset + i}.png` }));
    const { github, calls } = client([() => json(200, page(100, 0)), () => json(200, page(3, 100))]);

    const files = await github.pullFiles(7);

    assert.equal(files.length, 103);
    assert.deepEqual(calls.map((call) => call.url), [
        `${REPO}/pulls/7/files?per_page=100&page=1`,
        `${REPO}/pulls/7/files?per_page=100&page=2`,
    ]);
    assert.equal(calls[0].headers.Authorization, 'Bearer gh-token');
});

test('a blob is read raw from the Git database', async () => {
    const { github, calls } = client([() => bytes('raw-bytes')]);

    assert.equal((await github.blob('abc')).toString(), 'raw-bytes');
    assert.equal(calls[0].url, `${REPO}/git/blobs/abc`);
    assert.equal(calls[0].headers.Accept, 'application/vnd.github.raw+json');
});

test('a commit goes on top of the parent and fast-forwards the branch without force', async () => {
    const { github, calls } = client([
        () => json(201, { sha: 'blob-1' }),
        () => json(200, { sha: 'parent', tree: { sha: 'parent-tree' } }),
        () => json(201, { sha: 'new-tree' }),
        () => json(201, { sha: 'new-commit' }),
        () => json(200, { object: { sha: 'new-commit' } }),
    ]);

    assert.equal(await github.createBlob(Buffer.from('small')), 'blob-1');
    assert.deepEqual(JSON.parse(calls[0].body), { content: Buffer.from('small').toString('base64'), encoding: 'base64' });

    const commit = await github.commitTree({ branch: 'feature/new images', parent: 'parent', message: 'Compress', entries: [{ path: 'img/a.png', sha: 'blob-1' }] });

    assert.equal(commit, 'new-commit');
    assert.equal(calls[1].url, `${REPO}/git/commits/parent`);
    assert.deepEqual(JSON.parse(calls[2].body), { base_tree: 'parent-tree', tree: [{ path: 'img/a.png', mode: '100644', type: 'blob', sha: 'blob-1' }] });
    assert.deepEqual(JSON.parse(calls[3].body), { message: 'Compress', tree: 'new-tree', parents: ['parent'] });
    assert.equal(calls[4].url, `${REPO}/git/refs/heads/feature/new%20images`);
    assert.equal(calls[4].method, 'PATCH');
    assert.deepEqual(JSON.parse(calls[4].body), { sha: 'new-commit', force: false });
});

test('the merge base comes from the comparison, and a folder lists each file\'s blob without its bytes', async () => {
    const { github, calls } = client([
        () => json(200, { merge_base_commit: { sha: 'mb' }, files: [] }),
        () => json(200, [
            { type: 'file', path: 'a b/c#.png', sha: 's1' },
            { type: 'dir', path: 'a b/sub', sha: 's2' },
        ]),
        () => json(404, { message: 'Not Found' }),
        () => json(502, { message: 'Server Error' }),
    ]);

    assert.equal(await github.mergeBase('base', 'head'), 'mb');
    assert.deepEqual([...await github.folderShas('a b', 'mb')], [['a b/c#.png', 's1']]);
    assert.deepEqual([...await github.folderShas('gone', 'mb')], [], 'a folder missing at that commit holds nothing');
    await assert.rejects(github.folderShas('x', 'mb'), (error) => error instanceof GitHubError && 502 === error.status);
    assert.deepEqual(calls.map((call) => call.url), [
        `${REPO}/compare/base...head`,
        `${REPO}/contents/a%20b?ref=mb`,
        `${REPO}/contents/gone?ref=mb`,
        `${REPO}/contents/x?ref=mb`,
    ]);
});

test('a refusal carries GitHub\'s message and status', async () => {
    const { github } = client([() => json(422, { message: 'Update is not a fast forward' })]);

    await assert.rejects(github.commitTree({ branch: 'b', parent: 'p', message: 'm', entries: [] }), (error) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, 422);
        assert.equal(error.message, 'Update is not a fast forward');

        return true;
    });
});
