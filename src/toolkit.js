// The few pieces of @actions/core this action needs, so it ships with no dependencies.
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const escapeData = (value) => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function getInput(name, env = process.env) {
    return (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();
}

export function getBooleanInput(name, fallback, env = process.env) {
    const value = getInput(name, env);

    if ('' === value) {
        return fallback;
    }

    if (/^(true|True|TRUE)$/.test(value)) {
        return true;
    }

    if (/^(false|False|FALSE)$/.test(value)) {
        return false;
    }

    throw new Error(`The ${name} input must be true or false, not "${value}".`);
}

export function createToolkit(env = process.env, write = (line) => process.stdout.write(line + '\n')) {
    const command = (name, message) => write(`::${name}::${escapeData(message)}`);

    const appendTo = (variable, text) => {
        if (env[variable]) {
            appendFileSync(env[variable], text, 'utf8');
        }
    };

    return {
        info: (message) => write(message),
        notice: (message) => command('notice', message),
        warning: (message) => command('warning', message),
        error: (message) => command('error', message),
        mask: (secret) => {
            if (secret) {
                command('add-mask', secret);
            }
        },
        setOutput: (name, value) => {
            const delimiter = `ghadelimiter_${randomUUID()}`;

            appendTo('GITHUB_OUTPUT', `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
        },
        summary: (markdown) => appendTo('GITHUB_STEP_SUMMARY', markdown + '\n'),
    };
}
