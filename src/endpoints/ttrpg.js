import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import express from 'express';

const DICE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ttrpg', 'dice.py');
const MODES = ['normal', 'advantage', 'disadvantage'];
const EXECUTION_TIMEOUT = 5000;

/**
 * Python launchers to try in order. Can be overridden with the TTRPG_PYTHON environment variable.
 * @returns {{ command: string, args: string[] }[]}
 */
function getPythonCandidates() {
    if (process.env.TTRPG_PYTHON) {
        return [{ command: process.env.TTRPG_PYTHON, args: [] }];
    }
    return process.platform === 'win32'
        ? [{ command: 'python', args: [] }, { command: 'py', args: ['-3'] }]
        : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
}

/**
 * Runs the dice script. No shell is involved, arguments are passed as an array.
 * @param {string[]} scriptArgs Arguments for dice.py
 * @returns {Promise<{ stdout: string, code: number }>}
 */
async function runDiceScript(scriptArgs) {
    let lastError = null;

    for (const { command, args } of getPythonCandidates()) {
        try {
            return await new Promise((resolve, reject) => {
                execFile(command, [...args, DICE_SCRIPT, ...scriptArgs], { timeout: EXECUTION_TIMEOUT, windowsHide: true }, (error, stdout) => {
                    if (error && error.code === 'ENOENT') {
                        return reject(error);
                    }
                    // dice.py reports user errors as JSON with exit code 2.
                    resolve({ stdout: String(stdout || '').trim(), code: error ? Number(error.code) || 1 : 0 });
                });
            });
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`Python was not found (${lastError?.message ?? 'no launcher'}). Install Python 3 or set TTRPG_PYTHON.`);
}

export const router = express.Router();

router.post('/roll', async (request, response) => {
    try {
        const expression = String(request.body?.expression ?? '').trim();
        const mode = request.body?.mode === undefined ? 'normal' : String(request.body.mode);
        const dc = request.body?.dc;

        if (!expression || expression.length > 100) {
            return response.status(400).send({ error: 'Invalid expression' });
        }
        if (!MODES.includes(mode)) {
            return response.status(400).send({ error: 'Invalid mode' });
        }
        if (dc !== undefined && dc !== null && !Number.isInteger(dc)) {
            return response.status(400).send({ error: 'DC must be an integer' });
        }

        const scriptArgs = [`--expr=${expression}`, `--mode=${mode}`];
        if (Number.isInteger(dc)) {
            scriptArgs.push(`--dc=${dc}`);
        }

        const { stdout, code } = await runDiceScript(scriptArgs);
        let result;
        try {
            result = JSON.parse(stdout);
        } catch {
            return response.status(500).send({ error: `Dice script failed (exit code ${code})` });
        }
        return response.status(result.error ? 400 : 200).send(result);
    } catch (error) {
        console.error('[TTRPG] Dice roll failed', error);
        return response.status(500).send({ error: error.message });
    }
});
