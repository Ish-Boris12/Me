# I&B LTD Rwanda

A simple full-stack website for I&B LTD's transport and agriculture services.
The interface supports Kinyarwanda, English, French, and Kiswahili, with a
light/dark appearance preference saved in the visitor's browser.

The original I&B logo is an editable SVG at `assets/images/ib-logo.svg` and is
served by the app at `/assets/images/ib-logo.svg`.

## Run locally

Requires Node.js 22.13 or newer for the built-in SQLite module. No packages need
to be installed.

```sh
node server.js
```

Open [http://localhost:3000](http://localhost:3000). Set the `PORT` environment
variable to use a different port.

## Backend

- `GET /api/health` checks that the server is running.
- `POST /api/requests` accepts a JSON service request with `name`, `phone`,
  `service`, and optional `details` fields.
- The server creates `data/ib-ltd.sqlite` and its `service_requests` table from
  `database/schema.sql` on first run. Requests are stored in that SQLite
  database. Keep it private because it contains customer contact information.
- If an earlier `data/requests.jsonl` file exists, its requests are imported
  into SQLite once at startup.
- The frontend sends requests to the same server and displays success or
  validation/connection errors.

Run the backend tests with:

```sh
node --test
```
