const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const { createServer } = require("../server");

async function startTestServer(t, legacyRecords = []) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ib-ltd-test-"));
    const databasePath = path.join(directory, "ib-ltd.sqlite");
    const legacyDataFile = path.join(directory, "requests.jsonl");
    if (legacyRecords.length) {
        await fs.writeFile(legacyDataFile, `${legacyRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
    }
    const server = createServer({
        databasePath,
        legacyDataFile: legacyRecords.length ? legacyDataFile : null,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    t.after(async () => {
        await new Promise((resolve, reject) => {
            server.close((error) => error ? reject(error) : resolve());
        });
        await fs.rm(directory, { recursive: true, force: true });
    });
    return { baseUrl: `http://127.0.0.1:${address.port}`, databasePath, legacyDataFile };
}

test("POST /api/requests validates and persists a service request", async (t) => {
    const { baseUrl, databasePath } = await startTestServer(t);
    const response = await fetch(`${baseUrl}/api/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name: "Aline Mukamana",
            phone: "+250 788 123 456",
            service: "Farm & goods transport",
            details: "Collect produce in Musanze",
        }),
    });

    assert.equal(response.status, 201);
    const result = await response.json();
    assert.ok(result.id);
    assert.match(result.message, /received/);

    const database = new DatabaseSync(databasePath);
    const saved = database.prepare("SELECT * FROM service_requests WHERE id = ?").get(result.id);
    assert.equal(saved.name, "Aline Mukamana");
    assert.equal(saved.service, "Farm & goods transport");
    assert.equal(saved.details, "Collect produce in Musanze");
    assert.ok(saved.created_at);
    database.close();
});

test("POST /api/requests rejects invalid input without saving it", async (t) => {
    const { baseUrl, databasePath } = await startTestServer(t);
    const response = await fetch(`${baseUrl}/api/requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A", phone: "bad", service: "Unknown" }),
    });

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Name/);
    const database = new DatabaseSync(databasePath);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM service_requests").get().count, 0);
    database.close();
});

test("imports existing JSONL requests into SQLite once", async (t) => {
    const legacyRequest = {
        id: "legacy-request-1",
        name: "Aline Mukamana",
        phone: "+250 788 123 456",
        service: "Farm support",
        details: "Seedling advice",
        createdAt: "2026-01-01T10:00:00.000Z",
    };
    const { databasePath, legacyDataFile } = await startTestServer(t, [legacyRequest]);
    const database = new DatabaseSync(databasePath);
    const saved = database.prepare("SELECT * FROM service_requests WHERE id = ?").get(legacyRequest.id);

    assert.equal(saved.name, legacyRequest.name);
    assert.equal(saved.created_at, legacyRequest.createdAt);
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM service_requests").get().count, 1);
    database.close();

    const restartedServer = createServer({ databasePath, legacyDataFile });
    await new Promise((resolve) => restartedServer.listen(0, "127.0.0.1", resolve));
    await new Promise((resolve, reject) => {
        restartedServer.close((error) => error ? reject(error) : resolve());
    });
    const reopenedDatabase = new DatabaseSync(databasePath);
    assert.equal(reopenedDatabase.prepare("SELECT COUNT(*) AS count FROM service_requests").get().count, 1);
    reopenedDatabase.close();
});

test("serves the frontend and reports API health", async (t) => {
    const { baseUrl } = await startTestServer(t);
    const page = await fetch(baseUrl);
    const pageContent = await page.text();
    const stylesheet = await fetch(`${baseUrl}/Ish.css`);
    const script = await fetch(`${baseUrl}/app.js`);
    const logo = await fetch(`${baseUrl}/assets/images/ib-logo.svg`);
    const health = await fetch(`${baseUrl}/api/health`);
    const scriptContent = await script.text();

    assert.equal(page.status, 200);
    assert.match(pageContent, /href="Ish\.css"/);
    assert.match(pageContent, /src="app\.js"/);
    assert.match(pageContent, /class="splash-screen"/);
    assert.match(pageContent, /src="\/assets\/images\/ib-logo\.svg"/);
    assert.match(pageContent, /id="themeToggle"/);
    assert.match(pageContent, /data-page-view="services"/);
    assert.match(pageContent, /id="languageSelect"/);
    assert.match(pageContent, /option value="rw"/);
    assert.match(pageContent, /option value="en"/);
    assert.match(pageContent, /option value="fr"/);
    assert.match(pageContent, /option value="sw"/);
    assert.equal(stylesheet.status, 200);
    assert.equal(script.status, 200);
    assert.equal(logo.status, 200);
    assert.match(logo.headers.get("content-type"), /image\/svg\+xml/);
    assert.match(await logo.text(), /<svg\b/);
    assert.match(await stylesheet.text(), /data-theme="light"/);
    assert.match(scriptContent, /fetch\("\/api\/requests"/);
    assert.match(scriptContent, /ib-ltd-theme/);
    assert.deepEqual(await health.json(), { status: "ok" });

    const requiredKeys = new Set(
        [...pageContent.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map((match) => match[1])
    );
    const dictionaries = [
        ["English", "const english = {", "\n};"],
        ["Kinyarwanda", "rw: {", "\n    },"],
        ["French", "fr: {", "\n    },"],
        ["Kiswahili", "sw: {", "\n};"],
    ];
    for (const [language, startMarker, endMarker] of dictionaries) {
        const start = scriptContent.indexOf(startMarker);
        const end = scriptContent.indexOf(endMarker, start);
        assert.notEqual(start, -1, `${language} dictionary exists`);
        assert.notEqual(end, -1, `${language} dictionary is complete`);
        const keys = new Set(
            [...scriptContent.slice(start, end).matchAll(/^\s*([A-Za-z]\w*):/gm)].map((match) => match[1])
        );
        for (const key of requiredKeys) {
            assert.ok(keys.has(key), `${language} has translation for ${key}`);
        }
    }
});
