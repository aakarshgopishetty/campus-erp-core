# Campus ERP core

One-campus slice of a college ERP: offline mobile attendance with safe sync, internal marks with a moderation lock and audit log, fee dues with test payments, admissions import, staff leave, a campus dashboard and a read-only question assistant.

- Stack: Node 22+ (built-in SQLite), Express, a single-file mobile-first web app.
- Run locally: see `deployment.md`. Short version: `npm install`, `npm test`, set `SESSION_SECRET`, `npm start`, open http://localhost:3000.
- Live demo and demo logins: see `deployment.md`.
- Design write-up: the Technical Design Document submitted with this project.
