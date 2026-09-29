-- ============================================================
-- DATABASE 2: dot_registry (SEPARATE from main THEMBA DB)
--
-- Simulated Department of Transport driver-licensing lookup.
-- THEMBA must never JOIN this schema from the main app DB.
-- Access only via adapter: verify_driver(id_number, license_number).
-- ============================================================

CREATE TABLE licensed_drivers (
    record_id             SERIAL PRIMARY KEY,
    id_number             TEXT NOT NULL UNIQUE,
    first_name            TEXT NOT NULL,
    last_name             TEXT NOT NULL,
    license_number        TEXT NOT NULL UNIQUE,
    license_class         TEXT NOT NULL,
    pdp_number            TEXT,
    pdp_valid_until       DATE,
    license_status        TEXT NOT NULL
        CHECK (license_status IN ('valid', 'suspended', 'expired', 'revoked')),
    issued_date           DATE NOT NULL,
    license_expiry_date   DATE NOT NULL
);
