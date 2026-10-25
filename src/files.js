import { createHash } from 'node:crypto';

/**
 * The formats Iminify reads and can hand back in the same format. HEIC and TIFF are left out:
 * Iminify always returns them as another format, and a new extension would break every reference
 * to the file.
 */
export const EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

/** A file the pull request leaves with new bytes; `removed` and `unchanged` have none. */
const STATUSES = ['added', 'modified', 'renamed', 'copied', 'changed'];

/** Git's own id for these bytes, the sha GitHub lists for a pull request's file. */
export function blobSha(bytes) {
    return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

export function extensionOf(path) {
    const match = /\.([^./]+)$/.exec(path);

    return match ? match[1].toLowerCase() : '';
}

/** `jpeg` and `jpg` are one format; Iminify answers `jpg` for both. */
export function sameFormat(path, format) {
    const normal = (extension) => ('jpeg' === extension ? 'jpg' : extension);

    return normal(extensionOf(path)) === normal(String(format ?? '').toLowerCase());
}

/**
 * A pattern the way .gitignore reads one, without `!` or `[...]`: `*` stays inside a folder, `**`
 * crosses folders, a pattern with no slash, or only one at its end, matches at any depth, one
 * with a slash before its end starts at the repository root, and a pattern that names a folder
 * covers everything under it.
 */
export function globToRegExp(pattern) {
    let glob = pattern.trim().replace(/^\.\//, '');

    if (!glob.replace(/\/$/, '').includes('/')) {
        glob = `**/${glob}`;
    }

    if (glob.endsWith('/')) {
        glob += '**';
    }

    glob = glob.replace(/^\//, '');

    let source = '';

    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];

        if ('*' === char && '*' === glob[i + 1]) {
            const slash = '/' === glob[i + 2];

            source += slash ? '(?:.*/)?' : '.*';
            i += slash ? 2 : 1;
        } else if ('*' === char) {
            source += '[^/]*';
        } else if ('?' === char) {
            source += '[^/]';
        } else {
            source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }

    return new RegExp(`^${source}(?:/.*)?$`);
}

export function parseList(value) {
    return value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * The pull request's images still to compress: a format Iminify keeps, not ignored, and bytes the
 * action has not already handled (its own output, or an image it found already optimized). A
 * moved or copied file keeps the path it came from, so the caller can tell a move from an edit.
 *
 * @param {Array<{filename: string, status: string, sha: string, previous_filename?: string}>} files GitHub's list of the pull request's files
 * @returns {Array<{path: string, sha: string, from: ?string}>}
 */
export function selectFiles(files, { ignore = [], known = new Set() } = {}) {
    const patterns = ignore.map(globToRegExp);

    return files
        .filter((file) => STATUSES.includes(file.status))
        .filter((file) => EXTENSIONS.includes(extensionOf(file.filename)))
        .filter((file) => !patterns.some((pattern) => pattern.test(file.filename)))
        .filter((file) => !known.has(file.sha))
        .map((file) => ({ path: file.filename, sha: file.sha, from: file.previous_filename ?? null }));
}

const LFS_POINTER = 'version https://git-lfs.github.com/spec/v1';

/** The format the bytes themselves are in, read from their first bytes. */
export function detectFormat(bytes) {
    const ascii = (start, end) => bytes.subarray(start, end).toString('latin1');

    if ('89504e470d0a1a0a' === bytes.subarray(0, 8).toString('hex')) {
        return 'png';
    }

    if ('ffd8ff' === bytes.subarray(0, 3).toString('hex')) {
        return 'jpg';
    }

    if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
        return 'gif';
    }

    if ('RIFF' === ascii(0, 4) && 'WEBP' === ascii(8, 12)) {
        return 'webp';
    }

    return null;
}

/**
 * Why a file can't be sent as it is, or null. Iminify reads a file by its bytes, so a PNG named
 * .jpg would come back under the wrong extension, and a Git LFS pointer is a few lines of text.
 * Neither changes until the file does, so the caller remembers them instead of paying again.
 */
export function contentProblem(path, bytes) {
    if (LFS_POINTER === bytes.subarray(0, LFS_POINTER.length).toString('latin1')) {
        return 'It is stored in Git LFS, and the action reads only files kept in Git itself.';
    }

    const format = detectFormat(bytes);

    if (!sameFormat(path, format)) {
        return format
            ? `Its bytes are a ${format.toUpperCase()}, not what its .${extensionOf(path)} extension says.`
            : `Its bytes are not a ${extensionOf(path).toUpperCase()} image.`;
    }

    return null;
}
