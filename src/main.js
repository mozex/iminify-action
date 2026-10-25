import { readFileSync } from 'node:fs';
import { run } from './run.js';
import { createToolkit } from './toolkit.js';
import manifest from '../package.json' with { type: 'json' };

const kit = createToolkit();

try {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));

    await run({ env: process.env, event, kit, userAgent: `iminify-action/${manifest.version}` });
} catch (error) {
    kit.error(error.message);
    process.exitCode = 1;
}
