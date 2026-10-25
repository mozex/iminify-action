import { posix } from 'node:path';
import { createGitHub, GitHubError } from './github.js';
import { createIminify, DailyLimitError, IminifyError } from './iminify.js';
import { blobSha, contentProblem, parseList, sameFormat, selectFiles } from './files.js';
import { MARKER, commentBody, commitMessage, knownBlobs, report } from './report.js';
import { getBooleanInput, getInput } from './toolkit.js';

/** `none` is left out: without a format or a resize it would change nothing. */
const LEVELS = ['smart', 'ultra', 'lossless'];

const DEPENDABOT = 'dependabot[bot]';

/** Only these may have written a comment carrying the marker; anyone can comment on a public pull request. */
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR'];

/** A refusal no other file would escape: Iminify's fatal ones, or GitHub refusing the workflow's token. */
const stopsTheRun = (error) => (error instanceof IminifyError && error.isFatal) || (error instanceof GitHubError && [401, 403].includes(error.status));

export function readInputs(env) {
    const level = getInput('level', env) || 'smart';

    if (!LEVELS.includes(level)) {
        throw new Error(`The level input must be smart, ultra or lossless, not "${level}".`);
    }

    return {
        token: getInput('token', env),
        githubToken: getInput('github-token', env),
        level,
        keepMetadata: getBooleanInput('keep-metadata', false, env),
        commit: getBooleanInput('commit', true, env),
        comment: getBooleanInput('comment', true, env),
        ignore: parseList(getInput('ignore', env)),
    };
}

/**
 * Compresses the images a pull request adds or changes, commits the smaller files to its branch
 * and reports the savings in a comment. A refusal that no image would escape (the event, the
 * token, the permission to push) fails the step; a single image that fails is reported and the
 * rest go on.
 */
export async function run({ env, event, kit, makeGitHub = createGitHub, makeIminify = createIminify, userAgent = 'iminify-action' }) {
    const inputs = readInputs(env);
    const outputs = { compressed: 0, 'saved-bytes': 0, commit: '' };
    const finish = () => {
        for (const [name, value] of Object.entries(outputs)) {
            kit.setOutput(name, String(value));
        }
    };

    if ('pull_request_target' === env.GITHUB_EVENT_NAME) {
        throw new Error('Run this action on pull_request, never pull_request_target: that event hands your Iminify token to pull requests from anyone\'s fork.');
    }

    if ('pull_request' !== env.GITHUB_EVENT_NAME) {
        throw new Error(`Run this action on pull_request events; this run came from ${env.GITHUB_EVENT_NAME}.`);
    }

    const pull = event.pull_request;

    if (pull.head.repo?.full_name !== env.GITHUB_REPOSITORY) {
        kit.notice('Skipped: this pull request comes from a fork, and GitHub gives a fork\'s run neither your secrets nor a token that can push to its branch.');
        finish();

        return null;
    }

    if (!inputs.token) {
        if (DEPENDABOT === pull.user?.login || DEPENDABOT === env.GITHUB_ACTOR) {
            kit.notice('Skipped: GitHub gives a Dependabot pull request none of your Actions secrets.');
            finish();

            return null;
        }

        throw new Error('The token input is empty. Create an API token in Iminify\'s Settings > API Tokens, add it as a repository secret, and pass it as token.');
    }

    kit.mask(inputs.token);

    const github = makeGitHub({ token: inputs.githubToken, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL || undefined, userAgent });
    const current = await github.pull(pull.number);

    if (current.head.sha !== pull.head.sha) {
        kit.notice(`Skipped: the branch is at ${current.head.sha.slice(0, 7)} now, newer than the commit this run was started for.`);
        finish();

        return null;
    }

    const [files, commits, comments] = await Promise.all([
        github.pullFiles(pull.number),
        github.pullCommits(pull.number),
        github.comments(pull.number),
    ]);
    const previous = comments.find((comment) => comment.body?.includes(MARKER) && ('Bot' === comment.user?.type || TRUSTED.includes(comment.author_association)));
    const known = knownBlobs({ comment: previous?.body, commits });
    const selected = selectFiles(files, { ignore: inputs.ignore, known });
    const moved = selected.filter((file) => null !== file.from);
    const before = new Map();

    // A file moved or copied unchanged was compressed, or chosen not to be, where it came from.
    // GitHub lists a pull request's files against the merge base, so that's where they're read,
    // one folder listing at a time.
    if (moved.length) {
        const mergeBase = await github.mergeBase(current.base.sha, current.head.sha);

        for (const folder of new Set(moved.map((file) => posix.dirname(file.from)))) {
            for (const [path, sha] of await github.folderShas('.' === folder ? '' : folder, mergeBase)) {
                before.set(path, sha);
            }
        }
    }

    const candidates = selected.filter((file) => null === file.from || before.get(file.from) !== file.sha);

    if (!candidates.length) {
        kit.info('No new images to compress in this pull request.');
        finish();

        return null;
    }

    // A token that can't write would otherwise surface only after every image was counted.
    if (inputs.commit) {
        try {
            await github.createBlob(Buffer.alloc(0));
        } catch (error) {
            if (error instanceof GitHubError && [403, 404].includes(error.status)) {
                throw new Error(`GitHub refused to store a file (${error.message}). Give the workflow the contents: write permission.`);
            }

            throw error;
        }
    } else if (!inputs.comment) {
        kit.notice('With commit and comment both off, nothing remembers these images, so every push sends them again.');
    }

    kit.info(`Checking ${candidates.length} new ${1 === candidates.length ? 'image' : 'images'}.`);

    const iminify = makeIminify({ token: inputs.token, userAgent, log: kit.info });
    const result = { sent: 0, compressed: [], optimized: [], skipped: [], failed: [], leftOver: [], limitMessage: null, commit: null, commitNote: null };
    const queued = [];

    for (const [index, file] of candidates.entries()) {
        try {
            const bytes = await github.blob(file.sha);
            const problem = contentProblem(file.path, bytes);

            if (problem) {
                result.skipped.push({ path: file.path, message: problem, inputSha: file.sha });
                continue;
            }

            const image = await iminify.upload({ bytes, name: posix.basename(file.path), level: inputs.level, keepMetadata: inputs.keepMetadata });

            queued.push({ ...file, id: image.id });
            result.sent++;
        } catch (error) {
            if (error instanceof DailyLimitError) {
                result.leftOver = candidates.slice(index).map((left) => left.path);
                result.limitMessage = error.message;
                break;
            }

            if (stopsTheRun(error)) {
                throw error;
            }

            result.failed.push({ path: file.path, message: error.message });
        }
    }

    const entries = [];

    for (const file of queued) {
        try {
            const image = await iminify.waitFor(file.id);
            const smaller = 'completed' === image.status && image.saved_bytes > 0;

            if (smaller && !sameFormat(file.path, image.optimized.format)) {
                result.skipped.push({ path: file.path, message: `Iminify returned it as ${image.optimized.format}, so it was left as it is.`, inputSha: file.sha });
            } else if (smaller) {
                const bytes = await iminify.download(image.optimized.download_url);

                if (bytes.length >= image.original.size) {
                    result.optimized.push({ path: file.path, inputSha: file.sha });
                    continue;
                }

                if (inputs.commit) {
                    entries.push({ path: file.path, sha: await github.createBlob(bytes) });
                }

                result.compressed.push({ path: file.path, before: image.original.size, after: bytes.length, inputSha: file.sha, outputSha: blobSha(bytes) });
            } else if (['completed', 'already-optimized'].includes(image.status)) {
                result.optimized.push({ path: file.path, inputSha: file.sha });
            } else {
                result.failed.push({ path: file.path, message: 'failed' === image.status ? 'Iminify could not compress it.' : 'It was cancelled on Iminify before it started.' });
            }
        } catch (error) {
            if (stopsTheRun(error)) {
                throw error;
            }

            result.failed.push({ path: file.path, message: error.message });
        }
    }

    let commitError = null;

    if (entries.length) {
        try {
            result.commit = await github.commitTree({ branch: current.head.ref, parent: current.head.sha, message: commitMessage(result.compressed), entries });
        } catch (error) {
            if (422 === error.status) {
                result.commitNote = 'They were not committed: the branch moved while they were compressing, so the next run sends them again.';
            } else {
                result.commitNote = `They were not committed: ${error.message}`;
                commitError = `GitHub refused the commit (${error.message}). Give the workflow the contents: write permission.`;
            }
        }
    } else if (result.compressed.length) {
        result.commitNote = 'The commit input is off, so nothing was committed.';
    }

    if (inputs.comment) {
        const remembered = new Set([
            ...known,
            ...[...result.optimized, ...result.skipped].map((file) => file.inputSha),
        ]);

        // A compressed image is remembered by the bytes its path now holds: the action's own once
        // committed, the original with commit off, and neither when the commit failed.
        for (const file of result.compressed) {
            if (!inputs.commit) {
                remembered.add(file.inputSha);
            } else if (result.commit) {
                remembered.add(file.outputSha);
            }
        }

        const body = commentBody(result, remembered);

        try {
            await (previous ? github.updateComment(previous.id, body) : github.createComment(pull.number, body));
        } catch (error) {
            kit.warning(`The pull request comment could not be written (${error.message}). Give the workflow the pull-requests: write permission.`);
        }
    }

    for (const file of [...result.skipped, ...result.failed]) {
        kit.warning(`${file.path}: ${file.message}`);
    }

    kit.summary(`## Iminify\n\n${report(result)}\n`);

    outputs.compressed = result.compressed.length;
    outputs['saved-bytes'] = result.compressed.reduce((sum, file) => sum + file.before - file.after, 0);
    outputs.commit = result.commit ?? '';
    finish();

    if (commitError) {
        throw new Error(commitError);
    }

    return result;
}
