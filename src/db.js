import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

export const hashPw = (pw, salt = crypto.randomBytes(8).toString('hex')) =>
  salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
export const checkPw = (pw, h) => {
  const [s, x] = h.split(':');
  return crypto.timingSafeEqual(Buffer.from(hashPw(pw, s).split(':')[1], 'hex'), Buffer.from(x, 'hex'));
};

export function createDb(path = ':memory:', demoPassword = 'demo-pass-1') {
  const db = new DatabaseSync(path);
  db.exec(`
  CREATE TABLE IF NOT EXISTS campuses(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT, role TEXT CHECK(role IN('faculty','admin')), campus_id INTEGER, pw TEXT);
  CREATE TABLE IF NOT EXISTS subjects(id INTEGER PRIMARY KEY, campus_id INTEGER, code TEXT, name TEXT, programme TEXT, year INTEGER);
  CREATE TABLE IF NOT EXISTS students(roll TEXT PRIMARY KEY, campus_id INTEGER, name TEXT, programme TEXT, year INTEGER, fee_due INTEGER DEFAULT 0, guardian_consent INTEGER DEFAULT 0, dob TEXT);
  CREATE TABLE IF NOT EXISTS attendance(client_id TEXT PRIMARY KEY, roll TEXT, subject_id INTEGER, date TEXT, period INTEGER, present INTEGER, marked_by INTEGER,
    UNIQUE(roll, subject_id, date, period));
  CREATE TABLE IF NOT EXISTS marks(roll TEXT, subject_id INTEGER, component TEXT, score REAL, max REAL, PRIMARY KEY(roll, subject_id, component));
  CREATE TABLE IF NOT EXISTS mark_locks(subject_id INTEGER PRIMARY KEY, locked_by INTEGER, locked_at TEXT);
  CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, at TEXT, user_id INTEGER, action TEXT, detail TEXT);
  CREATE TABLE IF NOT EXISTS mentor_tasks(id INTEGER PRIMARY KEY, roll TEXT UNIQUE, reasons TEXT, status TEXT DEFAULT 'open', created_at TEXT);
  CREATE TABLE IF NOT EXISTS leave_requests(id INTEGER PRIMARY KEY, user_id INTEGER, from_date TEXT, to_date TEXT, type TEXT, reason TEXT, status TEXT DEFAULT 'pending', decided_by INTEGER, decided_at TEXT, created_at TEXT);
  CREATE TABLE IF NOT EXISTS payments(id INTEGER PRIMARY KEY, roll TEXT, amount INTEGER, mode TEXT, at TEXT);
  `);
  if (!db.prepare('SELECT 1 FROM users').get()) seed(db, demoPassword);
  return db;
}

function seed(db, pw) {
  const run = (s, ...a) => db.prepare(s).run(...a);
  run('INSERT INTO campuses VALUES(1,?)', 'Engineering College (demo campus)');
  run('INSERT INTO users(email,name,role,campus_id,pw) VALUES(?,?,?,?,?)', 'faculty@demo.test', 'Dr. Demo Faculty', 'faculty', 1, hashPw(pw));
  run('INSERT INTO users(email,name,role,campus_id,pw) VALUES(?,?,?,?,?)', 'admin@demo.test', 'Demo Office Admin', 'admin', 1, hashPw(pw));
  run('INSERT INTO subjects VALUES(1,1,?,?,?,2)', 'CS301', 'Data Structures', 'B.Tech CSE');
  // Sample rows from the brief (ASSUMPTION: all placed on one demo campus for this slice).
  const S = [
    ['ENG-24-CSE-0412', 'Subhashree Mohanty', 'B.Tech CSE', 2, 0, 815, [17, 8, 8]],
    ['ENG-24-ME-0177', 'Ankit Panda', 'B.Tech Mechanical', 2, 45000, 682, [11, 4, 6]],
    ['MBA-25-0093', 'Farheen Ali', 'MBA', 1, 0, 920, [18, 9, 9]],
  ];
  db.exec('BEGIN');
  for (const [roll, name, prog, yr, due, perMille, m] of S) {
    run('INSERT INTO students(roll,campus_id,name,programme,year,fee_due) VALUES(?,?,?,?,?,?)', roll, 1, name, prog, yr, due);
    ['mid1', 'mid2', 'assignment'].forEach((c, i) =>
      run('INSERT INTO marks VALUES(?,?,?,?,?)', roll, 1, c, m[i], [20, 10, 10][i]));
    // 1000 seeded periods (100 days x 10 slots) reproduce the brief's attendance % exactly.
    for (let i = 0; i < 1000; i++) {
      const d = new Date(Date.UTC(2026, 5, 1 + Math.floor(i / 10))).toISOString().slice(0, 10);
      run('INSERT INTO attendance VALUES(?,?,?,?,?,?,?)', `seed-${roll}-${i}`, roll, 1, d, (i % 10) + 1, i < perMille ? 1 : 0, 1);
    }
  }
  db.exec('COMMIT');
}
