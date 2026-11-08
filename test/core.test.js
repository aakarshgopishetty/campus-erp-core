import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { atRisk } from '../src/logic.js';

let base, srv, tok = {};
after(() => srv.close());
before(async () => {
  srv = createApp(createDb(':memory:', 'pw-test-123'), 'test-secret').listen(0, '127.0.0.1');
  await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  for (const r of ['faculty', 'admin']) {
    const x = await (await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `${r}@demo.test`, password: 'pw-test-123' }) })).json();
    tok[r] = x.token;
  }
});
const call = (m, p, r, b) => fetch(base + p, { method: m, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok[r] }, body: b && JSON.stringify(b) });
const rec = (id, present = true) => ({ client_id: id, roll: 'MBA-25-0093', subject_id: 1, date: '2026-11-02', period: 1, present });

test('seed reproduces the brief attendance % exactly', async () => {
  const s = await (await call('GET', '/api/students', 'faculty')).json();
  assert.deepEqual(s.map((x) => x.attendance), [81.5, 68.2, 92]);
});
test('attendance sync is idempotent (retry never double counts)', async () => {
  const a = await (await call('POST', '/api/attendance/sync', 'faculty', { records: [rec('client-aaaa-0001')] })).json();
  const b = await (await call('POST', '/api/attendance/sync', 'faculty', { records: [rec('client-aaaa-0001')] })).json();
  assert.equal(a.accepted.length, 1); assert.equal(b.duplicates.length, 1);
});
test('sync rejects bad input and admins cannot mark attendance', async () => {
  const r = await (await call('POST', '/api/attendance/sync', 'faculty', { records: [{ ...rec('client-bbbb-0002'), period: 99 }] })).json();
  assert.equal(r.rejected.length, 1);
  assert.equal((await call('POST', '/api/attendance/sync', 'admin', { records: [] })).status, 403);
});
test('marks lock blocks edits, unlock needs a reason, all changes audited', async () => {
  const put = (score) => call('PUT', '/api/marks', 'faculty', { roll: 'MBA-25-0093', subject_id: 1, component: 'mid1', score });
  assert.equal((await put(19)).status, 200);
  assert.equal((await put(25)).status, 400);
  await call('POST', '/api/marks/lock', 'admin', { subject_id: 1 });
  assert.equal((await put(20)).status, 409);
  assert.equal((await call('POST', '/api/marks/unlock', 'admin', { subject_id: 1, reason: 'x' })).status, 400);
  const log = await (await call('GET', '/api/audit', 'admin')).json();
  assert.ok(log.some((l) => l.action === 'marks.set') && log.some((l) => l.action === 'marks.lock'));
});
test('at-risk rule is deterministic and only creates mentor tasks', async () => {
  const m = { mid1: { score: 11, max: 20 }, mid2: { score: 4, max: 10 }, assignment: { score: 6, max: 10 } };
  assert.equal(atRisk({ attPct: 68.2, marks: m }).length, 1);
  assert.equal(atRisk({ attPct: 90, marks: { mid1: { score: 18, max: 20 }, mid2: { score: 9, max: 10 } } }).length, 0);
  const r = await (await call('POST', '/api/at-risk/run', 'admin')).json();
  assert.equal(r.created, 1);
  assert.equal((await (await call('POST', '/api/at-risk/run', 'admin')).json()).created, 0);
});
test('unauthenticated and over-paid requests are refused', async () => {
  assert.equal((await fetch(base + '/api/students')).status, 401);
  assert.equal((await call('POST', '/api/fees/pay-mock', 'admin', { roll: 'ENG-24-ME-0177', amount: 999999 })).status, 400);
});
test('CSV export needs the lock, is admin-only and neutralises formulas', async () => {
  await call('POST', '/api/marks/unlock', 'admin', { subject_id: 1, reason: 'test reset' });
  assert.equal((await call('GET', '/api/marks/1/export.csv', 'admin')).status, 409);
  await call('POST', '/api/marks/lock', 'admin', { subject_id: 1 });
  assert.equal((await call('GET', '/api/marks/1/export.csv', 'faculty')).status, 403);
  const ok = await call('GET', '/api/marks/1/export.csv', 'admin');
  const txt = await ok.text();
  assert.equal(ok.status, 200); assert.ok(txt.startsWith('"Roll No"') && txt.includes('Subhashree Mohanty'));
});
test('login is throttled after 5 failures', async () => {
  const bad = () => fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'nobody@x.test', password: 'wrong' }) });
  for (let i = 0; i < 5; i++) assert.equal((await bad()).status, 401);
  assert.equal((await bad()).status, 429);
});
import { validate, ruleParse } from '../src/query.js';
const PROGS = ['B.Tech CSE', 'B.Tech Mechanical', 'MBA'];
test('assistant: rules parse the brief example and the endpoint shows filters and count', async () => {
  const f = ruleParse('how many second-year students are below 75%', PROGS).filters;
  assert.deepEqual(f.map((x) => `${x.field}${x.op}${x.value}`), ['attendance<75', 'year=2']);
  const r = await (await call('POST', '/api/ask', 'admin', { q: 'second-year students below 75%' })).json();
  assert.equal(r.count, 1); assert.equal(r.rows[0].name, 'Ankit Panda'); assert.ok(r.filters.length === 2);
});
test('assistant: validator rejects unknown fields, bad ops and injected values', () => {
  const bad = (spec) => assert.equal(validate(spec, PROGS), null);
  bad({ filters: [{ field: 'pw', op: '=', value: 1 }] });
  bad({ filters: [{ field: 'year', op: '; DROP TABLE students', value: 1 }] });
  bad({ filters: [{ field: 'year', op: '=', value: '1 OR 1=1' }] });
  bad({ filters: [{ field: 'programme', op: '=', value: 'x' }] });
});
test('assistant: faculty are refused, bad AI output falls back to rules, unclear questions get 422', async () => {
  assert.equal((await call('POST', '/api/ask', 'faculty', { q: 'students with dues' })).status, 403);
  const srv2 = createApp(createDb(':memory:', 'pw-test-123'), 'test-secret', { llm: async () => ({ filters: [{ field: 'secret', op: '=', value: 1 }] }) }).listen(0, '127.0.0.1');
  await new Promise((r) => srv2.once('listening', r));
  const b2 = `http://127.0.0.1:${srv2.address().port}`;
  const t = (await (await fetch(b2 + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@demo.test', password: 'pw-test-123' }) })).json()).token;
  const r = await (await fetch(b2 + '/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + t }, body: JSON.stringify({ q: 'students with fee dues' }) })).json();
  srv2.close();
  assert.equal(r.source, 'rules'); assert.equal(r.count, 1);
  assert.equal((await call('POST', '/api/ask', 'admin', { q: 'tell me a joke' })).status, 422);
});
const CSV = (rows) => 'name,dob,programme,year,guardian_consent\n' + rows.join('\n');
test('admissions: creates roll numbers, holds minors without consent, skips duplicates, rejects bad rows', async () => {
  const body = CSV(['Meera Das,2012-05-05,B.Tech CSE,1,no', 'Asha Rao,2010-02-01,B.Tech CSE,1,yes', 'Tanvi Roy,2004-03-02,MBA,1,no', 'Bad Row,2004-03-02,Law,1,no']);
  const r = await (await call('POST', '/api/admissions/import', 'admin', { csv: body })).json();
  assert.deepEqual([r.created.length, r.held.length, r.rejected.length], [2, 1, 1]);
  assert.match(r.created[0].roll, /^ENG-\d\d-CSE-0001$/); assert.match(r.created[1].roll, /^MBA-\d\d-0001$/);
  const again = await (await call('POST', '/api/admissions/import', 'admin', { csv: body })).json();
  assert.equal(again.created.length, 0); assert.equal(again.duplicates.length, 2);
  assert.equal((await call('POST', '/api/admissions/import', 'faculty', { csv: body })).status, 403);
  assert.equal((await call('POST', '/api/admissions/import', 'admin', { csv: 'a,b' })).status, 400);
});
test('new students with no attendance yet are not flagged at-risk', async () => {
  const risk = await (await call('GET', '/api/at-risk', 'admin')).json();
  assert.ok(!risk.some((s) => s.name === 'Tanvi Roy'));
});
test('fee receipts: payment returns a receipt number and the Tally CSV lists it', async () => {
  const p = await (await call('POST', '/api/fees/pay-mock', 'admin', { roll: 'ENG-24-ME-0177', amount: 1000 })).json();
  assert.match(p.receipt, /^RCPT-\d{6}$/);
  const csv = await (await call('GET', '/api/fees/export.csv', 'admin')).text();
  assert.ok(csv.includes(p.receipt) && csv.includes('Ankit Panda'));
  assert.equal((await call('GET', '/api/fees/export.csv', 'faculty')).status, 403);
});
const leaveBody = (from, to, extra = {}) => ({ type: 'casual', from, to, reason: 'Family function', ...extra });
test('leave: apply, overlap and balance checks, input validation', async () => {
  const ok = await call('POST', '/api/leave', 'faculty', leaveBody('2026-12-01', '2026-12-03'));
  assert.equal(ok.status, 200); assert.equal((await ok.json()).days, 3);
  assert.equal((await call('POST', '/api/leave', 'faculty', leaveBody('2026-12-03', '2026-12-05'))).status, 409);
  assert.equal((await call('POST', '/api/leave', 'faculty', leaveBody('2026-06-01', '2026-06-20'))).status, 409);
  assert.equal((await call('POST', '/api/leave', 'faculty', leaveBody('2026-12-09', '2026-12-08'))).status, 400);
  assert.equal((await call('POST', '/api/leave', 'faculty', leaveBody('2026-12-20', '2027-01-02'))).status, 400);
  assert.equal((await call('POST', '/api/leave', 'admin', leaveBody('2026-12-10', '2026-12-11'))).status, 403);
});
test('leave: only admin decides, once, and decisions are audited', async () => {
  const list = await (await call('GET', '/api/leave', 'admin')).json();
  const id = list.rows[0].id;
  assert.equal((await call('POST', `/api/leave/${id}/decide`, 'faculty', { decision: 'approve' })).status, 403);
  assert.equal((await call('POST', `/api/leave/${id}/decide`, 'admin', { decision: 'maybe' })).status, 400);
  assert.equal((await call('POST', `/api/leave/${id}/decide`, 'admin', { decision: 'approve' })).status, 200);
  assert.equal((await call('POST', `/api/leave/${id}/decide`, 'admin', { decision: 'reject' })).status, 409);
  const mine = await (await call('GET', '/api/leave', 'faculty')).json();
  assert.equal(mine.left, 9);
  assert.ok((await (await call('GET', '/api/audit', 'admin')).json()).some((a) => a.action === 'leave.approve'));
});
test('leave: approved days reduce the balance for later requests', async () => {
  const r = await call('POST', '/api/leave', 'faculty', leaveBody('2026-12-10', '2026-12-20'));
  assert.equal(r.status, 409); assert.match((await r.json()).error, /9 leave day/);
});
test('dashboard: admin only, counts are consistent', async () => {
  assert.equal((await call('GET', '/api/dashboard', 'faculty')).status, 403);
  const d = await (await call('GET', '/api/dashboard', 'admin')).json();
  assert.ok(d.students >= 3 && d.below75 >= 1 && d.totalDue > 0 && d.pendingLeave === 0);
});
test('attendance: marking a period again corrects it (audited); same value is a duplicate', async () => {
  const mk = (id, present) => ({ client_id: id, roll: 'ENG-24-CSE-0412', subject_id: 1, date: '2026-11-05', period: 2, present });
  const sync = async (r) => (await call('POST', '/api/attendance/sync', 'faculty', { records: [r] })).json();
  assert.equal((await sync(mk('corr-aaaa-0001', true))).accepted.length, 1);
  assert.equal((await sync(mk('corr-bbbb-0002', false))).corrected.length, 1);
  assert.equal((await sync(mk('corr-cccc-0003', false))).duplicates.length, 1);
  const log = await (await call('GET', '/api/audit', 'admin')).json();
  assert.ok(log.some((l) => l.action === 'attendance.correct'));
});
test('login ignores capitals and spaces in the email (phone keyboards)', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: '  Faculty@Demo.test ', password: 'pw-test-123' }) });
  assert.equal(r.status, 200);
});
test('subjects: admin creates and assigns, duplicates and bad input refused, faculty cannot create', async () => {
  const mk = (b) => call('POST', '/api/subjects', 'admin', { code: 'CS302', name: 'Algorithms', programme: 'B.Tech CSE', year: 2, faculty_email: 'faculty@demo.test', ...b });
  const ok = await mk({}); assert.equal(ok.status, 200);
  assert.equal((await mk({})).status, 409);
  assert.equal((await mk({ code: 'X9', programme: 'Law' })).status, 400);
  assert.equal((await mk({ code: 'X8', faculty_email: 'nobody@demo.test' })).status, 400);
  assert.equal((await call('POST', '/api/subjects', 'faculty', { code: 'ZZ1' })).status, 403);
  const mine = await (await call('GET', '/api/subjects', 'faculty')).json();
  assert.ok(mine.some((s) => s.code === 'CS302'));
});
test('faculty cannot mark attendance or marks for a subject not assigned to them', async () => {
  const id = (await (await call('POST', '/api/subjects', 'admin', { code: 'ME201', name: 'Thermodynamics', programme: 'B.Tech Mechanical', year: 2 })).json()).id;
  const sync = await (await call('POST', '/api/attendance/sync', 'faculty', { records: [{ client_id: 'nsub-aaaa-0001', roll: 'ENG-24-ME-0177', subject_id: id, date: '2026-11-06', period: 1, present: true }] })).json();
  assert.equal(sync.rejected.length, 1);
  assert.equal((await call('PUT', '/api/marks', 'faculty', { roll: 'ENG-24-ME-0177', subject_id: id, component: 'mid1', score: 10 })).status, 403);
  assert.equal((await call('GET', '/api/marks/' + id, 'faculty')).status, 403);
  assert.equal((await call('GET', '/api/marks/' + id, 'admin')).status, 200);
});
test('marks grid and roster follow enrolment (programme and year), not every student', async () => {
  const subs = await (await call('GET', '/api/subjects', 'faculty')).json();
  const s = subs.find((x) => x.code === 'CS302');
  const g = await (await call('GET', '/api/marks/' + s.id, 'faculty')).json();
  assert.equal(g.rows.length, 3); assert.ok(g.rows.every((r) => r.score === null && r.roll === 'ENG-24-CSE-0412') && g.locked === false);
  assert.equal((await call('PUT', '/api/marks', 'faculty', { roll: 'ENG-24-CSE-0412', subject_id: s.id, component: 'mid1', score: 12 })).status, 200);
  assert.equal((await call('PUT', '/api/marks', 'faculty', { roll: 'MBA-25-0093', subject_id: s.id, component: 'mid1', score: 12 })).status, 404);
  const roster = await (await call('GET', `/api/subjects/${s.id}/students`, 'faculty')).json();
  assert.deepEqual(roster.map((r) => r.roll), ['ENG-24-CSE-0412']);
  const rej = await (await call('POST', '/api/attendance/sync', 'faculty', { records: [{ client_id: 'enrl-aaaa-0001', roll: 'MBA-25-0093', subject_id: s.id, date: '2026-11-06', period: 3, present: true }] })).json();
  assert.equal(rej.rejected.length, 1);
});
test('new subjects and new applicants are enrolled automatically', async () => {
  const id = (await (await call('POST', '/api/subjects', 'admin', { code: 'CS101', name: 'Programming Basics', programme: 'B.Tech CSE', year: 1, faculty_email: 'faculty@demo.test' })).json()).id;
  const r = await (await call('POST', '/api/admissions/import', 'admin', { csv: CSV(['Zoya Khan,2000-01-01,B.Tech CSE,1,no']) })).json();
  assert.equal(r.created.length, 1);
  const roster = await (await call('GET', `/api/subjects/${id}/students`, 'faculty')).json();
  assert.ok(roster.some((x) => x.name === 'Asha Rao') && roster.some((x) => x.name === 'Zoya Khan'));
});
test('at-risk marks reasons are per subject; security headers are set', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff'); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const risk = await (await call('GET', '/api/at-risk', 'admin')).json();
  assert.ok(risk.every((s) => s.reasons.every((x) => !x.includes(':') || /^[A-Z0-9]+: /.test(x))));
});
