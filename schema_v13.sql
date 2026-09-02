-- ============================================================
-- DIC ALUMNI PLATFORM — SCHEMA v13  (real location system)
--
-- Additive and idempotent. Creates a controlled place table, points
-- alumni_profiles at it, and marks every location that predates this
-- migration as unconfirmed.
--
-- Coordinates live on PLACES, never on people. There is no latitude or
-- longitude column on alumni_profiles and this migration does not add one:
-- a city's coordinates are public knowledge and reveal nothing about an
-- individual, while a person's do.
-- ============================================================

CREATE TABLE IF NOT EXISTS location_places (
    id           SERIAL PRIMARY KEY,
    country_code CHAR(2)      NOT NULL,
    country      VARCHAR(100) NOT NULL,
    division     VARCHAR(100),          -- division / state / province
    district     VARCHAR(100),
    city         VARCHAR(100) NOT NULL,
    latitude     NUMERIC(8,5) NOT NULL, -- of the CITY, not of any person
    longitude    NUMERIC(8,5) NOT NULL,
    is_active    BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- One row per city per country. Cities may share a name across countries
-- (e.g. multiple Londons), so the country is part of the key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_places_country_city
    ON location_places (country_code, LOWER(city));
CREATE INDEX IF NOT EXISTS idx_places_country  ON location_places (country_code);
CREATE INDEX IF NOT EXISTS idx_places_division ON location_places (country_code, division);

-- Structured current location. Free-text city/country are retained untouched:
-- they are the only record of what the old system stored, and destroying them
-- would destroy the evidence that it was fabricated.
ALTER TABLE alumni_profiles ADD COLUMN IF NOT EXISTS place_id INTEGER
    REFERENCES location_places(id) ON DELETE SET NULL;

/* Every location written before this migration came from a hardcoded literal
   in the registration and bulk-import INSERTs, not from the alumnus. It cannot
   be told apart from a genuine value by inspection, so it is flagged rather
   than trusted, deleted, or silently promoted to structured data. */
ALTER TABLE alumni_profiles ADD COLUMN IF NOT EXISTS location_needs_confirmation
    BOOLEAN NOT NULL DEFAULT FALSE;

/* alumni_profiles.country carried DEFAULT 'Bangladesh'.

   Removing the hardcoded 'Dhaka','Bangladesh' from the registration and import
   INSERTs was not enough on its own: with the column default in place, an
   INSERT that simply omits `country` still records Bangladesh. The fabrication
   would have moved from the query into the schema, where it is harder to see
   and no code review would catch it.

   Existing values are left exactly as they are — this drops the default for
   future rows, it does not rewrite a single stored one. */
ALTER TABLE alumni_profiles ALTER COLUMN country DROP DEFAULT;

CREATE INDEX IF NOT EXISTS idx_profiles_place ON alumni_profiles (place_id);
CREATE INDEX IF NOT EXISTS idx_profiles_loc_confirm
    ON alumni_profiles (location_needs_confirmation) WHERE location_needs_confirmation;

-- Reference places. Coordinates are the conventional city-centre values.
INSERT INTO location_places (country_code, country, division, district, city, latitude, longitude) VALUES
  ('BD','Bangladesh','Dhaka','Dhaka','Dhaka',23.81030,90.41250),
  ('BD','Bangladesh','Dhaka','Gazipur','Gazipur',23.99990,90.42030),
  ('BD','Bangladesh','Dhaka','Narayanganj','Narayanganj',23.62380,90.50000),
  ('BD','Bangladesh','Dhaka','Tangail','Tangail',24.25130,89.91670),
  ('BD','Bangladesh','Dhaka','Kishoreganj','Kishoreganj',24.44490,90.77660),
  ('BD','Bangladesh','Dhaka','Faridpur','Faridpur',23.60700,89.84290),
  ('BD','Bangladesh','Chattogram','Chattogram','Chattogram',22.35690,91.78320),
  ('BD','Bangladesh','Chattogram','Cumilla','Cumilla',23.46070,91.18090),
  ('BD','Bangladesh','Chattogram','Cox''s Bazar','Cox''s Bazar',21.42720,92.00580),
  ('BD','Bangladesh','Chattogram','Noakhali','Noakhali',22.86960,91.09950),
  ('BD','Bangladesh','Chattogram','Feni','Feni',23.01590,91.39760),
  ('BD','Bangladesh','Chattogram','Brahmanbaria','Brahmanbaria',23.95710,91.11190),
  ('BD','Bangladesh','Chattogram','Chandpur','Chandpur',23.23330,90.67120),
  ('BD','Bangladesh','Khulna','Khulna','Khulna',22.84560,89.54030),
  ('BD','Bangladesh','Khulna','Jashore','Jashore',23.16640,89.20810),
  ('BD','Bangladesh','Khulna','Kushtia','Kushtia',23.90130,89.12060),
  ('BD','Bangladesh','Khulna','Satkhira','Satkhira',22.71850,89.07050),
  ('BD','Bangladesh','Rajshahi','Rajshahi','Rajshahi',24.37450,88.60420),
  ('BD','Bangladesh','Rajshahi','Bogura','Bogura',24.84650,89.37730),
  ('BD','Bangladesh','Rajshahi','Pabna','Pabna',24.00640,89.23720),
  ('BD','Bangladesh','Rajshahi','Sirajganj','Sirajganj',24.45330,89.70060),
  ('BD','Bangladesh','Sylhet','Sylhet','Sylhet',24.89490,91.86870),
  ('BD','Bangladesh','Sylhet','Moulvibazar','Moulvibazar',24.48290,91.77740),
  ('BD','Bangladesh','Sylhet','Habiganj','Habiganj',24.37450,91.41550),
  ('BD','Bangladesh','Barishal','Barishal','Barishal',22.70100,90.35350),
  ('BD','Bangladesh','Barishal','Patuakhali','Patuakhali',22.35960,90.32980),
  ('BD','Bangladesh','Rangpur','Rangpur','Rangpur',25.74390,89.27520),
  ('BD','Bangladesh','Rangpur','Dinajpur','Dinajpur',25.62170,88.63540),
  ('BD','Bangladesh','Mymensingh','Mymensingh','Mymensingh',24.74710,90.42030),
  ('BD','Bangladesh','Mymensingh','Jamalpur','Jamalpur',24.93750,89.93780),
  ('GB','United Kingdom','England',NULL,'London',51.50740,-0.12780),
  ('GB','United Kingdom','England',NULL,'Manchester',53.48080,-2.24260),
  ('GB','United Kingdom','England',NULL,'Birmingham',52.48620,-1.89040),
  ('GB','United Kingdom','Scotland',NULL,'Edinburgh',55.95330,-3.18830),
  ('US','United States','New York',NULL,'New York',40.71280,-74.00600),
  ('US','United States','California',NULL,'Los Angeles',34.05220,-118.24370),
  ('US','United States','California',NULL,'San Francisco',37.77490,-122.41940),
  ('US','United States','Illinois',NULL,'Chicago',41.87810,-87.62980),
  ('US','United States','Texas',NULL,'Houston',29.76040,-95.36980),
  ('US','United States','Massachusetts',NULL,'Boston',42.36010,-71.05890),
  ('US','United States','Washington',NULL,'Seattle',47.60620,-122.33210),
  ('US','United States','District of Columbia',NULL,'Washington',38.90720,-77.03690),
  ('CA','Canada','Ontario',NULL,'Toronto',43.65320,-79.38320),
  ('CA','Canada','British Columbia',NULL,'Vancouver',49.28270,-123.12070),
  ('CA','Canada','Quebec',NULL,'Montreal',45.50170,-73.56730),
  ('CA','Canada','Alberta',NULL,'Calgary',51.04470,-114.07190),
  ('AU','Australia','New South Wales',NULL,'Sydney',-33.86880,151.20930),
  ('AU','Australia','Victoria',NULL,'Melbourne',-37.81360,144.96310),
  ('AU','Australia','Queensland',NULL,'Brisbane',-27.46980,153.02510),
  ('AU','Australia','Western Australia',NULL,'Perth',-31.95050,115.86050),
  ('AE','United Arab Emirates',NULL,NULL,'Dubai',25.20480,55.27080),
  ('AE','United Arab Emirates',NULL,NULL,'Abu Dhabi',24.45390,54.37730),
  ('QA','Qatar',NULL,NULL,'Doha',25.28540,51.53100),
  ('SA','Saudi Arabia',NULL,NULL,'Riyadh',24.71360,46.67530),
  ('SA','Saudi Arabia',NULL,NULL,'Jeddah',21.48580,39.19250),
  ('KW','Kuwait',NULL,NULL,'Kuwait City',29.37590,47.97740),
  ('OM','Oman',NULL,NULL,'Muscat',23.58800,58.38290),
  ('BH','Bahrain',NULL,NULL,'Manama',26.22850,50.58600),
  ('MY','Malaysia',NULL,NULL,'Kuala Lumpur',3.13900,101.68690),
  ('SG','Singapore',NULL,NULL,'Singapore',1.35210,103.81980),
  ('JP','Japan',NULL,NULL,'Tokyo',35.67620,139.65030),
  ('KR','South Korea',NULL,NULL,'Seoul',37.56650,126.97800),
  ('CN','China',NULL,NULL,'Beijing',39.90420,116.40740),
  ('CN','China',NULL,NULL,'Shanghai',31.23040,121.47370),
  ('HK','Hong Kong',NULL,NULL,'Hong Kong',22.31930,114.16940),
  ('IN','India','Delhi',NULL,'New Delhi',28.61390,77.20900),
  ('IN','India','West Bengal',NULL,'Kolkata',22.57260,88.36390),
  ('IN','India','Maharashtra',NULL,'Mumbai',19.07600,72.87770),
  ('IN','India','Karnataka',NULL,'Bengaluru',12.97160,77.59460),
  ('PK','Pakistan','Sindh',NULL,'Karachi',24.86070,67.00110),
  ('PK','Pakistan','Punjab',NULL,'Lahore',31.52040,74.35870),
  ('PK','Pakistan','Islamabad',NULL,'Islamabad',33.68440,73.04790),
  ('DE','Germany',NULL,NULL,'Berlin',52.52000,13.40500),
  ('DE','Germany',NULL,NULL,'Munich',48.13510,11.58200),
  ('FR','France',NULL,NULL,'Paris',48.85660,2.35220),
  ('IT','Italy',NULL,NULL,'Rome',41.90280,12.49640),
  ('ES','Spain',NULL,NULL,'Madrid',40.41680,-3.70380),
  ('PT','Portugal',NULL,NULL,'Lisbon',38.72230,-9.13930),
  ('NL','Netherlands',NULL,NULL,'Amsterdam',52.36760,4.90410),
  ('BE','Belgium',NULL,NULL,'Brussels',50.85030,4.35170),
  ('IE','Ireland',NULL,NULL,'Dublin',53.34980,-6.26030),
  ('SE','Sweden',NULL,NULL,'Stockholm',59.32930,18.06860),
  ('NO','Norway',NULL,NULL,'Oslo',59.91390,10.75220),
  ('DK','Denmark',NULL,NULL,'Copenhagen',55.67610,12.56830),
  ('FI','Finland',NULL,NULL,'Helsinki',60.16990,24.93840),
  ('CH','Switzerland',NULL,NULL,'Zurich',47.37690,8.54170),
  ('AT','Austria',NULL,NULL,'Vienna',48.20820,16.37380),
  ('PL','Poland',NULL,NULL,'Warsaw',52.22970,21.01220),
  ('TR','Turkey',NULL,NULL,'Istanbul',41.00820,28.97840),
  ('TH','Thailand',NULL,NULL,'Bangkok',13.75630,100.50180),
  ('ID','Indonesia',NULL,NULL,'Jakarta',-6.20880,106.84560),
  ('PH','Philippines',NULL,NULL,'Manila',14.59950,120.98420),
  ('NZ','New Zealand',NULL,NULL,'Auckland',-36.84850,174.76330),
  ('ZA','South Africa',NULL,NULL,'Johannesburg',-26.20410,28.04730),
  ('EG','Egypt',NULL,NULL,'Cairo',30.04440,31.23570),
  ('KE','Kenya',NULL,NULL,'Nairobi',-1.28640,36.81720),
  ('NG','Nigeria',NULL,NULL,'Lagos',6.52440,3.37920),
  ('BR','Brazil',NULL,NULL,'Sao Paulo',-23.55050,-46.63330),
  ('MX','Mexico',NULL,NULL,'Mexico City',19.43260,-99.13320)
ON CONFLICT DO NOTHING;

/* Flag pre-existing locations as unconfirmed. Scoped to rows that actually
   carry a location, and only where the flag has not already been set, so
   re-running changes nothing and a confirmation is never undone. */
UPDATE alumni_profiles
   SET location_needs_confirmation = TRUE
 WHERE place_id IS NULL
   AND location_needs_confirmation = FALSE
   AND (COALESCE(city, '') <> '' OR COALESCE(country, '') <> '');
