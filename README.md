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
- **Supported Formats:** CSV (`.csv`), Microsoft Excel (`.xlsx`, `.xls`).
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

```bash
# Start local web server
python3 -m http.server 8000
```
Then visit **`http://localhost:8000`** in your browser.
