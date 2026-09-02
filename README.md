# 🎓 Daffodil International College (DIC) Alumni Platform

> **Institution:** Daffodil International College (DIC)  
> **Architecture:** Single-Institution Enterprise Platform  
> **Security & RBAC:** 5-Level Role-Based Access Control (Alumni, Moderator, Department Admin, College Admin, Super Admin)  
> **Design System:** Dark Glassmorphic Mobile-First · DIC Green (`#00A859`) & DIC Blue (`#005691`)  
> **Compliance:** PDPA 2026 (Personal Data Protection Act) · Cybersecurity Act 2023

---

## 📌 Executive Overview

**DIC Alumni Platform** is the official alumni networking, fundraising, career management, and bulk user import system exclusively built for **Daffodil International College (DIC)**.

---

## 🚀 Key Modules & Features

### 📥 1. Bulk User Import & Automatic Profile Creation (`Admin Panel -> Bulk Import`)
- **Supported Format:** CSV (`.csv`). Excel files are not supported — export to CSV first.
- **Downloadable Sample Template:** Download `sample_alumni_import_template.csv` directly from the admin panel.
- **19 mappable columns:** Full Name and Email (both required), Mobile, HSC Passing Year, HSC Group, HSC Version, Blood Group, Present Address, Permanent Address, Hometown, City, District, Postal Code, Country, Occupation, Organisation, Designation, Photo URL, Facebook. Column headers are auto-detected and any unrecognised column defaults to "do not import", so a new column can never land in the wrong field silently.
- **Location resolution:** City and Country are matched against the reference place list, with documented aliases (Chittagong → Chattogram, UK → United Kingdom). A city that cannot be matched is **reported back by row number** and the row imports without a location — never with a guessed one.
- **Validation:** Full Name and a recoverable email address are required; a row missing either is rejected and listed. A non-four-digit passing year is dropped rather than failing the row. There is no CGPA or phone-format validation.
- **Duplicate detection by email, then mobile number** (last ten digits).
- **Duplicate Handling Strategies:** Skip duplicates, update existing profiles, or merge records.
- **Automated Credential Generation:** Each import batch gets a freshly generated temporary password, shown once to the administrator who ran it and stored only as a scrypt hash. Every imported account is flagged to choose its own password at first sign-in.
- **Downloadable Error Report:** Generates `bulk_import_error_report.csv` for invalid rows detailing exact errors & suggested fixes.
- **Import Audit History:** Complete historical log of past import batches (Date, Admin, Total/Success/Failed/Duplicates, Processing Speed).

### 👤 2. Alumni Profile (`My Profile`)

The profile page presents the following sections. Every field listed here has a
column behind it and is editable or displayed by the running application.

1. **Basic & academic identity** — Profile photo URL, Full Name, Student ID,
   Roll Number, Registration Number, Batch, Passing Year, Department, Program,
   Section, Degree, Current Status, Date of Birth, Gender, Blood Group, Bio.
2. **Contact & emergency** — Primary Email, Secondary Email, Mobile, Alternate
   Mobile, WhatsApp Number, Emergency Contact Name / Phone / Relation.
3. **Address & location** — Present Address, Permanent Address, Hometown,
   **Current City** (chosen from a reference list), District, Division, Country,
   Postal Code. The city is what places an alumnus on the map; see §Location.
4. **Academic record** — CGPA, Admission Year, Clubs, Scholarships, Awards,
   Publications, Certifications.
5. **Professional** — Current Organisation, Job Title, Employment Type,
   Industry, Years of Experience, Occupation, Skills.
6. **Networking & hiring** — Open to Mentor, Looking for a Mentor, Looking for
   Job, Actively Hiring, Open to Collaboration.
7. **Social links** — LinkedIn, Facebook, GitHub, X (Twitter), Website.
8. **Field privacy** — see below.
9. **Admin custom fields** — administrators can define additional profile
   fields from the admin portal.

**Field privacy — exactly what the server enforces.** The contract lives in one
place (`privacy.js`), the browser renders its controls from it, and the read
side gates against it:

| Field | Levels offered | Default | Visible to administrators when private? |
|---|---|---|---|
| Email address | Members / Only me | Members | Yes |
| Mobile number | Members / Only me | Only me | Yes |
| City & country | Members **and on the map** / Members only / Only me | Members only | **No** |

Street address, permanent address, postal code and hometown are **visible only
to their owner**, unconditionally. That is not a setting, and it is deliberate:
the only alternative level would be "share my home address with every member",
which has no legitimate use in an alumni directory.

There is no per-batch, per-connection or per-teacher visibility scoping.

**Verification** is a single administrator-set flag (`is_verified`) shown as one
badge. There are no separate email, phone, student-ID or board verifications.

**Not currently implemented** — listed because earlier drafts of this file
claimed them: cover photo, résumé/CV upload, portfolio, previous companies,
Instagram, YouTube, Behance, Dribbble, Medium, Kaggle, Stack Overflow, custom
link lists, separate soft-skills / languages / hobbies / sports / volunteering
/ interests fields, and per-batch or per-connection privacy scoping. None of
these has a column, an API field or a control.

---

## 🔐 5-Level Role-Based Access Control (RBAC)

| Role Level | Role Title | Access Rights & Dashboard View |
|---|---|---|
| **Level 1** | **Alumni** | Profile, Directory, Connections, Mentorship, Events & tickets, Jobs, Chapters, Donations, Alumni Map, DIC News & Live Polls. |
| **Level 2** | **Moderator** | **Moderator Dashboard**: account verification queue, chapter and story review, event creation and approval, broadcasts. There is no post-reporting or flagged-content system. |
| **Level 3** | **Department Admin** | **Dept Admin Dashboard (CSE/SWE/BBA/EEE)**: Department placement funnel, department verification queue, department announcements. |
| **Level 4** | **College Admin** | **College Command Center**: college-wide alumni figures, engagement trends, college broadcasts, event approval. |
| **Level 5** | **Super Admin** | **Super Admin Control Panel**: Bulk User Import, Dynamic Custom Fields, immutable audit logs, database tools. |

A user's role comes from the `users.role` column and is decided server-side at
sign-in. It cannot be changed from the browser.

### Sign-in credentials

This table used to publish the e-mail address and password of every account,
including Super Admin, and the same values were hardcoded in `app.js`. Both are
gone. Seeded accounts now ship **locked** and cannot sign in until you set a
password:

```bash
node rotate_credentials.js --all      # generate strong passwords for seeded accounts
node rotate_credentials.js --check    # report any account still on a weak password
```

Generated passwords are written once to `admin-credentials.local.txt`
(gitignored) and are never printed to the console. Store them in a password
manager and delete the file. To choose your own instead, set
`ADMIN_PW_SUPER_ADMIN`, `ADMIN_PW_UNIV_ADMIN`, `ADMIN_PW_DEPT_ADMIN` or
`ADMIN_PW_MODERATOR` before running the script — see `.env.example`.

---

## 💻 How to Run Locally

The application is an Express server that talks to PostgreSQL. Serving this
folder with a plain static file server — which is what an earlier version of
this README told you to do — loads the HTML but leaves every screen empty:
there is no API behind it, so nothing signs in and nothing renders.

**1. Start PostgreSQL.** Any reachable instance works. The development setup
used here is a container named `dic-alumni-pg` on port 5433:

```bash
docker start dic-alumni-pg
```

**2. Configure the environment.** Copy `.env.example` to `.env` and fill it in.
Either `DATABASE_URL` (cloud) or the discrete `PGHOST` / `PGPORT` /
`PGDATABASE` / `PGUSER` / `PGPASSWORD` variables (local) will do.

**3. Create the schema and seed it** (first run only):

```bash
node -e "require('./db').initDbSchemaAndSeed()"
```

Then apply the versioned migrations in order:

```bash
node migrate_v2.js && node migrate_v3.js && node migrate_v4.js && node migrate_v5.js && node migrate_v6.js && node migrate_v7.js && node migrate_v8.js && node migrate_v9.js
```

Each migration is additive, transactional and idempotent, and each accepts
`--dry-run` to apply, verify and roll back without committing.

**4. Set the seeded account passwords.** Seeded accounts ship locked and cannot
sign in until you do this:

```bash
node rotate_credentials.js --all
```

**5. Start the server:**

```bash
node server.js
```

Then open **`http://localhost:8000`** for the alumni site, or
**`http://localhost:8000/admin`** for the staff portal.

---

## 🗂 Architecture

| Layer | What it is |
|---|---|
| Frontend | Two static entry points — `index.html` (alumni) and `admin.html` (staff) — loading plain `js/*.js` modules as classic scripts. No framework, no bundler, no build step. |
| Backend | One Express 5 app (`server.js`) mounting `routes_v2.js`, `routes_events.js`, `routes_planner.js`, `routes_admin_users.js` and `routes_compliance.js`. |
| Database | PostgreSQL, accessed with parameterised SQL through `pg`. No ORM. |
| Sessions | HMAC-SHA256 bearer tokens in `localStorage`, 12-hour life, revocable through `users.token_version`. No cookies, no JWT. |
| Deployment | `node server.js` on any host, or one Vercel serverless function via `api/index.js`. |

### The two portals

Both are served by the same process. `/admin` (or a host matching
`ADMIN_ORIGIN`, or any hostname starting `admin.`) serves the staff portal;
everything else serves the alumni site. The two load different module sets, so
staff code and staff data never reach the public bundle. Sessions are separate
per origin because the token lives in that origin's `localStorage`.

To put the staff portal on its own subdomain, point `admin.<your-domain>` at
the same deployment and set both origins:

```bash
PUBLIC_ORIGIN=https://<your-domain>
ADMIN_ORIGIN=https://admin.<your-domain>
```

Those two variables are also the CORS allow-list. No domain is hardcoded
anywhere in the code.

---

## 🔒 Production requirements

The server **refuses to start** when `NODE_ENV=production` (or `VERCEL=1`)
unless all six of these are set, and it names the ones it is missing:

| Variable | Why it is mandatory |
|---|---|
| `SESSION_SECRET` | Signs session tokens. Without it the server invents one per boot, so every user is signed out on each restart — and on every serverless cold start. |
| `ENCRYPTION_KEY` | 64 hex characters. Encrypts NID/BRC identity records (AES-256-GCM) and signs event ticket QR codes. Without it the identity vault and ticketing both refuse to operate rather than degrade silently. |
| `CRON_SECRET` | 32 characters minimum. The scheduler's credential. Without it nothing can trigger the nightly jobs — including the 30-day deletion purge, which is a promise made to every user who asks to be erased. |
| `MAIL_TRANSPORT` | `smtp`, `console` or `none`, chosen explicitly. It has no default: an unset value used to mean `console`, so a deployment that simply forgot the variable printed every password-reset link into its log and believed mail was configured. |
| `PUBLIC_ORIGIN` | The alumni site's origin. Also the CORS allow-list. Unset, the middleware received `undefined` — which is the permissive wildcard, so production answered every origin with `Access-Control-Allow-Origin: *`. |
| `ADMIN_ORIGIN` | The staff portal's origin, and which hostname is served `admin.html`. Set it to the same value as `PUBLIC_ORIGIN` for a single-host deployment; the server then routes the staff portal by path. |

Generate the three secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep `ENCRYPTION_KEY` backed up somewhere durable. Identity-vault records are
encrypted with it and **cannot be recovered if it is lost** — unlike the other
two, which can be rotated freely.

`.env.example` documents every variable, required or not. For the full
deployment sequence see **`PRODUCTION_DEPLOYMENT_RUNBOOK.md`**; for what is
still owed by DIC or a hosting provider, **`PRODUCTION_HANDOVER_CHECKLIST.md`**.

---

## 📍 Location — current position

Alumni location is **city-level and chosen from a reference list**, never typed
free-hand and never observed from a device.

- **No coordinate is stored for any person.** `location_places` holds ~99 cities
  with their coordinates; a profile references a place by id. A city's position
  is public knowledge, a person's is not.
- **No GPS, no browser geolocation, no address geocoding.** `navigator.geolocation`
  appears nowhere in the codebase.
- **The Alumni Map plots aggregate counts per city or country**, drawn from real
  coordinates on an equirectangular projection with a graticule. It uses **no
  map library, no tiles, no API key and no provider** — and therefore shows **no
  country boundaries**. A country badge sits at the alumni-weighted mean of its
  cities, which is a statement about the alumni, not about the country's shape.
- **Only members who set their location visibility to "on the map" are counted.**
  "Members only" appears on a profile but not on the map; "Only me" appears
  nowhere.
- **Locations recorded before this system existed are flagged, not trusted.**
  An earlier version wrote a hardcoded `Dhaka, Bangladesh` into every profile at
  registration and import. Those values are preserved, marked *unconfirmed* in
  the directory, excluded from the map, and only the member can clear the flag
  by choosing their city.

**Planned / not currently implemented:** country boundary rendering, map pan,
chapter locations, and event venue coordinates or directions.

---

## 💳 Payments — current position

**No payment gateway is connected to this platform.** Nothing in the codebase
talks to bKash, Nagad, Rocket, a card processor or any other provider.

What that means in practice:

- **Donations** are recorded as **pledges**. A donor states an intention to
  give; the alumni office confirms the funds separately and marks the pledge
  received, which is the only path to a settled donation. Campaign totals count
  confirmed donations only — pledges are reported separately and never folded
  into "raised".
- **Event tickets** are **free-only online**. A ticket type may carry a price so
  organisers can record what it costs, but alumni cannot register for a priced
  ticket through the site; the alumni office arranges those directly.

Online payment, when it is added, belongs behind a server-verified gateway
callback. Until then the platform does not claim money it has not received.

---

## ✉ Communication

Notifications are **in-app only**. There is no email, SMS or push transport
configured, so:

- Broadcasts are delivered as in-app notifications to the resolved audience.
- Password-reset links cannot be emailed. An operator with server access mints
  one with `node reset_link.js --email <address>`, which writes the link to a
  gitignored file and never prints it to the console.
