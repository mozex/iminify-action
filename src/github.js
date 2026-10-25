export class GitHubError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'GitHubError';
        this.status = status;
    }
}

const encodePath = (path) => path.split('/').map(encodeURIComponent).join('/');

/** The handful of REST calls the action makes, on the token the workflow hands it. */
export function createGitHub({
    token,
    repository,
    apiUrl = 'https://api.github.com',
    userAgent = 'iminify-action',
    fetch = globalThis.fetch,
}) {
    const base = `${apiUrl}/repos/${repository}`;

    async function request(path, { method = 'GET', body, accept = 'application/vnd.github+json', raw = false } = {}) {
        const response = await fetch(base + path, {
            method,
            body: undefined === body ? undefined : JSON.stringify(body),
            headers: {
                Accept: accept,
                Authorization: `Bearer ${token}`,
                'User-Agent': userAgent,
                'X-GitHub-Api-Version': '2022-11-28',
                ...(undefined === body ? {} : { 'Content-Type': 'application/json' }),
            },
            signal: AbortSignal.timeout(300_000),
        });

        if (!response.ok) {
            const payload = await response.json().catch(() => ({}));

            throw new GitHubError(payload.message ?? `GitHub answered ${response.status}.`, response.status);
        }

        if (raw) {
            return Buffer.from(await response.arrayBuffer());
        }

        return 204 === response.status ? null : response.json();
    }

    async function paginate(path, limit) {
        const items = [];

        for (let page = 1; ; page++) {
            const batch = await request(`${path}?per_page=100&page=${page}`);

            items.push(...batch);

            if (batch.length < 100 || items.length >= limit) {
                return items;
            }
        }
    }

    return {
        pull: (number) => request(`/pulls/${number}`),

        /** GitHub lists at most 3,000 files of a pull request. */
        pullFiles: (number) => paginate(`/pulls/${number}/files`, 3000),

        /** GitHub lists at most 250 commits of a pull request. */
        pullCommits: (number) => paginate(`/pulls/${number}/commits`, 250),

        /** The commit GitHub compares a pull request against: where its branch left the base. */
        mergeBase: async (base, head) => (await request(`/compare/${base}...${head}`)).merge_base_commit.sha,

        /**
         * Each file's blob in one folder at a commit, by path, from one listing that carries no
         * file's bytes; empty where the folder didn't exist. GitHub lists up to 1,000 entries.
         *
         * @returns {Promise<Map<string, string>>}
         */
        async folderShas(folder, ref) {
            try {
                const entries = await request(`/contents/${encodePath(folder)}?ref=${ref}`);

                return new Map(entries.filter((entry) => 'file' === entry.type).map((entry) => [entry.path, entry.sha]));
            } catch (error) {
                if (404 === error.status) {
                    return new Map();
                }

                throw error;
            }
        },

        /** The Git database's blob endpoint, because the contents endpoint stops at 1 MB. */
        blob: (sha) => request(`/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', raw: true }),

        /** Stores the bytes in the repository's Git database ahead of the commit, so the run holds no file in memory. */
        createBlob: async (bytes) => (await request('/git/blobs', {
            method: 'POST',
            body: { content: bytes.toString('base64'), encoding: 'base64' },
        })).sha,

        /**
         * One commit on top of `parent` pointing each path at its new blob, then a fast-forward of
         * the branch. GitHub holds the runs a workflow token's commit would start until someone
         * approves them. A branch that moved since `parent` refuses the update (422).
         *
         * @param {{branch: string, parent: string, message: string, entries: Array<{path: string, sha: string}>}} commit
         * @returns {Promise<string>} the new commit's sha
         */
        async commitTree({ branch, parent, message, entries }) {
            const parentCommit = await request(`/git/commits/${parent}`);
            const tree = await request('/git/trees', {
                method: 'POST',
                body: {
                    base_tree: parentCommit.tree.sha,
                    tree: entries.map((entry) => ({ path: entry.path, mode: '100644', type: 'blob', sha: entry.sha })),
                },
            });
            const commit = await request('/git/commits', {
                method: 'POST',
                body: { message, tree: tree.sha, parents: [parent] },
            });

            await request(`/git/refs/heads/${encodePath(branch)}`, {
                method: 'PATCH',
                body: { sha: commit.sha, force: false },
            });

            return commit.sha;
        },

        comments: (number) => paginate(`/issues/${number}/comments`, Infinity),

        createComment: (number, body) => request(`/issues/${number}/comments`, { method: 'POST', body: { body } }),

        updateComment: (id, body) => request(`/issues/comments/${id}`, { method: 'PATCH', body: { body } }),
    };
}
