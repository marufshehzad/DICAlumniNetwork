-- ============================================================
-- DAFFODIL INTERNATIONAL COLLEGE (DIC) ALUMNI PLATFORM
-- PostgreSQL Database Seed Script
-- ============================================================

-- 1. SEED RBAC USERS
INSERT INTO users (id, email, password_hash, full_name, initials, role, role_label, department, icon, is_verified)
VALUES 
  (1, 'admin@dic.edu.bd', 'LOCKED$run-rotate_credentials.js', 'Super Admin', 'SA', 'super_admin', 'Super Admin', 'System & Security', '👑', true),
  (2, 'collegeadmin@dic.edu.bd', 'LOCKED$run-rotate_credentials.js', 'College Admin', 'CA', 'univ_admin', 'College Admin', 'DIC Administration', '🏛', true),
  (3, 'departmentadmin@dic.edu.bd', 'LOCKED$run-rotate_credentials.js', 'Dr. Shahabuddin', 'DA', 'dept_admin', 'Dept Admin (CSE)', 'CSE Department', '🏢', true),
  (4, 'moderator@dic.edu.bd', 'LOCKED$run-rotate_credentials.js', 'Content Moderator', 'CM', 'moderator', 'Moderator', 'DIC Community', '🛡', true),
  (5, 'alumni@dic.edu.bd', 'LOCKED$run-rotate_credentials.js', 'Mohiuddin Rahman', 'MR', 'alumni', 'Alumni Member', 'BSc CSE (2020)', '🎓', true)
ON CONFLICT (id) DO NOTHING;

SELECT setval('users_id_seq', (SELECT MAX(id) FROM users));

-- 2. SEED ALUMNI PROFILES
INSERT INTO alumni_profiles (
  user_id, student_id, roll_number, registration_number, batch, passing_year, department, program, section_code,
  current_status, dob, gender, blood_group, bio, primary_email, secondary_email, mobile_number, alt_mobile,
  emergency_name, emergency_phone, emergency_relation, present_address, permanent_address, hometown, city, district,
  division, country, postal_code, degree, cgpa, admission_year, clubs, scholarship, awards, publications,
  current_company, job_title, employment_type, industry, years_experience, skills, certifications,
  looking_for_job, hiring, can_mentor, looking_for_mentor, collaboration, linkedin, facebook, github, twitter, website, color
) VALUES
  (
    5, 'DIC-2020-0847', '847', 'REG-2020-0847', 2020, 2020, 'Computer Science & Engineering', 'BSc CSE', 'A',
    'Alumni & Tech Lead', '1998-08-14', 'Male', 'O+', 'Full-stack software architect specializing in cloud systems, React, Node.js, and enterprise security.',
    'mohiuddin@dic.edu.bd', 'mohiuddin.dev@gmail.com', '+880 1712-345678', '+880 1812-345678',
    'Abdur Rahman', '+880 1912-345678', 'Father', 'House 42, Road 11, Dhanmondi, Dhaka-1209', 'Comilla, Bangladesh',
    'Comilla', 'Dhaka', 'Comilla', 'Chittagong', 'Bangladesh', '1209', 'BSc in Computer Science & Engineering', '3.92 / 4.00', 2016,
    'DIC Computer Club (President), Robotics Club', 'DIC Chairman Merit Scholarship (100% Waiver)', '1st Runner Up - National Programming Contest 2019',
    'AI-Based Crop Disease Detection (IEEE 2020)', 'Brain Station 23', 'Senior Software Engineer', 'Full-time',
    'Software & Tech', '5 Years', 'React, Node.js, PostgreSQL, AWS, Docker', 'AWS Certified Solutions Architect',
    false, true, true, false, true, 'https://linkedin.com/in/mohiuddin-rahman', 'https://facebook.com/mohiuddin.dic', 'https://github.com/mohiuddin-dic', 'https://x.com/mohiuddin_dev', 'https://mohiuddin.dev', '#00A859'
  )
ON CONFLICT (student_id) DO NOTHING;

-- 3. SEED CHAPTERS
INSERT INTO chapters (id, name, type, icon, description, members_count, events_count, parent_id, status)
VALUES
  (1, 'DIC Main Campus Chapter', 'regional', '🏫', 'Official main campus alumni chapter', 18420, 14, NULL, 'approved'),
  (2, 'DIC Dhanmondi Branch Alumni', 'regional', '🌆', 'Dhanmondi campus alumni network', 12400, 8, NULL, 'approved'),
  (3, 'DIC CSE Alumni Association', 'interest', '💻', 'Computer Science & Engineering alumni', 6210, 18, NULL, 'approved'),
  (4, 'DIC SWE Engineers Club', 'interest', '🚀', 'Software Engineering graduates club', 4120, 12, NULL, 'approved'),
  (5, 'DIC UK & Europe Alumni', 'regional', '🇬🇧', 'United Kingdom & European alumni network', 840, 5, NULL, 'approved')
ON CONFLICT (id) DO NOTHING;

SELECT setval('chapters_id_seq', (SELECT MAX(id) FROM chapters));

-- 4. SEED STORIES (NEWS FEED)
INSERT INTO stories (id, emoji, category, title, excerpt, content, author_name, status, published_date)
VALUES
  (1, '🌟', 'DIC Spotlight', 'DIC Alumna Appointed AI Research Lead at Google DeepMind', 'Liana Choudhury (CSE Batch 2018) has been appointed AI Research Lead. She credits DIC''s hands-on lab environment and mentorship program.', 'Full article content about Liana''s journey from DIC to Google DeepMind...', 'DIC Press Office', 'published', '28 Jul 2026'),
  (2, '🏆', 'Achievement', 'DIC Ranks #1 College in Computer Science Innovation 2026', 'Daffodil International College achieved top research output in computer science and software engineering in the national index.', 'Full achievement breakdown...', 'DIC Academic Council', 'published', '24 Jul 2026')
ON CONFLICT (id) DO NOTHING;

SELECT setval('stories_id_seq', (SELECT MAX(id) FROM stories));

-- 5. SEED JOBS
INSERT INTO jobs (id, emoji, title, company, salary, type, location, posted_by_name, batch, tags, days_ago)
VALUES
  (1, '💻', 'Senior Backend Engineer', 'Brain Station 23', '৳1.8L/mo', 'fulltime', 'Dhaka', 'Tanvir Ahmed', 2017, ARRAY['Node.js', 'PostgreSQL', 'AWS'], 2),
  (2, '📊', 'Data Scientist', 'Pathao', '৳1.4L/mo', 'fulltime', 'Dhaka', 'Arif Hossain', 2018, ARRAY['Python', 'Machine Learning'], 4),
  (3, '🎨', 'UI/UX Design Intern', 'SSL Wireless', '৳25K/mo', 'internship', 'Dhaka', 'Priya Das', 2021, ARRAY['Figma', 'UX'], 1)
ON CONFLICT (id) DO NOTHING;

SELECT setval('jobs_id_seq', (SELECT MAX(id) FROM jobs));

-- 6. SEED EVENTS
INSERT INTO events (id, emoji, title, event_date, event_time, venue, capacity, registered_count, price, status, type)
VALUES
  (1, '🎓', 'DIC 10th Annual Reunion 2026', 'Aug 15, 2026', '6:00 PM', 'DIC Main Auditorium', 2000, 1840, '৳500', 'upcoming', 'Gala'),
  (2, '💼', 'DIC CSE & SWE Job Fair Q3', 'Aug 22, 2026', '10:00 AM', 'DIC Campus Center', 1200, 890, 'Free', 'upcoming', 'Professional'),
  (3, '🚀', 'DIC AI & Cloud Tech Symposium', 'Aug 30, 2026', '9:00 AM', 'DIC International Hall', 400, 395, '৳300', 'upcoming', 'Conference')
ON CONFLICT (id) DO NOTHING;

SELECT setval('events_id_seq', (SELECT MAX(id) FROM events));

-- 7. SEED CAMPAIGNS
INSERT INTO campaigns (id, name, description, tag, raised_amount, goal_amount, donors_count, days_left, gateways)
VALUES
  (1, 'DIC Merit Scholarship Fund 2026', 'Provide full tuition scholarships to 50 meritorious DIC students from underprivileged backgrounds.', 'scholarship', 1840000, 2500000, 342, 18, ARRAY['bkash', 'nagad', 'card']),
  (2, 'DIC Smart Robotics Lab Fund', 'Equip the campus robotics laboratory with modern research-grade instruments and microcontrollers.', 'infrastructure', 680000, 1200000, 189, 31, ARRAY['bkash', 'nagad', 'rocket']),
  (3, 'DIC Entrepreneurship Seed Fund', 'Launch a startup incubator at DIC providing seed funding and mentorship for student tech startups.', 'education', 920000, 1500000, 210, 45, ARRAY['bkash', 'card'])
ON CONFLICT (id) DO NOTHING;

SELECT setval('campaigns_id_seq', (SELECT MAX(id) FROM campaigns));

-- 8. SEED NOTIFICATIONS
INSERT INTO notifications (id, user_id, target_role, icon, title, subtitle, is_unread)
VALUES
  (1, 5, 'alumni', '🤝', 'Mentorship Accepted', 'Fatima Khanam accepted your connection', true),
  (2, 5, 'alumni', '💰', 'Donation Receipt', 'Your ৳5,000 to DIC Merit Fund confirmed', true)
ON CONFLICT (id) DO NOTHING;

SELECT setval('notifications_id_seq', (SELECT MAX(id) FROM notifications));

-- 9. SEED CUSTOM FIELDS
INSERT INTO custom_fields (id, label, section, field_type, is_required)
VALUES
  ('cf_1', 'Research Publications', 'academic', 'text', false),
  ('cf_2', 'Scholarship / Award Name', 'academic', 'text', false),
  ('cf_3', 'Startup Pitch Deck / Video Link', 'networking', 'url', false)
ON CONFLICT (id) DO NOTHING;

-- 10. SEED EVENT PLANNER WORKSPACE DATA
INSERT INTO event_proposals (id, name, description, objectives, outcomes, category, type, department, organizer_name, owner_id, target_audience, expected_attendance, venue, event_date, duration, status)
VALUES
  (1, 'DIC 10th Annual Reunion & Tech Gala 2026', 'Comprehensive 10th anniversary alumni reunion featuring keynotes, networking gala, career fair, and fundraising drive.', 'Foster alumni-student mentorship, raise scholarship funds, and showcase DIC computer science achievements.', '500+ attendees, ৳10L+ raised for scholarships, 50+ mentorship connections created.', 'Alumni Gala', 'Reunion & Gala', 'Computer Science & Engineering', 'DIC Alumni Relations & Executive Board', 1, 'DIC Graduates 2010-2026, Faculty, Industry Partners', 2000, 'DIC Main Campus Auditorium & International Hall', 'Aug 15, 2026', '8 Hours', 'approved')
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_proposals_id_seq', (SELECT MAX(id) FROM event_proposals));

INSERT INTO event_budgets (id, event_id, category, estimated_cost, actual_cost, vendor_name, status, payment_status)
VALUES
  (1, 1, 'Venue & Hall Rental', 150000, 140000, 'DIC Campus Operations', 'approved', 'paid'),
  (2, 1, 'Stage & LED Screen Setup', 180000, 185000, 'Dhaka Event Tech Ltd', 'approved', 'paid'),
  (3, 1, 'Catering & Buffet Food (2000 pax)', 350000, 340000, 'Grand Prince Catering', 'approved', 'paid'),
  (4, 1, 'Photography & 4K Video Crew', 80000, 75000, 'Cinematic Studio BD', 'approved', 'paid'),
  (5, 1, 'Security & Medical First Aid Team', 50000, 48000, 'Elite Security Services', 'approved', 'paid'),
  (6, 1, 'Merchandise & Printed Welcome Kits', 120000, 115000, 'PressCraft Printers', 'approved', 'paid')
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_budgets_id_seq', (SELECT MAX(id) FROM event_budgets));

INSERT INTO event_sponsors (id, event_id, company, contact_person, email, phone, package_tier, contribution_amount, pipeline_status, deliverables)
VALUES
  (1, 1, 'Brain Station 23', 'Tanvir Ahmed', 'tanvir@brainstation23.com', '+8801711000111', 'title', 500000, 'received', 'Main stage banner branding, keynote session slot, 10 VIP passes'),
  (2, 1, 'bKash Limited', 'Arif Hossain', 'arif.h@bkash.com', '+8801811222333', 'gold', 300000, 'received', 'Ticketing partner branding, booth space in lobby, logo on all badges'),
  (3, 1, 'Pathao Tech', 'Nusrat Rima', 'nusrat@pathao.com', '+8801911333444', 'silver', 150000, 'agreed', 'Rideshare promo codes for attendees, logo in event souvenir booklet'),
  (4, 1, 'SSL Wireless', 'Farhana S', 'farhana@sslcommerz.com', '+8801722444555', 'bronze', 100000, 'proposed', 'SMS gateway sponsorship, digital certificate portal branding')
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_sponsors_id_seq', (SELECT MAX(id) FROM event_sponsors));

INSERT INTO event_committees (id, event_id, name, leader_name, members_count, budget_allocated)
VALUES
  (1, 1, 'Finance & Sponsorship', 'Super Admin (Mohiuddin)', 4, 250000),
  (2, 1, 'Marketing & Media', 'Nusrat Jahan', 6, 150000),
  (3, 1, 'Logistics & Stage', 'Rafiqul Islam', 8, 300000),
  (4, 1, 'Security & Volunteers', 'Imtiaz Ahmed', 12, 100000)
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_committees_id_seq', (SELECT MAX(id) FROM event_committees));

INSERT INTO event_tasks (id, event_id, committee_name, title, description, priority, status, assigned_to, deadline)
VALUES
  (1, 1, 'Finance & Sponsorship', 'Finalize Title Sponsor Agreement with Brain Station 23', 'Confirm ৳5L fund transfer & deliver branding package details.', 'critical', 'completed', 'Super Admin', 'Aug 01, 2026'),
  (2, 1, 'Logistics & Stage', 'Book Auditorium & Confirm Sound/Lighting Quotation', 'Inspect main stage LED screen resolution & wireless mics.', 'high', 'completed', 'Rafiqul Islam', 'Aug 05, 2026'),
  (3, 1, 'Marketing & Media', 'Launch Social Media Campaign & Press Release', 'Post countdown teasers across Facebook, LinkedIn & SMS broadcast.', 'medium', 'in_progress', 'Nusrat Jahan', 'Aug 10, 2026'),
  (4, 1, 'Security & Volunteers', 'Assign 25 Volunteers to Check-In & VIP Security Duties', 'Conduct briefing session and issue high-vis badges & walkie-talkies.', 'high', 'todo', 'Imtiaz Ahmed', 'Aug 12, 2026'),
  (5, 1, 'Logistics & Stage', 'Receive 500 Printed Welcome Gift Boxes & Lanyards', 'Verify quality of printed T-shirts and souvenirs from printer.', 'low', 'blocked', 'Rafiqul Islam', 'Aug 13, 2026')
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_tasks_id_seq', (SELECT MAX(id) FROM event_tasks));

INSERT INTO event_procurement (id, event_id, item_name, category, quantity, estimated_price, actual_price, vendor_name, delivery_status)
VALUES
  (1, 1, 'Custom Alumni Welcome T-Shirts', 'Merchandise', 500, 100000, 95000, 'PressCraft Printers', 'delivered'),
  (2, 1, 'Lanyards & Anti-Spoof QR ID Badges', 'Branding', 600, 25000, 24000, 'PressCraft Printers', 'delivered'),
  (3, 1, 'VIP Flowers & Recognition Crests', 'Decorations', 20, 15000, 14500, 'Flower Garden BD', 'ordered'),
  (4, 1, 'Stage Backdrop Banners (20x10ft)', 'Branding', 4, 18000, 18000, 'Dhaka Sign & Print', 'delivered')
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_procurement_id_seq', (SELECT MAX(id) FROM event_procurement));

INSERT INTO event_volunteers (id, event_id, volunteer_name, shift_time, assigned_committee, attendance_status, certificate_issued)
VALUES
  (1, 1, 'Tanvir Ahmed', '8:00 AM - 1:00 PM', 'Registration & Check-In', 'checked_in', true),
  (2, 1, 'Farhana Sultana', '12:00 PM - 5:00 PM', 'Hospitality & VIP Lounge', 'checked_in', true),
  (3, 1, 'Sabbir Rahman', '8:00 AM - 4:00 PM', 'Stage & Tech Support', 'assigned', false),
  (4, 1, 'Mariam Begum', '2:00 PM - 8:00 PM', 'Food & Refreshment Distribution', 'assigned', false)
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_volunteers_id_seq', (SELECT MAX(id) FROM event_volunteers));

INSERT INTO event_risks (id, event_id, risk_title, category, severity, contingency_plan)
VALUES
  (1, 1, 'Monsoon Heavy Rainfall / Weather Disruption', 'Weather', 'high', 'All outdoor networking booths shifted to indoor Air-Conditioned Multipurpose Gymnasium. Covered canopy walkways installed.'),
  (2, 1, 'Main Power Grid Failure during Evening Keynote', 'Technical', 'high', 'Auto-synchronizing 250kVA standby diesel generator connected with zero-downtime UPS for stage sound & LED displays.'),
  (3, 1, 'Peak Hour Traffic Congestion around Campus Entrance', 'Security', 'medium', 'Coordinated with Dhaka Metropolitan Traffic Police. Reserved 300 additional parking spots at nearby DIC Annex Building.')
ON CONFLICT (id) DO NOTHING;

SELECT setval('event_risks_id_seq', (SELECT MAX(id) FROM event_risks));

