import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blobSha, extensionOf, globToRegExp, parseList, sameFormat, selectFiles } from '../src/files.js';

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
    assert.equal(matches('tests/fixtures/', 'src/tests/fixtures/a.png'), false, 'a pattern with a slash starts at the root');
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
        { filename: 'public/moved.webp', status: 'renamed', sha: 'a3' },
        { filename: 'public/gone.png', status: 'removed', sha: 'a4' },
        { filename: 'public/phone.heic', status: 'added', sha: 'a5' },
        { filename: 'public/icon.svg', status: 'added', sha: 'a6' },
        { filename: 'tests/fixtures/sample.png', status: 'added', sha: 'a7' },
        { filename: 'public/done.png', status: 'added', sha: 'a8' },
        { filename: 'public/spinner.gif', status: 'added', sha: 'a9' },
    ];

    assert.deepEqual(selectFiles(files, { ignore: ['tests/fixtures/'], known: new Set(['a8']) }), [
        { path: 'public/hero.png', sha: 'a1' },
        { path: 'public/photo.JPEG', sha: 'a2' },
        { path: 'public/moved.webp', sha: 'a3' },
        { path: 'public/spinner.gif', sha: 'a9' },
    ]);
});
