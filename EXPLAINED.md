# Pulse (Fitness Tracker): the code, step by step

Files: `db.js` (database) -> `server.js` (API) -> `public/index.html` (page) -> `public/style.css` (looks) -> `public/app.js` (behaviour).

## 1. `db.js` - the database

```js
const db = new Database(path.join(dataDir, 'fitness.db'));
```
Opens (or creates) the file `fitness.db`. `process.env.DATA_DIR || __dirname` means "use the DATA_DIR setting if it exists, otherwise this folder". That is how production can store the file on a permanent disk.

`db.pragma('journal_mode = WAL')` makes SQLite faster and safer when reading and writing at the same time. `foreign_keys = ON` makes the database enforce links between tables.

Three tables are created with `CREATE TABLE IF NOT EXISTS` (safe to run on every start):

| Table | Holds | Notes |
|-------|-------|-------|
| `users` | name, email, **password_hash** | `email` is `UNIQUE`, so two people can't share one. |
| `sessions` | a random `token` + which user it belongs to | This is how "logged in" is remembered. |
| `logs` | `type` (steps/water/...), `value`, `date`, `note`, owner `user_id` | The index on `(user_id, date)` makes chart queries fast. |

`ON DELETE CASCADE` means deleting a user would also delete their sessions and logs.

## 2. `server.js` - the API

**Top of the file.** Imports libraries, then defines `METRICS`: one object describing steps, water, sleep, workout (label, icon, unit, daily goal, max allowed value, quick-add amounts). The front end downloads this from `/api/config`, so goals live in exactly one place.

**Setting up Express.**
- `app.use(express.json())` reads JSON bodies into `req.body`.
- `cookieParser()` reads cookies into `req.cookies`.
- `trust proxy` tells Express it is behind Render's proxy so IP addresses and secure cookies work.

**Helpers.**
- `isValidDate` checks `YYYY-MM-DD` *and* that the date really exists (no `2026-02-31`).
- `addDays` does date maths in UTC to avoid daylight-saving surprises.
- `rateLimit(max, windowMs)` returns a middleware that counts requests per IP in a `Map` and answers `429 Too many attempts` past the limit.

**Sessions.**
- `startSession` creates 32 random bytes (`crypto.randomBytes`), stores them in `sessions`, and sends them as a cookie named `sid`. The cookie is `httpOnly` (JavaScript can't read it, which blocks theft via XSS) and `sameSite: 'lax'` (blocks most cross-site request forgery).
- `findUser` looks the cookie up in the database, joined to `users`, and ignores sessions older than 14 days.
- `requireUser` is **middleware**: if no user, answer `401`; otherwise put the user on `req.user` and call `next()` to continue to the route.

**Auth routes.**
- `signup`: validate name/email/password length, `bcrypt.hashSync(password, 10)` to scramble the password, `INSERT` the user. If the email exists the database raises a `UNIQUE` constraint error, which we catch and turn into a friendly `409`.
- `login`: find the user, `bcrypt.compareSync`. If the email is unknown we still compare against a dummy hash, so attackers can't tell "wrong email" from "wrong password" by timing.
- `logout`: delete the session row and clear the cookie.
- `/api/me`: returns the current user, or `{ user: null }` (not an error) so the page knows which screen to show.

**Log routes** (all behind `requireUser`, and every query includes `user_id = ?` so people can only touch **their own** data).
- `GET /api/logs`: latest entries.
- `POST /api/logs`: validates type, value (`> 0` and under the metric's `max`), date; refuses dates in the future (one day of slack for timezones); `INSERT`.
- `DELETE /api/logs/:id`: `WHERE id = ? AND user_id = ?`.

**`GET /api/summary`** is the dashboard's engine.
1. One SQL query: `SELECT date, type, SUM(value) ... GROUP BY date, type` adds up everything per day per type.
2. We pre-fill every day in the range with zeros so days with no activity still appear as empty bars.
3. For each metric we compute total, average (over days you logged), and how many days hit the goal.
4. `currentStreak` counts consecutive days with any log, walking backwards from today (or yesterday, so your streak doesn't reset in the morning).

**End of file.** `express.static('public')` serves the front end files. The last `app.use((err, ...))` is the error handler: unexpected errors are logged and the user gets a generic message, never a stack trace.

## 3. `public/index.html`

Two big blocks: `#auth-view` (login/sign-up card) and `#app-view` (the dashboard). Both start `hidden`; JavaScript decides which to show. Inputs sit inside `<label>` so clicking the text focuses the field (accessibility). Chart.js is loaded from a CDN with `<script src=...>`, and our `app.js` loads after it.

## 4. `public/style.css`

- `:root { --accent: ...; --steps: ... }` are **CSS variables**: the whole theme in one place. The `@media (prefers-color-scheme: dark)` block redefines them for dark mode.
- The progress ring is a `conic-gradient` (a pie-chart gradient) whose filled amount comes from the `--pct` variable; `@property --pct` lets the browser animate that number.
- Layout uses CSS Grid with `repeat(auto-fit, minmax(...))`, so cards wrap on small screens with no media queries.
- `prefers-reduced-motion` turns animations off for people who need that.

## 5. `public/app.js`

Read it bottom-up: `init()` -> `wireUpEvents()`.

- **`api()`** wraps `fetch`: sends JSON, parses the answer, and throws an `Error` with the server's message on failure.
- **`state`** is one object holding what the page knows (user, metrics, chosen range, charts).
- **Auth flow:** `init` asks `/api/me`. If there's a user -> `enterApp()`; otherwise show the login card. `handleAuthSubmit` posts to `/api/auth/login` or `/signup` depending on the active tab.
- **`refresh()`** fetches summary + recent logs in parallel (`Promise.all`) then calls `renderToday`, `renderStats`, `renderCharts`, `renderLogs`. Every add/delete ends with `refresh()`, so the screen always matches the database.
- **Rendering** builds HTML strings with template literals and puts them in `innerHTML`. Anything a user typed goes through `esc()` first.
- **`renderCharts`** creates each Chart.js chart once, then on later calls just swaps `data` and calls `update()`. The goal line is a second, dashed "line" dataset.
- **Event delegation:** one `click` listener on `#today-cards` handles every quick-add chip, even ones created later, by checking `e.target.closest('.chip')`.
- **Dates:** `todayISO()` builds the date from local `getFullYear/getMonth/getDate` rather than `toISOString()`, which would give the UTC date and break "today" for people far from UTC.

## 6. Ideas to extend

Edit goals per user, add a weight metric, weekly email summary, a "best day" badge.
