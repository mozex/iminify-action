export class GitHubError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'GitHubError';
        this.status = status;
    }
}

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

        /** The Git database's blob endpoint, because the contents endpoint stops at 1 MB. */
        blob: (sha) => request(`/git/blobs/${sha}`, { accept: 'application/vnd.github.raw+json', raw: true }),

        /** Stores the bytes in the repository's Git database ahead of the commit, so the run holds no file in memory. */
        createBlob: async (bytes) => (await request('/git/blobs', {
            method: 'POST',
            body: { content: bytes.toString('base64'), encoding: 'base64' },
        })).sha,

        /**
         * One commit on top of `parent` pointing each path at its new blob, then a fast-forward of
         * the branch. Made through the API, so GitHub signs it, and with the workflow's token, so
         * it starts no new workflow run. A branch that moved since `parent` refuses the update (422).
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

            await request(`/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, {
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
