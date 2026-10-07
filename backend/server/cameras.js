/**
 * Which camera is watching which side of the door.
 *
 * Two physical cameras, two jobs:
 *
 *   Entrance camera  faces the PG door from inside    -> whoever it sees is coming IN
 *   Outside camera   faces away from the door, outward -> whoever it sees is going OUT
 *
 * Cam 1 is the entrance camera and Cam 2 the outside camera until the warden
 * presses Swap. Swapping is for when the cables went into the wrong ports, or
 * the cameras were mounted the other way round: it changes the job, not the
 * hardware, so nobody has to touch a .env file or restart anything. The
 * recognition service polls this and picks the change up within a few seconds.
 *
 * Stored in data/cameras.json: one tiny file, written only by this process.
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');

const FILE = () => path.join(db.DATA_DIR, 'cameras.json');

const LABELS = {
  in: 'Entrance camera',
  out: 'Outside camera',
};

function readSwapped() {
  try {
    const raw = fs.readFileSync(FILE(), 'utf8').trim();
    if (!raw) return { swapped: false, updated_at: null };
    const parsed = JSON.parse(raw);
    return {
      swapped: parsed && parsed.swapped === true,
      updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : null,
    };
  } catch {
    // Missing or unreadable file: the default arrangement, not an error.
    return { swapped: false, updated_at: null };
  }
}

/** Roles for both cameras, as the dashboard and the recognition service read them. */
function get() {
  const { swapped, updated_at } = readSwapped();
  const roleOf = (id) => {
    const entrance = swapped ? id === '2' : id === '1';
    return entrance ? 'in' : 'out';
  };
  return {
    swapped,
    updated_at,
    cameras: ['1', '2'].map((id) => {
      const role = roleOf(id);
      return { id, role, label: LABELS[role] };
    }),
  };
}

/** Set the arrangement explicitly. Returns the new state. */
function setSwapped(value, now = new Date()) {
  fs.mkdirSync(db.DATA_DIR, { recursive: true });
  const tmp = `${FILE()}.tmp`;
  fs.writeFileSync(
    tmp,
    JSON.stringify({ swapped: value === true, updated_at: now.toISOString() }, null, 2),
    'utf8'
  );
  fs.renameSync(tmp, FILE());
  return get();
}

module.exports = { get, setSwapped, LABELS };
