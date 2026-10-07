/**
 * Removing guests from the dashboard, one or many at a time.
 *
 * recognition/enroll.py owns guests.json and embeddings.json, so removal goes
 * through it rather than this process editing those files behind its back.
 * That keeps one writer per file, and it means the command line and the
 * dashboard cannot disagree about what "remove" does.
 *
 * What it does: deletes the guest's face data (the camera stops matching them
 * within a few seconds) and takes them off the roster. What it keeps: their
 * visit history, as a paper register would — the guest's page still opens from
 * old log rows, and the movement counts for past days don't change.
 */

const { spawn } = require('child_process');
const path = require('path');

const MAX_IDS = 200;
const TIMEOUT_MS = Number(process.env.REMOVE_TIMEOUT_MS || 30000);

// Guest ids are hex. Anything else is rejected before it can reach a command
// line — in particular, nothing starting with "-" that argparse would read as
// a flag.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

let removing = false;

function fail(status, code, error) {
  return { error, code, status };
}

/** Check the request body. Returns { ids } or { error, code, status }. */
function validate(body) {
  const raw = body && body.ids;
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail(400, 'no_ids', 'Choose at least one guest to remove.');
  }
  if (raw.length > MAX_IDS) {
    return fail(400, 'too_many', `Remove at most ${MAX_IDS} guests at a time.`);
  }
  if (!raw.every((id) => typeof id === 'string' && ID_PATTERN.test(id))) {
    return fail(400, 'bad_ids', 'Those guest ids are not valid.');
  }
  return { ids: [...new Set(raw)] };
}

/**
 * Remove the guests. Resolves to { removed: [{id, name}], missing: [id] } or
 * { error, code, status }. Never rejects.
 *
 * `isBusy` lets the caller say an enrollment is running: both write the same
 * two files, and a read-modify-write from each at once would lose one.
 */
function remove(ids, options = {}) {
  if (removing || (options.isBusy && options.isBusy())) {
    return Promise.resolve(fail(
      409,
      'busy',
      'A guest is being added or removed right now. Wait a moment, then try again.'
    ));
  }

  const scriptPath = options.scriptPath
    || path.resolve(__dirname, '../../recognition/enroll.py');
  const pythonBin = options.pythonBin || process.env.PYTHON_BIN || 'python3';
  const args = [scriptPath, '--json', '--keep-record', '--remove', ...ids];

  removing = true;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const done = (result) => {
      if (settled) return;
      settled = true;
      removing = false;
      clearTimeout(timer);
      resolve(result);
    };

    const child = spawn(pythonBin, args, {
      cwd: path.dirname(scriptPath),
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done(fail(500, 'timeout', 'Removing took too long and was stopped. Please try again.'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (c) => { stdout += c.toString(); });
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-2000); });

    child.on('error', (err) => {
      done(fail(
        500,
        'spawn_failed',
        `Could not start the face recognition software (${err.message}). `
          + 'Ask whoever set this up to check that Python is installed.'
      ));
    });

    child.on('close', () => {
      const line = stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
      let parsed = null;
      try {
        parsed = line ? JSON.parse(line) : null;
      } catch {
        parsed = null;
      }

      if (parsed && parsed.ok) {
        done({ removed: parsed.removed || [], missing: parsed.missing || [] });
      } else if (parsed && parsed.code === 'not_found') {
        // Already gone — e.g. removed from another screen a moment ago.
        done({ removed: [], missing: ids });
      } else if (parsed && parsed.error) {
        done(fail(500, parsed.code || 'error', parsed.error));
      } else {
        console.error(`[remove] enroll.py gave no result. ${stderr.trim()}`);
        done(fail(500, 'unknown', 'Removing the guests failed. Please try again.'));
      }
    });
  });
}

/** Tests only. */
function reset() {
  removing = false;
}

module.exports = { MAX_IDS, validate, remove, reset };
