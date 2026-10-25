/** Finds the action's own comment, to update it rather than add one on every push. */
export const MARKER = '<!-- iminify-action -->';

const KNOWN = /<!-- iminify-action-blobs:([0-9a-f\s]*)-->/;
const TRAILER = /^Iminify-Blob: ([0-9a-f]{40})$/gm;

/**
 * The bytes the action has already handled in this pull request, so a later push never sends them
 * again: a second lossy pass would cost quality and spend the account's images twice. They come
 * from the action's own commits, which name each file they wrote, and from its comment, which also
 * remembers the images that were already as small as they get.
 */
export function knownBlobs({ comment = '', commits = [] }) {
    const known = new Set((KNOWN.exec(comment)?.[1] ?? '').split(/\s+/).filter(Boolean));

    for (const commit of commits) {
        for (const match of (commit.commit?.message ?? '').matchAll(TRAILER)) {
            known.add(match[1]);
        }
    }

    return known;
}

export function formatBytes(bytes) {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

const percent = (saved, total) => (total > 0 ? `${((saved / total) * 100).toFixed(1)}%` : '0%');

const plural = (count, one, many) => `${count} ${1 === count ? one : many}`;

/** A path as inline code that also survives a table cell. */
const code = (path) => `\`${path.replace(/\|/g, '\\|')}\``;

export function commitMessage(compressed) {
    const lines = compressed.map((file) => `${file.path}: ${formatBytes(file.before)} to ${formatBytes(file.after)}`);
    const trailers = compressed.map((file) => `Iminify-Blob: ${file.outputSha}`);

    return `Compress ${plural(compressed.length, 'image', 'images')} with Iminify\n\n${lines.join('\n')}\n\n${trailers.join('\n')}\n`;
}

/**
 * What the run did, in Markdown, for the pull request comment and the job summary.
 *
 * @param {{compressed: Array, optimized: Array, failed: Array, leftOver: Array, limitMessage: ?string, commit: ?string, commitNote: ?string, committing: boolean}} result
 */
export function report(result) {
    const lines = [];
    const before = result.compressed.reduce((sum, file) => sum + file.before, 0);
    const saved = result.compressed.reduce((sum, file) => sum + file.before - file.after, 0);

    if (result.compressed.length) {
        let headline = `**Iminify compressed ${plural(result.compressed.length, 'image', 'images')} and saved ${formatBytes(saved)} (${percent(saved, before)}).**`;

        if (result.commit) {
            headline += ` The smaller files are in ${result.commit}.`;
        } else if (result.commitNote) {
            headline += ` ${result.commitNote}`;
        }

        lines.push(headline, '', '| Image | Before | After | Saved |', '| --- | ---: | ---: | ---: |');

        for (const file of result.compressed) {
            lines.push(`| ${code(file.path)} | ${formatBytes(file.before)} | ${formatBytes(file.after)} | ${percent(file.before - file.after, file.before)} |`);
        }
    } else {
        lines.push('**Iminify found nothing it could make smaller.**');
    }

    if (result.optimized.length) {
        lines.push('', `Already as small as Iminify can make them: ${result.optimized.map((file) => code(file.path)).join(', ')}.`);
    }

    if (result.failed.length) {
        lines.push('', 'Not compressed:', ...result.failed.map((file) => `- ${code(file.path)}: ${file.message}`));
    }

    if (result.leftOver.length) {
        lines.push(
            '',
            `The account's images for today ran out before ${plural(result.leftOver.length, 'image', 'images')} (${result.leftOver.map(code).join(', ')}). The next push to this pull request sends them again.`,
        );

        if (result.limitMessage) {
            lines.push('', `> ${result.limitMessage}`);
        }
    }

    return lines.join('\n');
}

export function commentBody(result, known) {
    return `${MARKER}\n${report(result)}\n\n<!-- iminify-action-blobs: ${[...known].join(' ')} -->\n`;
}
