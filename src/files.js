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
 * A pattern the way .gitignore reads one: `*` stays inside a folder, `**` crosses folders, a
 * pattern with no slash matches a name in any folder, and one ending in a slash matches everything
 * under that folder.
 */
export function globToRegExp(pattern) {
    let glob = pattern.trim().replace(/^\.\//, '');

    if (glob.endsWith('/')) {
        glob += '**';
    }

    if (!glob.includes('/')) {
        glob = `**/${glob}`;
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

    return new RegExp(`^${source}$`);
}

export function parseList(value) {
    return value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

/**
 * The pull request's images still to compress: a format Iminify keeps, not ignored, and bytes the
 * action has not already handled (its own output, or an image it found already optimized).
 *
 * @param {Array<{filename: string, status: string, sha: string}>} files GitHub's list of the pull request's files
 * @returns {Array<{path: string, sha: string}>}
 */
export function selectFiles(files, { ignore = [], known = new Set() } = {}) {
    const patterns = ignore.map(globToRegExp);

    return files
        .filter((file) => STATUSES.includes(file.status))
        .filter((file) => EXTENSIONS.includes(extensionOf(file.filename)))
        .filter((file) => !patterns.some((pattern) => pattern.test(file.filename)))
        .filter((file) => !known.has(file.sha))
        .map((file) => ({ path: file.filename, sha: file.sha }));
}
