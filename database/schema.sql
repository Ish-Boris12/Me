CREATE TABLE IF NOT EXISTS service_requests (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 100),
    phone TEXT NOT NULL CHECK (length(phone) BETWEEN 7 AND 30),
    service TEXT NOT NULL CHECK (service IN (
        'Farm & goods transport',
        'Farm support',
        'Market access'
    )),
    details TEXT NOT NULL DEFAULT '' CHECK (length(details) <= 2000),
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS service_requests_created_at_idx
    ON service_requests (created_at);

CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);
