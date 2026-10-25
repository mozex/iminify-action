import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobSha, contentProblem, detectFormat, extensionOf, globToRegExp, parseList, sameFormat, selectFiles } from '../src/files.js';

test('blobSha is the id git gives the same bytes', () => {
    // git hash-object of "hello\n"
    assert.equal(blobSha(Buffer.from('hello\n')), 'ce013625030ba8dba906f756967f9e9ca394464a');
});

test('extensionOf and sameFormat read jpeg and jpg as one format', () => {
    assert.equal(extensionOf('a/b/Photo.JPEG'), 'jpeg');
    assert.equal(extensionOf('a.b/README'), '');
    assert.equal(sameFormat('hero.jpeg', 'jpg'), true);
    assert.equal(sameFormat('hero.JPG', 'jpg'), true);
    assert.equal(sameFormat('logo.png', 'webp'), false);
    assert.equal(sameFormat('logo.png', undefined), false);
});

test('globToRegExp reads patterns the way .gitignore does', () => {
    const matches = (pattern, path) => globToRegExp(pattern).test(path);

    assert.equal(matches('*.gif', 'a/b/spinner.gif'), true, 'a pattern with no slash matches in any folder');
    assert.equal(matches('*.gif', 'spinner.gif'), true);
    assert.equal(matches('tests/fixtures/', 'tests/fixtures/deep/a.png'), true, 'a folder matches everything under it');
    assert.equal(matches('tests/fixtures/', 'src/tests/fixtures/a.png'), false, 'a pattern with a slash before its end starts at the root');
    assert.equal(matches('fixtures/', 'tests/fixtures/a.png'), true, 'a folder name alone matches at any depth');
    assert.equal(matches('fixtures/', 'fixtures/a.png'), true);
    assert.equal(matches('fixtures/', 'tests/fixtures.png'), false);
    assert.equal(matches('tests/fixtures', 'tests/fixtures/a.png'), true, 'a pattern naming a folder covers what is in it');
    assert.equal(matches('fixtures', 'a/fixtures/b.png'), true);
    assert.equal(matches('*.gif', 'a/b.gif.png'), false);
    assert.equal(matches('docs/*.png', 'docs/a.png'), true);
    assert.equal(matches('docs/*.png', 'docs/sub/a.png'), false, 'one star stays inside a folder');
    assert.equal(matches('docs/**/*.png', 'docs/a.png'), true);
    assert.equal(matches('docs/**/*.png', 'docs/x/y/a.png'), true);
    assert.equal(matches('./img/logo?.png', 'img/logo2.png'), true);
    assert.equal(matches('img/logo?.png', 'img/logo22.png'), false);
    assert.equal(matches('a+b(1).png', 'x/a+b(1).png'), true, 'regular expression characters are literal');
});

test('parseList takes lines or commas', () => {
    assert.deepEqual(parseList(' a/ \n\n*.gif, b.png '), ['a/', '*.gif', 'b.png']);
    assert.deepEqual(parseList(''), []);
});

test('selectFiles keeps new bytes of the formats Iminify hands back in kind', () => {
    const files = [
        { filename: 'public/hero.png', status: 'added', sha: 'a1' },
        { filename: 'public/photo.JPEG', status: 'modified', sha: 'a2' },
        { filename: 'public/moved.webp', status: 'renamed', previous_filename: 'old/moved.webp', sha: 'a3' },
        { filename: 'public/gone.png', status: 'removed', sha: 'a4' },
        { filename: 'public/phone.heic', status: 'added', sha: 'a5' },
        { filename: 'public/icon.svg', status: 'added', sha: 'a6' },
        { filename: 'tests/fixtures/sample.png', status: 'added', sha: 'a7' },
        { filename: 'public/done.png', status: 'added', sha: 'a8' },
        { filename: 'public/spinner.gif', status: 'added', sha: 'a9' },
    ];

    assert.deepEqual(selectFiles(files, { ignore: ['tests/fixtures/'], known: new Set(['a8']) }), [
        { path: 'public/hero.png', sha: 'a1', from: null },
        { path: 'public/photo.JPEG', sha: 'a2', from: null },
        { path: 'public/moved.webp', sha: 'a3', from: 'old/moved.webp' },
        { path: 'public/spinner.gif', sha: 'a9', from: null },
    ]);
});

test('detectFormat reads the format from the first bytes', () => {
    const bytes = (hex, rest = '') => Buffer.concat([Buffer.from(hex, 'hex'), Buffer.from(rest, 'latin1')]);

    assert.equal(detectFormat(bytes('89504e470d0a1a0a0000')), 'png');
    assert.equal(detectFormat(bytes('ffd8ffe1')), 'jpg');
    assert.equal(detectFormat(Buffer.from('GIF89a....', 'latin1')), 'gif');
    assert.equal(detectFormat(Buffer.from('RIFF\x10\0\0\0WEBPVP8 ', 'latin1')), 'webp');
    assert.equal(detectFormat(Buffer.from('RIFF\x10\0\0\0WAVEfmt ', 'latin1')), null);
    assert.equal(detectFormat(Buffer.from('<svg xmlns=')), null);
    assert.equal(detectFormat(Buffer.alloc(0)), null);
});

test('contentProblem names a Git LFS pointer and bytes that contradict the extension', () => {
    const jpeg = Buffer.from('ffd8ffe0', 'hex');

    assert.equal(contentProblem('a.jpeg', jpeg), null);
    assert.equal(contentProblem('a.png', jpeg), 'Its bytes are a JPG, not what its .png extension says.');
    assert.equal(contentProblem('a.webp', Buffer.from('not an image')), 'Its bytes are not a WEBP image.');
    assert.equal(
        contentProblem('a.png', Buffer.from('version https://git-lfs.github.com/spec/v1\noid sha256:abc\n')),
        'It is stored in Git LFS, and the action reads only files kept in Git itself.',
    );
});
