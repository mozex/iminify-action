import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, commentBody, commitMessage, formatBytes, knownBlobs, report } from '../src/report.js';

const sha = (char) => char.repeat(40);

const empty = { compressed: [], optimized: [], failed: [], leftOver: [], limitMessage: null, commit: null, commitNote: null };

test('formatBytes', () => {
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2.0 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.00 MB');
});

test('the commit message names every file and ends with a trailer per written blob', () => {
    const message = commitMessage([
        { path: 'a.png', before: 4096, after: 1024, outputSha: sha('a') },
        { path: 'b.jpg', before: 2048, after: 1024, outputSha: sha('b') },
    ]);

    assert.match(message, /^Compress 2 images with Iminify\n\na\.png: 4\.0 KB to 1\.0 KB\nb\.jpg: 2\.0 KB to 1\.0 KB\n\n/);
    assert.ok(message.endsWith(`Iminify-Blob: ${sha('a')}\nIminify-Blob: ${sha('b')}\n`));
});

test('knownBlobs reads the comment and the action\'s own commits back', () => {
    const comment = commentBody(empty, new Set([sha('c'), sha('d')]));
    const commits = [
        { commit: { message: commitMessage([{ path: 'a.png', before: 2, after: 1, outputSha: sha('a') }]) } },
        { commit: { message: `Someone's commit\n\nIminify-Blob: not-a-sha\nCo-authored-by: X` } },
        { commit: { message: `Iminify-Blob: ${sha('e')} in prose` } },
    ];

    assert.deepEqual([...knownBlobs({ comment, commits })].sort(), [sha('a'), sha('c'), sha('d')]);
    assert.deepEqual([...knownBlobs({})], []);
});

test('the report lists what was saved, what was already small, what failed and what was left', () => {
    const text = report({
        ...empty,
        compressed: [
            { path: 'img/a|b.png', before: 10240, after: 2560 },
            { path: 'img/c.jpg', before: 10240, after: 7680 },
        ],
        optimized: [{ path: 'img/d.webp' }],
        failed: [{ path: 'img/e.png', message: 'Iminify could not compress it.' }],
        leftOver: ['img/f.png', 'img/g.png'],
        limitMessage: "You've used your 40 images for today. Come back in about 3 hours.",
        commit: sha('f'),
    });

    assert.ok(text.startsWith(`**Iminify compressed 2 images and saved 10.0 KB (50.0%).** The smaller files are in ${sha('f')}.`));
    assert.ok(text.includes('| `img/a\\|b.png` | 10.0 KB | 2.5 KB | 75.0% |'), 'a pipe in a path is escaped in the table');
    assert.ok(text.includes('| `img/c.jpg` | 10.0 KB | 7.5 KB | 25.0% |'));
    assert.ok(text.includes('Already as small as Iminify can make them: `img/d.webp`.'));
    assert.ok(text.includes('- `img/e.png`: Iminify could not compress it.'));
    assert.ok(text.includes('ran out before 2 images (`img/f.png`, `img/g.png`)'));
    assert.ok(text.includes("> You've used your 40 images for today."));
});

test('the report says so when nothing got smaller, and why nothing was committed', () => {
    assert.ok(report({ ...empty, optimized: [{ path: 'a.png' }] }).startsWith('**Iminify found nothing it could make smaller.**'));

    const note = report({ ...empty, compressed: [{ path: 'a.png', before: 2048, after: 1024 }], commitNote: 'The commit input is off, so nothing was committed.' });

    assert.ok(note.startsWith('**Iminify compressed 1 image and saved 1.0 KB (50.0%).** The commit input is off'));
});

test('the comment carries the marker', () => {
    assert.ok(commentBody(empty, new Set()).startsWith(`${MARKER}\n`));
});
