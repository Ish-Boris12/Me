const http = require("node:http");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const ROOT = __dirname;
const DEFAULT_DATABASE_FILE = path.join(ROOT, "data", "ib-ltd.sqlite");
const DEFAULT_LEGACY_DATA_FILE = path.join(ROOT, "data", "requests.jsonl");
const SCHEMA_FILE = path.join(ROOT, "database", "schema.sql");
const MAX_BODY_BYTES = 16 * 1024;
const SERVICES = new Set([
    "Farm & goods transport",
    "Farm support",
    "Market access",
]);
const PUBLIC_FILES = new Map([
    ["/", ["Ish.html", "text/html; charset=utf-8"]],
    ["/Ish.html", ["Ish.html", "text/html; charset=utf-8"]],
    ["/Ish.css", ["Ish.css", "text/css; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/assets/images/ib-logo.svg", ["assets/images/ib-logo.svg", "image/svg+xml"]],
]);

class HttpError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function sendJson(response, status, value) {
    response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    response.end(JSON.stringify(value));
}

function readJsonBody(request) {
    return new Promise((resolve, reject) => {
        let size = 0;
        let tooLarge = false;
        const chunks = [];

        request.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                tooLarge = true;
                return;
            }
            chunks.push(chunk);
        });
        request.on("error", reject);
        request.on("end", () => {
            if (tooLarge) {
                reject(new HttpError(413, "Request body is too large.", "REQUEST_TOO_LARGE"));
                return;
            }

            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                reject(new HttpError(400, "Request body must be valid JSON.", "INVALID_JSON"));
            }
        });
    });
}

function validateRequest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new HttpError(400, "Submit a valid service request.", "INVALID_REQUEST");
    }

    const name = typeof value.name === "string" ? value.name.trim() : "";
    const phone = typeof value.phone === "string" ? value.phone.trim() : "";
    const service = typeof value.service === "string" ? value.service.trim() : "";
    const details = typeof value.details === "string" ? value.details.trim() : "";

    if (name.length < 2 || name.length > 100) {
        throw new HttpError(400, "Name must be between 2 and 100 characters.", "INVALID_NAME");
    }
    if (phone.length < 7 || phone.length > 30 || !/^[+0-9().\-\s]+$/.test(phone)) {
        throw new HttpError(400, "Enter a valid phone number.", "INVALID_PHONE");
    }
    if (!SERVICES.has(service)) {
        throw new HttpError(400, "Choose one of the available services.", "INVALID_SERVICE");
    }
    if (details.length > 2000) {
        throw new HttpError(400, "Details must be 2,000 characters or fewer.", "DETAILS_TOO_LONG");
    }

    return {
        id: randomUUID(),
        name,
        phone,
        service,
        details,
        createdAt: new Date().toISOString(),
    };
}

function initializeDatabase(databasePath, legacyDataFile) {
    fsSync.mkdirSync(path.dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(fsSync.readFileSync(SCHEMA_FILE, "utf8"));

    if (!legacyDataFile || !fsSync.existsSync(legacyDataFile)) return database;

    const migration = database.prepare("SELECT name FROM schema_migrations WHERE name = ?").get("import_requests_jsonl");
    if (migration) return database;

    const insertRequest = database.prepare(`
        INSERT OR IGNORE INTO service_requests (id, name, phone, service, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const legacyRows = fsSync.readFileSync(legacyDataFile, "utf8").split(/\r?\n/);

    database.exec("BEGIN IMMEDIATE;");
    try {
        legacyRows.forEach((line, index) => {
            if (!line.trim()) return;

            let record;
            try {
                record = JSON.parse(line);
            } catch (error) {
                throw new Error(`Invalid legacy request on line ${index + 1}.`, { cause: error });
            }

            if (
                !record ||
                typeof record.id !== "string" ||
                typeof record.name !== "string" ||
                typeof record.phone !== "string" ||
                typeof record.service !== "string" ||
                typeof record.createdAt !== "string"
            ) {
                throw new Error(`Legacy request on line ${index + 1} has an invalid shape.`);
            }

            insertRequest.run(
                record.id,
                record.name,
                record.phone,
                record.service,
                typeof record.details === "string" ? record.details : "",
                record.createdAt
            );
        });
        database.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
            "import_requests_jsonl",
            new Date().toISOString()
        );
        database.exec("COMMIT;");
    } catch (error) {
        database.exec("ROLLBACK;");
        database.close();
        throw error;
    }

    return database;
}

function createServer(options = {}) {
    const databasePath = options.databasePath || DEFAULT_DATABASE_FILE;
    const legacyDataFile = Object.prototype.hasOwnProperty.call(options, "legacyDataFile")
        ? options.legacyDataFile
        : DEFAULT_LEGACY_DATA_FILE;
    const database = initializeDatabase(databasePath, legacyDataFile);
    const insertRequest = database.prepare(`
        INSERT INTO service_requests (id, name, phone, service, details, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
    `);
    const server = http.createServer(async (request, response) => {
        const url = new URL(request.url, "http://localhost");

        try {
            if (url.pathname === "/api/health" && request.method === "GET") {
                sendJson(response, 200, { status: "ok" });
                return;
            }

            if (url.pathname === "/api/requests" && request.method === "POST") {
                if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
                    throw new HttpError(415, "Content-Type must be application/json.", "CONTENT_TYPE");
                }

                const record = validateRequest(await readJsonBody(request));
                insertRequest.run(
                    record.id,
                    record.name,
                    record.phone,
                    record.service,
                    record.details,
                    record.createdAt
                );
                sendJson(response, 201, {
                    message: "Thanks for getting in touch. We have received your note and will be in touch soon.",
                    id: record.id,
                });
                return;
            }

            if (url.pathname.startsWith("/api/")) {
                throw new HttpError(404, "API endpoint not found.", "NOT_FOUND");
            }

            const file = PUBLIC_FILES.get(url.pathname);
            if (!file && url.pathname !== "/favicon.ico") {
                throw new HttpError(404, "Page not found.", "NOT_FOUND");
            }
            if (request.method !== "GET" && request.method !== "HEAD") {
                response.writeHead(405, { Allow: "GET, HEAD" });
                response.end();
                return;
            }
            if (!file) {
                response.writeHead(204);
                response.end();
                return;
            }

            const content = await fs.readFile(path.join(ROOT, file[0]));
            response.writeHead(200, {
                "Content-Type": file[1],
                "Content-Length": content.length,
                "X-Content-Type-Options": "nosniff",
            });
            response.end(request.method === "HEAD" ? undefined : content);
        } catch (error) {
            if (error instanceof HttpError) {
                sendJson(response, error.status, { error: error.message, code: error.code });
                return;
            }

            console.error("Request handling failed:", error);
            if (!response.headersSent) {
                sendJson(response, 500, { error: "The server could not process this request.", code: "SERVER_ERROR" });
            } else {
                response.destroy();
            }
        }
    });
    server.once("close", () => database.close());
    return server;
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    const server = createServer();
    server.listen(port, "0.0.0.0", () => {
        console.log(`I&B LTD server listening on http://localhost:${port}`);
    });
    server.on("error", (error) => {
        console.error("Could not start the I&B LTD server:", error);
        process.exitCode = 1;
    });
}

module.exports = { createServer, initializeDatabase };
