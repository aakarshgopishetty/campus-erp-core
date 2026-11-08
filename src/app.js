import express from 'express';
import crypto from 'node:crypto';
import { checkPw } from './db.js';
import { validate, ruleParse } from './query.js';
import { LEAVE, leaveDays, validateLeave, COMPONENTS, PROGRAMMES, ageOn, atRisk, parseApplicants, pct, validateRecord } from './logic.js';

export function createApp(db, secret, opts = {}) {
  if (!secret) throw new Error('SESSION_SECRET is required');
  const app = express();
  app.set('trust proxy', 1);
  const fails = new Map(); // login throttle: 5 failures per 15 min per ip+email
  app.use((_q, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" }); next(); });
  app.use(express.json({ limit: '200kb' }));
  app.use(express.static(new URL('../public', import.meta.url).pathname));
  const sign = (p) => { const b = Buffer.from(JSON.stringify(p)).toString('base64url');
    return b + '.' + crypto.createHmac('sha256', secret).update(b).digest('base64url'); };
  const verify = (t) => { const [b, s] = (t || '').split('.');
    if (!b || !s) return null;
    const ok = crypto.createHmac('sha256', secret).update(b).digest('base64url');
    if (s.length !== ok.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(ok))) return null;
    const p = JSON.parse(Buffer.from(b, 'base64url').toString());
    return p.exp > Date.now() ? p : null; };
  const auth = (...roles) => (req, res, next) => {
    const u = verify((req.headers.authorization || '').replace('Bearer ', ''));
    if (!u) return res.status(401).json({ error: 'Sign in required' });
    if (roles.length && !roles.includes(u.role)) return res.status(403).json({ error: 'Not allowed for your role' });
    req.user = u; next(); };
  const audit = (uid, action, detail) =>
    db.prepare('INSERT INTO audit(at,user_id,action,detail) VALUES(?,?,?,?)').run(new Date().toISOString(), uid, action, JSON.stringify(detail));

  const canTeach = (u, sid) => u.role === 'admin' || !!db.prepare('SELECT 1 FROM teaching WHERE user_id=? AND subject_id=?').get(u.id, sid);
  const attPct = (roll) => { const r = db.prepare('SELECT SUM(present) p, COUNT(*) t FROM attendance WHERE roll=?').get(roll); return r.t ? pct(r.p || 0, r.t) : null; };
  const marksBySubject = (roll) => { const out = {};
    for (const m of db.prepare('SELECT sub.code, m.component, m.score, m.max FROM marks m JOIN subjects sub ON sub.id=m.subject_id WHERE m.roll=?').all(roll)) (out[m.code] ??= {})[m.component] = { score: m.score, max: m.max };
    return out; };
  // Attendance reason once, marks reasons per subject (prefixed with the subject code).
  const riskReasons = (roll) => { const r = atRisk({ attPct: attPct(roll), marks: {} });
    for (const [code, marks] of Object.entries(marksBySubject(roll))) r.push(...atRisk({ attPct: null, marks }).map((x) => code + ': ' + x));
    return r; };
  const lowestTotal = (roll) => { const t = Object.values(marksBySubject(roll)).map((ms) => Object.values(ms).reduce((a, m) => a + m.score, 0)); return t.length ? Math.min(...t) : null; };
  const enrolInto = (sid) => { const q = db.prepare('SELECT programme,year,campus_id FROM subjects WHERE id=?').get(sid);
    db.prepare('INSERT OR IGNORE INTO enrolments SELECT roll,? FROM students WHERE campus_id=? AND programme=? AND year=?').run(sid, q.campus_id, q.programme, q.year); };
  const enrolStudent = (roll) => { const q = db.prepare('SELECT programme,year,campus_id FROM students WHERE roll=?').get(roll);
    db.prepare('INSERT OR IGNORE INTO enrolments SELECT ?,id FROM subjects WHERE campus_id=? AND programme=? AND year=?').run(roll, q.campus_id, q.programme, q.year); };

  app.post('/api/login', (req, res) => {
    let { email, password } = req.body || {};
    if (typeof email === 'string') email = email.trim().toLowerCase(); // phone keyboards capitalise and add spaces
    const key = req.ip + '|' + String(email).toLowerCase().slice(0, 100), f = fails.get(key);
    if (f && f.n >= 5 && Date.now() - f.t < 900e3) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes' });
    const u = typeof email === 'string' && typeof password === 'string' && db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!u || !checkPw(password, u.pw)) { fails.set(key, { n: (f && Date.now() - f.t < 900e3 ? f.n : 0) + 1, t: Date.now() }); return res.status(401).json({ error: 'Wrong email or password' }); }
    fails.delete(key);
    res.json({ token: sign({ id: u.id, role: u.role, campus: u.campus_id, exp: Date.now() + 8 * 3600e3 }), name: u.name, role: u.role });
  });

  // Subjects (masters). Faculty only see and use subjects assigned to them.
  app.get('/api/subjects', auth(), (req, res) =>
    res.json(db.prepare(`SELECT s.id,s.code,s.name,s.programme,s.year,
      (SELECT group_concat(u.name, ', ') FROM teaching t JOIN users u ON u.id=t.user_id WHERE t.subject_id=s.id) faculty
      FROM subjects s WHERE s.campus_id=? AND (?=1 OR s.id IN (SELECT subject_id FROM teaching WHERE user_id=?)) ORDER BY s.code`).all(req.user.campus, req.user.role === 'admin' ? 1 : 0, req.user.id)));
  app.post('/api/subjects', auth('admin'), (req, res) => {
    const { code, name, programme, year, faculty_email } = req.body || {};
    if (typeof code !== 'string' || !/^[A-Za-z0-9-]{2,12}$/.test(code) || typeof name !== 'string' || name.trim().length < 3 || name.length > 60 || !PROGRAMMES[programme] || !Number.isInteger(year) || year < 1 || year > 4)
      return res.status(400).json({ error: 'Check code (2-12 letters/digits), name, programme and year' });
    if (db.prepare('SELECT 1 FROM subjects WHERE campus_id=? AND code=?').get(req.user.campus, code.toUpperCase())) return res.status(409).json({ error: 'That subject code already exists' });
    let fac = null;
    if (faculty_email) { fac = db.prepare("SELECT id FROM users WHERE email=? AND role='faculty' AND campus_id=?").get(String(faculty_email).trim().toLowerCase(), req.user.campus);
      if (!fac) return res.status(400).json({ error: 'No faculty member with that email on this campus' }); }
    const id = Number(db.prepare('INSERT INTO subjects(campus_id,code,name,programme,year) VALUES(?,?,?,?,?)').run(req.user.campus, code.toUpperCase(), name.trim(), programme, year).lastInsertRowid);
    if (fac) db.prepare('INSERT INTO teaching VALUES(?,?)').run(fac.id, id);
    enrolInto(id);
    audit(req.user.id, 'subject.create', { id, code: code.toUpperCase(), faculty: fac ? faculty_email : null });
    res.json({ id });
  });

  app.get('/api/subjects/:id/students', auth(), (req, res) => {
    const sid = Number(req.params.id);
    if (!db.prepare('SELECT 1 FROM subjects WHERE id=? AND campus_id=?').get(sid, req.user.campus) || !canTeach(req.user, sid)) return res.status(403).json({ error: 'Not your subject' });
    res.json(db.prepare('SELECT s.roll,s.name FROM students s JOIN enrolments e ON e.roll=s.roll WHERE e.subject_id=? AND s.campus_id=? ORDER BY s.roll').all(sid, req.user.campus));
  });

  app.get('/api/students', auth(), (req, res) => {
    const rows = db.prepare('SELECT roll,name,programme,year FROM students WHERE campus_id=?').all(req.user.campus);
    res.json(rows.map((s) => ({ ...s, attendance: attPct(s.roll) })));
  });

  // Idempotent offline sync: client_id is the key, so retries never double count.
  app.post('/api/attendance/sync', auth('faculty'), (req, res) => {
    const recs = req.body?.records;
    if (!Array.isArray(recs) || recs.length > 500) return res.status(400).json({ error: 'records[] required (max 500)' });
    const out = { accepted: [], duplicates: [], corrected: [], rejected: [] };
    const ins = db.prepare('INSERT OR IGNORE INTO attendance VALUES(?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (const r of recs) {
      const err = validateRecord(r);
      const ok = !err && db.prepare('SELECT 1 FROM students WHERE roll=? AND campus_id=?').get(r.roll, req.user.campus)
        && db.prepare('SELECT 1 FROM subjects WHERE id=? AND campus_id=?').get(r.subject_id, req.user.campus) && canTeach(req.user, r.subject_id)
        && db.prepare('SELECT 1 FROM enrolments WHERE roll=? AND subject_id=?').get(r.roll, r.subject_id);
      if (err || !ok) { out.rejected.push({ client_id: r?.client_id, reason: err || 'unknown student, subject not assigned to you, or student not enrolled' }); continue; }
      if (db.prepare('SELECT 1 FROM attendance WHERE client_id=?').get(r.client_id)) { out.duplicates.push(r.client_id); continue; }
      const slot = db.prepare('SELECT client_id,present FROM attendance WHERE roll=? AND subject_id=? AND date=? AND period=?').get(r.roll, r.subject_id, r.date, r.period);
      if (slot) { // same period marked again: a different value is a correction (last write wins, audited)
        if (slot.present !== (r.present ? 1 : 0)) {
          db.prepare('UPDATE attendance SET present=?, marked_by=? WHERE client_id=?').run(r.present ? 1 : 0, req.user.id, slot.client_id);
          audit(req.user.id, 'attendance.correct', { roll: r.roll, date: r.date, period: r.period, from: slot.present, to: r.present ? 1 : 0 });
          out.corrected.push(r.client_id);
        } else out.duplicates.push(r.client_id);
        continue;
      }
      ins.run(r.client_id, r.roll, r.subject_id, r.date, r.period, r.present ? 1 : 0, req.user.id);
      out.accepted.push(r.client_id);
    }
    db.exec('COMMIT');
    res.json(out);
  });

  app.get('/api/marks/:subject', auth(), (req, res) => {
    const sid = Number(req.params.subject);
    if (!db.prepare('SELECT 1 FROM subjects WHERE id=? AND campus_id=?').get(sid, req.user.campus) || !canTeach(req.user, sid)) return res.status(403).json({ error: 'Not your subject' });
    const have = new Map(db.prepare('SELECT roll,component,score FROM marks WHERE subject_id=?').all(sid).map((m) => [m.roll + '|' + m.component, m.score]));
    const rows = [];
    for (const s of db.prepare('SELECT s.roll,s.name FROM students s JOIN enrolments e ON e.roll=s.roll WHERE e.subject_id=? AND s.campus_id=? ORDER BY s.roll').all(sid, req.user.campus))
      for (const [component, max] of Object.entries(COMPONENTS)) rows.push({ roll: s.roll, name: s.name, component, score: have.get(s.roll + '|' + component) ?? null, max });
    res.json({ locked: !!db.prepare('SELECT 1 FROM mark_locks WHERE subject_id=?').get(sid), rows });
  });

  // Export only after moderation lock, so the file always matches the frozen marks.
  app.get('/api/marks/:subject/export.csv', auth('admin'), (req, res) => {
    const sid = Number(req.params.subject);
    if (!db.prepare('SELECT 1 FROM mark_locks WHERE subject_id=?').get(sid)) return res.status(409).json({ error: 'Lock marks after moderation before exporting' });
    const cell = (v) => { let t = String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; }; // blocks CSV formula injection
    const rows = db.prepare('SELECT s.roll,s.name,s.programme,s.year FROM students s JOIN enrolments e ON e.roll=s.roll WHERE e.subject_id=? AND s.campus_id=? ORDER BY s.roll').all(sid, req.user.campus);
    const get = db.prepare('SELECT component,score FROM marks WHERE roll=? AND subject_id=?');
    const lines = [['Roll No', 'Name', 'Programme', 'Year', 'Mid1', 'Mid2', 'Assignment', 'Internal Total (40)']];
    for (const r of rows) { const m = Object.fromEntries(get.all(r.roll, sid).map((x) => [x.component, x.score]));
      lines.push([r.roll, r.name, r.programme, r.year, m.mid1 ?? '', m.mid2 ?? '', m.assignment ?? '', (m.mid1 || 0) + (m.mid2 || 0) + (m.assignment || 0)]); }
    audit(req.user.id, 'marks.export', { subject_id: sid });
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="internal-marks.csv"').send(lines.map((l) => l.map(cell).join(',')).join('\r\n'));
  });

  app.put('/api/marks', auth('faculty'), (req, res) => {
    const { roll, subject_id, component, score } = req.body || {};
    const max = COMPONENTS[component];
    if (!max || !Number.isInteger(subject_id) || typeof roll !== 'string' || typeof score !== 'number' || score < 0 || score > max)
      return res.status(400).json({ error: 'Invalid marks entry' });
    if (!canTeach(req.user, subject_id)) return res.status(403).json({ error: 'Not your subject' });
    if (db.prepare('SELECT 1 FROM mark_locks WHERE subject_id=?').get(subject_id))
      return res.status(409).json({ error: 'Marks are locked after moderation' });
    const old = db.prepare('SELECT score FROM marks WHERE roll=? AND subject_id=? AND component=?').get(roll, subject_id, component);
    if (!db.prepare('SELECT 1 FROM enrolments e JOIN students s ON s.roll=e.roll WHERE e.roll=? AND e.subject_id=? AND s.campus_id=?').get(roll, subject_id, req.user.campus)) return res.status(404).json({ error: 'Student is not enrolled in this subject' });
    db.prepare('INSERT INTO marks VALUES(?,?,?,?,?) ON CONFLICT(roll,subject_id,component) DO UPDATE SET score=excluded.score').run(roll, subject_id, component, score, max);
    audit(req.user.id, 'marks.set', { roll, subject_id, component, from: old?.score ?? null, to: score });
    res.json({ ok: true });
  });

  app.post('/api/marks/lock', auth('admin'), (req, res) => {
    const sid = req.body?.subject_id;
    if (!Number.isInteger(sid)) return res.status(400).json({ error: 'subject_id required' });
    db.prepare('INSERT OR IGNORE INTO mark_locks VALUES(?,?,?)').run(sid, req.user.id, new Date().toISOString());
    audit(req.user.id, 'marks.lock', { subject_id: sid });
    res.json({ locked: true });
  });

  app.post('/api/marks/unlock', auth('admin'), (req, res) => {
    const { subject_id, reason } = req.body || {};
    if (!Number.isInteger(subject_id) || typeof reason !== 'string' || reason.trim().length < 5)
      return res.status(400).json({ error: 'A reason of at least 5 characters is required' });
    db.prepare('DELETE FROM mark_locks WHERE subject_id=?').run(subject_id);
    audit(req.user.id, 'marks.unlock', { subject_id, reason: reason.trim() });
    res.json({ locked: false });
  });

  app.get('/api/audit', auth('admin'), (_q, res) => res.json(db.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 100').all()));

  app.get('/api/fees', auth('admin'), (req, res) =>
    res.json(db.prepare('SELECT roll,name,programme,fee_due FROM students WHERE campus_id=? ORDER BY fee_due DESC').all(req.user.campus)));

  app.post('/api/fees/pay-mock', auth('admin'), (req, res) => {
    const { roll, amount } = req.body || {};
    const s = typeof roll === 'string' && db.prepare('SELECT fee_due FROM students WHERE roll=? AND campus_id=?').get(roll, req.user.campus);
    if (!s || !Number.isInteger(amount) || amount <= 0 || amount > s.fee_due) return res.status(400).json({ error: 'Amount must be between 1 and the amount due' });
    db.prepare('UPDATE students SET fee_due=fee_due-? WHERE roll=?').run(amount, roll);
    const pid = db.prepare('INSERT INTO payments(roll,amount,mode,at) VALUES(?,?,?,?)').run(roll, amount, 'MOCK', new Date().toISOString()).lastInsertRowid;
    audit(req.user.id, 'fee.payment.mock', { roll, amount });
    res.json({ ok: true, remaining: s.fee_due - amount, receipt: 'RCPT-' + String(pid).padStart(6, '0') });
  });

  // Receipts as Tally-style receipt vouchers. ASSUMPTION: column layout is mine, not a verified Tally import template.
  app.get('/api/fees/export.csv', auth('admin'), (req, res) => {
    const q = (v) => { let t = String(v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; };
    const rows = db.prepare('SELECT p.id,p.at,p.amount,s.name,s.roll FROM payments p JOIN students s ON s.roll=p.roll WHERE s.campus_id=? ORDER BY p.id').all(req.user.campus);
    const out = [['Date', 'Voucher Type', 'Voucher No', 'Ledger Name', 'Amount', 'Narration']].concat(rows.map((r) =>
      [r.at.slice(0, 10), 'Receipt', 'RCPT-' + String(r.id).padStart(6, '0'), r.name, r.amount, 'Fee receipt ' + r.roll + ' (test mode)']));
    audit(req.user.id, 'fees.export', { rows: rows.length });
    res.type('text/csv').set('Content-Disposition', 'attachment; filename="fee-receipts.csv"').send(out.map((l) => l.map(q).join(',')).join('\r\n'));
  });

  // Applicant import: creates student records with roll numbers. Minors without guardian consent are held, not created (DPDP).
  app.post('/api/admissions/import', auth('admin'), (req, res) => {
    const text = req.body?.csv;
    if (typeof text !== 'string' || text.length > 100000) return res.status(400).json({ error: 'csv text required (max 100 KB)' });
    const parsed = parseApplicants(text);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    if (parsed.rows.length > 200) return res.status(400).json({ error: 'Max 200 rows per import' });
    const out = { created: [], held: [], duplicates: [], rejected: [] }, yy = new Date().getUTCFullYear() % 100;
    db.exec('BEGIN');
    parsed.rows.forEach((r, i) => {
      const line = i + 2, prog = PROGRAMMES[r.programme], year = Number(r.year);
      if (!r.name || r.name.length > 80 || !prog || !Number.isInteger(year) || year < 1 || year > 4 || !/^\d{4}-\d{2}-\d{2}$/.test(r.dob) || isNaN(Date.parse(r.dob)) || !['yes', 'no'].includes(r.guardian_consent.toLowerCase()))
        return out.rejected.push({ line, reason: 'invalid name, dob, programme, year or guardian_consent' });
      const consent = r.guardian_consent.toLowerCase() === 'yes';
      if (ageOn(r.dob) < 18 && !consent) return out.held.push({ line, name: r.name, reason: 'Under 18: guardian consent needed' });
      if (db.prepare('SELECT 1 FROM students WHERE campus_id=? AND name=? AND dob=? AND programme=?').get(req.user.campus, r.name, r.dob, r.programme)) return out.duplicates.push({ line, name: r.name });
      const [pre, code] = prog, stem = [pre, yy, code].filter((x) => x !== null).join('-') + '-';
      const n = db.prepare('SELECT COUNT(*) c FROM students WHERE roll LIKE ?').get(stem + '%').c + 1;
      const roll = stem + String(n).padStart(4, '0');
      db.prepare('INSERT INTO students(roll,campus_id,name,programme,year,guardian_consent,dob) VALUES(?,?,?,?,?,?,?)').run(roll, req.user.campus, r.name, r.programme, year, consent ? 1 : 0, r.dob);
      enrolStudent(roll);
      out.created.push({ line, name: r.name, roll });
    });
    db.exec('COMMIT');
    audit(req.user.id, 'admissions.import', { created: out.created.length, held: out.held.length, rejected: out.rejected.length });
    res.json(out);
  });

  const usedDays = (uid, year, exceptId = 0) => db.prepare("SELECT from_date f, to_date t FROM leave_requests WHERE user_id=? AND status='approved' AND substr(from_date,1,4)=? AND id<>?").all(uid, String(year), exceptId).reduce((a, r) => a + leaveDays(r.f, r.t), 0);

  // Staff leave: faculty apply, office admin decides. Every decision is audited.
  app.post('/api/leave', auth('faculty'), (req, res) => {
    const err = validateLeave(req.body);
    if (err) return res.status(400).json({ error: err });
    const { type, from, to, reason } = req.body, days = leaveDays(from, to);
    if (db.prepare("SELECT 1 FROM leave_requests WHERE user_id=? AND status IN('pending','approved') AND from_date<=? AND to_date>=?").get(req.user.id, to, from))
      return res.status(409).json({ error: 'You already have leave that overlaps these dates' });
    const left = LEAVE.annualDays - usedDays(req.user.id, from.slice(0, 4));
    if (days > left) return res.status(409).json({ error: `Only ${left} leave day(s) left for ${from.slice(0, 4)}; this request is ${days}` });
    const id = db.prepare('INSERT INTO leave_requests(user_id,from_date,to_date,type,reason,created_at) VALUES(?,?,?,?,?,?)').run(req.user.id, from, to, type, reason.trim(), new Date().toISOString()).lastInsertRowid;
    audit(req.user.id, 'leave.apply', { id: Number(id), from, to, type });
    res.json({ id: Number(id), days });
  });
  app.get('/api/leave', auth(), (req, res) => {
    const base = 'SELECT l.id,u.name,l.from_date,l.to_date,l.type,l.reason,l.status FROM leave_requests l JOIN users u ON u.id=l.user_id';
    const rows = req.user.role === 'admin' ? db.prepare(base + ' WHERE u.campus_id=? ORDER BY l.id DESC').all(req.user.campus) : db.prepare(base + ' WHERE l.user_id=? ORDER BY l.id DESC').all(req.user.id);
    res.json({ rows: rows.map((r) => ({ ...r, days: leaveDays(r.from_date, r.to_date) })), left: req.user.role === 'faculty' ? LEAVE.annualDays - usedDays(req.user.id, new Date().getUTCFullYear()) : null });
  });
  app.post('/api/leave/:id/decide', auth('admin'), (req, res) => {
    const d = req.body?.decision, l = db.prepare('SELECT l.*,u.campus_id c FROM leave_requests l JOIN users u ON u.id=l.user_id WHERE l.id=?').get(Number(req.params.id));
    if (!['approve', 'reject'].includes(d)) return res.status(400).json({ error: 'decision must be approve or reject' });
    if (!l || l.c !== req.user.campus) return res.status(404).json({ error: 'Leave request not found' });
    if (l.status !== 'pending') return res.status(409).json({ error: 'Already ' + l.status });
    if (d === 'approve' && leaveDays(l.from_date, l.to_date) > LEAVE.annualDays - usedDays(l.user_id, l.from_date.slice(0, 4), l.id))
      return res.status(409).json({ error: 'Approving would exceed the annual leave balance' });
    db.prepare('UPDATE leave_requests SET status=?,decided_by=?,decided_at=? WHERE id=?').run(d === 'approve' ? 'approved' : 'rejected', req.user.id, new Date().toISOString(), l.id);
    audit(req.user.id, 'leave.' + d, { id: l.id });
    res.json({ status: d === 'approve' ? 'approved' : 'rejected' });
  });

  // Campus dashboard: counts only, no AI.
  app.get('/api/dashboard', auth('admin'), (req, res) => {
    const st = db.prepare('SELECT roll,fee_due FROM students WHERE campus_id=?').all(req.user.campus);
    const atts = st.map((s) => attPct(s.roll)).filter((a) => a != null);
    res.json({ students: st.length, avgAttendance: atts.length ? Math.round((atts.reduce((a, b) => a + b, 0) / atts.length) * 10) / 10 : null,
      below75: atts.filter((a) => a < 75).length, totalDue: st.reduce((a, s) => a + s.fee_due, 0), studentsWithDues: st.filter((s) => s.fee_due > 0).length,
      openMentorTasks: db.prepare("SELECT COUNT(*) c FROM mentor_tasks WHERE status='open'").get().c,
      pendingLeave: db.prepare("SELECT COUNT(*) c FROM leave_requests l JOIN users u ON u.id=l.user_id WHERE l.status='pending' AND u.campus_id=?").get(req.user.campus).c });
  });

  // At-risk flags only ever create a mentor task. They never change a record.
  app.get('/api/at-risk', auth(), (req, res) => {
    const out = db.prepare('SELECT roll,name FROM students WHERE campus_id=?').all(req.user.campus)
      .map((s) => ({ ...s, attendance: attPct(s.roll), reasons: riskReasons(s.roll) }))
      .filter((s) => s.reasons.length);
    res.json(out);
  });
  app.post('/api/at-risk/run', auth('admin'), (req, res) => {
    let created = 0;
    for (const s of db.prepare('SELECT roll FROM students WHERE campus_id=?').all(req.user.campus)) {
      const reasons = riskReasons(s.roll);
      if (reasons.length && db.prepare('INSERT OR IGNORE INTO mentor_tasks(roll,reasons,created_at) VALUES(?,?,?)').run(s.roll, JSON.stringify(reasons), new Date().toISOString()).changes) created++;
    }
    res.json({ created });
  });
  // Office-staff question box: returns the filters used and the row count so staff can check it.
  app.post('/api/ask', auth('admin'), async (req, res) => {
    const q = req.body?.q;
    if (typeof q !== 'string' || q.trim().length < 3 || q.length > 200) return res.status(400).json({ error: 'Ask a question of 3 to 200 characters' });
    const progs = db.prepare('SELECT DISTINCT programme FROM students WHERE campus_id=?').all(req.user.campus).map((x) => x.programme);
    let filters = null, source = 'rules';
    if (opts.llm) { try { filters = validate(await opts.llm(q, progs), progs); if (filters) source = 'ai'; } catch { filters = null; } }
    if (!filters?.length) { filters = validate(ruleParse(q, progs), progs); source = 'rules'; }
    if (!filters?.length) return res.status(422).json({ error: 'I could not turn that into filters. Try: "second-year students below 75%" or "students with fee dues"' });
    const rows = db.prepare('SELECT roll,name,programme,year,fee_due FROM students WHERE campus_id=?').all(req.user.campus)
      .map((s) => ({ ...s, attendance: attPct(s.roll), marks_total: lowestTotal(s.roll) }))
      .filter((s) => filters.every((f) => s[f.field] != null && ({ '<': s[f.field] < f.value, '<=': s[f.field] <= f.value, '>': s[f.field] > f.value, '>=': s[f.field] >= f.value, '=': s[f.field] === f.value })[f.op]));
    audit(req.user.id, 'ask', { q: q.slice(0, 100), filters, count: rows.length, source });
    res.json({ source, filters, count: rows.length, rows: rows.slice(0, 50) });
  });

  app.get('/api/mentor-tasks', auth(), (_q, res) => res.json(db.prepare('SELECT * FROM mentor_tasks').all()));
  return app;
}
