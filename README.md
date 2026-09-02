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
- **Comprehensive 43-Field Support:** Basic, Academic, Professional, Contact, Personal, Location, Social, Emergency Contact, and Networking Preferences.
- **Validation Engine:** Real-time checking for required fields, email format, phone format, CGPA numerical ranges, and passing years.
- **4-Priority Duplicate Detection:** Auto-detects duplicates by Student ID > Roll Number > Email > Mobile Number.
- **Duplicate Handling Strategies:** Skip duplicates, update existing profiles, or merge records.
- **Automated Credential Generation:** Each import batch gets a freshly generated temporary password, shown once to the administrator who ran it and stored only as a scrypt hash. Every imported account is flagged to choose its own password at first sign-in.
- **Downloadable Error Report:** Generates `bulk_import_error_report.csv` for invalid rows detailing exact errors & suggested fixes.
- **Import Audit History:** Complete historical log of past import batches (Date, Admin, Total/Success/Failed/Duplicates, Processing Speed).

### 👤 2. Comprehensive 10-Section User Profile System (`My Profile`)
- **10 Profile Sections:**
  1. **Basic & Academic Identity**: Photo, Cover Photo, Full Name, Nickname, Student ID, Roll, Reg No, Batch, Department, Degree, Status, DOB, Gender, Blood Group, Bio.
  2. **Contact & Emergency**: Primary Email, Secondary Email, Mobile, Alt Phone, Emergency Contact Name/Phone/Relation.
  3. **Address & Location**: Present & Permanent Address, Hometown, City, District, Division, Country, Postal Code.
  4. **Academic Record**: Institution Name, Department, Degree, CGPA, Graduation Year, Admission Year, Student Clubs, Scholarships, Awards, Publications.
  5. **Professional & CV**: Current Company, Job Title, Employment Type, Industry, Experience, Previous Companies, Skills, Certifications, Resume/CV Upload, Portfolio.
  6. **Networking & Hiring**: Open to Mentor, Looking for Job, Actively Hiring, Startup Collaboration, Freelancing, Speaking.
  7. **Social Profiles**: LinkedIn, Facebook, GitHub, X (Twitter), Instagram, YouTube, Behance, Dribbble, Medium, Kaggle, Stack Overflow, Custom Links.
  8. **Skills & Interests**: Technical Skills, Soft Skills, Languages, Hobbies, Sports, Volunteer Work, Areas of Interest.
  9. **Granular Privacy Controls**: Select field-level visibility (*Public*, *Alumni Only*, *Same Batch*, *Connections*, *Teachers*, *Private*).
  10. **Admin Custom Fields**: Dynamic no-code custom field builder for administrators to add new profile schema fields on the fly.
- **Verification Badges:** Display verification status pills (Email Verified ✓, Phone Verified ✓, Student ID Verified ✓, Alumni Board Verified ✓).

---

## 🔐 5-Level Role-Based Access Control (RBAC)

| Role Level | Role Title | Access Rights & Dashboard View |
|---|---|---|
| **Level 1** | **Alumni** | Profile completion, Networking, Directory, Mentorship, Events, Jobs, Career Tracker, DIC News & Live Polls. |
| **Level 2** | **Moderator** | **Moderator Dashboard**: Pending profile approvals queue, reported posts, content moderation tools. |
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
unless both of these are set:

| Variable | Why it is mandatory |
|---|---|
| `SESSION_SECRET` | Signs session tokens. Without it the server invents one per boot, so every user is signed out on each restart — and on every serverless cold start. |
| `ENCRYPTION_KEY` | 64 hex characters. Encrypts NID/BRC identity records (AES-256-GCM) and signs event ticket QR codes. Without it the identity vault and ticketing both refuse to operate rather than degrade silently. |

Generate either with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep `ENCRYPTION_KEY` backed up somewhere durable. Identity-vault records are
encrypted with it and cannot be recovered if it is lost.

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
