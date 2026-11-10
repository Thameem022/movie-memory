# Movie Memory

Sign in with Google, tell us your favourite movie, and get a fun fact about it
from OpenAI.

Built with Next.js 16 (App Router), React 19, Tailwind CSS 4, Postgres,
Prisma 7, NextAuth (Google) and the OpenAI API. **Variant A (backend caching
and correctness)** is implemented on top of the base app.

---

## Setup

Requires **Node.js 22.12+** and **Docker** (for Postgres).

```bash
npm install

# Postgres in Docker
docker run --name mm-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres
docker exec mm-db createdb -U postgres movie_memory

# Create .env (see below), then:
npx prisma migrate dev     # apply migrations
npx prisma generate        # generate the Prisma client (Prisma 7 no longer does this during migrate)
npm run dev                # http://localhost:3000
```

Run the tests:

```bash
npm test
```

### Google OAuth

In Google Cloud Console, create an OAuth client of type "Web application" and
add this authorised redirect URI:

```
http://localhost:3000/api/auth/callback/google
```

## Environment variables

Create `.env` in the project root:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/movie_memory?schema=public"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET=""          # any long random string, e.g. `openssl rand -base64 32`
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
OPENAI_API_KEY=""
# Optional. Defaults to gpt-4.1-mini. Use a non-reasoning model: replies are
# capped at 200 output tokens, which a reasoning model can spend on thinking.
OPENAI_MODEL=""
```

All of these are read on the server only. `lib/openai.ts` imports
`server-only`, so importing it from client code fails the build instead of
shipping the key to the browser. Never prefix them with `NEXT_PUBLIC_`.

## Database migrations

Migrations live in `prisma/migrations` and are applied in order:

| Migration | What it does |
|---|---|
| `init` | NextAuth tables: `User`, `Account`, `Session` |
| `add_favorite_movie` | `User.favoriteMovie` |
| `add_facts` | `Fact` table and its `(userId, movie, createdAt DESC)` index |
| `add_fact_lock` | `User.factLockUntil`, the generation lock |

```bash
npx prisma migrate dev     # development: apply, and create new ones from schema changes
npx prisma migrate deploy  # production: apply only
```

---

## Architecture overview

### Request flow

Everything is rendered on the server. There are no custom API routes; the
only route handler is NextAuth's.

```
/              → signed out: /login · no movie: /onboarding · otherwise: /dashboard
/login         → "Sign in with Google" (NextAuth, database sessions)
/onboarding    → server action saveFavoriteMovie → validates → saves → /dashboard
/dashboard     → profile + movie render at once; the fun fact streams in via <Suspense>
```

Every page asks `getCurrentUser()` (`lib/session.ts`) who is signed in. It
reads the user id from the server-side session and loads that user's row, and
the user id never comes from the request. That rule is what keeps users apart.

### Code map

| Path | Responsibility |
|---|---|
| `lib/auth.ts` | NextAuth config: Google provider, Prisma adapter, session id, safe logging |
| `lib/session.ts` | `getCurrentUser()`: the signed-in user, from the session only |
| `lib/validation.ts` | `parseFavoriteMovie()`: trims, normalises and checks length (1–100 characters, counted as Postgres counts them) |
| `app/onboarding/actions.ts` | Saves the movie, first time only |
| `lib/openai.ts` | The only code that talks to OpenAI. Returns a typed result and never throws |
| `lib/facts.ts` | Fact service: cache, generation lock, fallback, storage |
| `components/fun-fact.tsx` | Server component that shows the fact, the older-fact note or an error message |

### Data model

```
User ──< Fact
  id                id
  name, email,      userId → User.id  (on delete cascade)
  image (Google)    movie              VARCHAR(100)
  favoriteMovie     content            TEXT
  factLockUntil     createdAt
                    INDEX (userId, movie, createdAt DESC)
```

- **`favoriteMovie` is a nullable column on `User`.** Each user has exactly one
  favourite, and `NULL` means onboarding isn't finished. A separate table
  would only pay off with history or several favourites.
- **Every fact is kept, along with the title it was generated for** (`movie`).
  A fact is only valid for that exact title, so facts are looked up by
  `(userId, movie)`. If a user's movie ever changed, the old facts would simply
  stop matching, with no cache to clear by hand. This also gives the
  "user + movie" cache key from the spec.
- **The index matches the one query that matters:** "latest fact for this user
  and movie" is an equality match on `(userId, movie)` followed by the newest
  `createdAt`, so it is a single index lookup.
- **`factLockUntil` stores an expiry time, not a true/false flag** (see below).
  It lives on `User` because each user has one movie, so one lock per user is
  enough.
- **The 100-character limit matches in two places:** `VarChar(100)` and
  `MOVIE_MAX_LENGTH`. Validation counts code points (not UTF-16 units), so
  emoji and non-Latin titles are measured the way Postgres measures them.

### Fact generation (Variant A)

`getFactForUser(userId)` in `lib/facts.ts`:

```
read the user's movie and the latest fact for (user, movie)
 ├─ latest fact under 60 s old ───────────────► cached          (one read, no write)
 ├─ take the lock: UPDATE "User" SET factLockUntil = now + 20 s
 │                 WHERE id = $user AND (factLockUntil IS NULL OR factLockUntil < now)
 │   ├─ won (1 row)
 │   │    ├─ check the cache again ────────────► cached          (another request just finished)
 │   │    ├─ call OpenAI → store ──────────────► fresh
 │   │    ├─ OpenAI failed ────────────────────► stale (latest older fact) or error
 │   │    └─ finally: release the lock, only if it still holds our expiry
 │   └─ lost (0 rows): another tab is generating
 │        ├─ check every 300 ms, for up to 5 s, for a fresh fact ─► cached
 │        └─ none appeared ────────────────────► stale (latest older fact) or error
```

**1. 60-second cache.** The latest fact for this user and movie is reused while
it is *strictly* under 60 seconds old (`isFresh`). At exactly 60 seconds a new
one is generated. The lookup has no time filter on purpose: the same row is the
fallback when OpenAI fails. `createdAt` is set explicitly when a fact is saved,
so writing it and checking it use the same clock.

**2. Burst protection: a generation flag that expires.** Checking the cache
and then generating are two separate steps, so two tabs loading at the same
moment can both find nothing fresh and both call OpenAI. Before this fix, the
database showed facts 1 and 5 seconds apart. The fix makes "is anyone
generating? if not, it's me" a single conditional `UPDATE`. Postgres lets only
one of several simultaneous updates match the row; the others see 0 rows
updated.

- **It expires, not just a flag.** If a request crashes while holding the
  lock, the lock runs out after 20 seconds instead of blocking that user
  forever.
- **The lock lasts longer than the slowest OpenAI call.** It is defined as
  the OpenAI timeout plus 10 seconds, so a slow call can never outlive its own
  lock and let a second request in.
- **Only the holder can release it.** The release matches on the exact expiry
  that request set, so a request whose lock already expired can't clear a lock
  that someone else has taken since.
- **The cache is checked again after taking the lock**, to catch a fact stored
  by another request just before.
- **Requests that lose never call OpenAI.** They wait briefly for the winner's
  fact.

Options I considered and rejected:

| Option | Why not |
|---|---|
| In-memory lock | Only works inside one process. Several server instances (or serverless) each have their own memory. |
| Transaction / advisory lock / `SELECT … FOR UPDATE` | Keeps a transaction, and a pooled connection, open during a 2–10 s OpenAI call. Under the default isolation level two transactions can still both see "nothing fresh". |
| Unique constraint per 60 s window | Fixed time buckets aren't a sliding window (12:00:59 and 12:01:01 fall in different buckets). It also only fires on insert, after both requests have already paid for an OpenAI call. |

Checked against real Postgres: five simultaneous requests produced **one**
OpenAI call and **one** row, and the lock was released afterwards.

**3. Failure handling.** If OpenAI fails for any reason (timeout, rate limit,
outage, bad reply, bad key, unknown film, refusal), the latest earlier fact
for this user and movie is returned as `stale`, at any age, with a small
"Showing an earlier fact" note. With no earlier fact, the user sees a plain
message that suits the reason. Failures are never saved as facts.

### OpenAI integration (`lib/openai.ts`)

- **Never throws.** It returns `{ ok: true, fact }` or
  `{ ok: false, reason }`, where reason is one of `invalid_input`,
  `misconfigured`, `unknown_movie`, `refused`, `timeout`, `rate_limited`,
  `invalid_output` or `upstream_error`.
- **10-second timeout, no retries.** A retry would double the worst-case wait,
  and there is a fallback anyway.
- **Prompt injection.** The title is validated again, then sent as a
  JSON-encoded string. The instructions say to treat it as a title to look up,
  never as instructions.
- **Correctness:**
  - If the model doesn't recognise the film, it replies `UNKNOWN` instead of
    making up a fact.
  - When several films share a title (*Dune* 1984/2021, remakes in other
    languages), it picks the best-known one and names it with its year, e.g.
    "Dune (2021)". Users can add a year to choose a different one.
  - Replies are always in English, whatever the title's language or script.
- **The reply is checked before it's used:**
  - Rejected if cut off, filtered, empty, over 500 characters, or containing
    control characters.
  - Refusals are detected both when the API marks them and when the model
    writes "I'm sorry, I can't…".
- **Privacy:** `store: false`. Logs record the error class, HTTP status and
  OpenAI request id only, never the key, prompt or title.
- **Log levels:** expected failures (timeouts, rate limits, outages) are
  warnings. Problems that need someone to fix them (bad key, bad model,
  database errors) are errors.

### Security and correctness

- The user id always comes from the server-side session, never from the URL,
  form data or headers. Every fact query and write is scoped by it.
- Movie input is validated on the server: normalised, whitespace collapsed,
  1–100 characters, control characters rejected.
- Onboarding is first-time only, checked in the same statement as the write
  (`updateMany where favoriteMovie IS NULL`), so a double submit can't
  overwrite the movie.
- A missing Google name or photo is handled: the name falls back to "No name
  available", and the photo is simply left out.
- The fact streams in through `<Suspense>`, and every failure shows a friendly
  message instead of breaking the page.

### Tests

`npm test` runs 141 Vitest tests. Prisma and OpenAI are mocked, so no
database or API key is needed.

| File | Covers |
|---|---|
| `lib/facts.test.ts` | Cache window (59.999 s cached, 60 s regenerated, other movies ignored); the lock (exact conditions, release on every path, owner-only release, second check, waiting requests); five simultaneous requests against a fake database; crashed-lock takeover; OpenAI failure fallback |
| `lib/authorization.test.ts` | Two users with the same movie: session → dashboard → fact service. No user ever receives, reuses, waits for or falls back to another user's fact, or is blocked by their lock; `?userId=` in the URL is ignored |
| `lib/openai.test.ts` | Request shape, error mapping, reply checks, refusals, unknown films, no secrets in logs, log levels |
| `lib/validation.test.ts`, `app/onboarding/actions.test.ts` | Input validation, first-time-only onboarding, session-only user id |

The authorization tests were checked by breaking the code on purpose:
removing `userId` from the fact lookup, or letting the dashboard read
`?userId=`, makes them fail.

---

## Variant chosen: A (backend caching and correctness)

The base app already renders everything on the server and has no API layer,
so Variant A builds directly on it, while Variant B would mean adding an API
layer and client state first. Variant A is also where the interesting
correctness problems are: a time window, a race between concurrent requests,
and a paid external API that can fail. Those are the problems I wanted to
reason about carefully and test.

## Key tradeoffs

- **The lock lives in the database and expires, rather than an in-memory lock
  or a transaction.** It works across server instances and holds no database
  connection during the OpenAI call. The cost: the lock length needs tuning,
  and waiting requests poll the database.
- **Waiting requests wait at most 5 seconds.** That covers a typical OpenAI
  reply of 1–3 seconds. After that they show an older fact or "being
  generated, refresh" rather than hang. If the winner's OpenAI call fails, the
  waiting requests still wait the full 5 seconds, because they look for a new
  fact, not for the lock being freed.
- **Any earlier fact counts as the fallback, however old.** An old fact beats
  an error, and the UI labels it.
- **Unknown films aren't cached.** For a title the model doesn't recognise,
  each request after the 60-second window asks OpenAI again. The lock still
  allows only one of those requests at a time.
- **No retries on OpenAI calls**, with a 10-second timeout. Failures come back
  faster and the lock stays short; a brief OpenAI hiccup shows the older fact
  instead of being retried.
- **Plain-text replies with an `UNKNOWN` signal, instead of structured JSON
  output.** Less code and no schema dependency, but refusal detection uses a
  simple pattern match.
- **Tests mock Prisma and OpenAI.** They are fast and need no setup, but they
  prove the logic, not Postgres's locking. That part was checked once by hand
  against the real database.

## Known limitations

- **Facts can be wrong.** The prompt asks only for facts the model is
  confident about, and the UI labels them "AI-generated, may be inaccurate",
  but only a real movie database (e.g. TMDB) could check them. A made-up title
  that sounds real can still get an invented fact.
- **The movie can't be changed after onboarding** (editing is Variant B). A
  user with an unrecognised title keeps seeing "we couldn't find a fun fact".
- **The model isn't forced to include the year.** If it leaves the year out,
  the fact is still shown.

## What I would improve with 2 more hours

1. **A Postgres integration test for the lock**, run in CI against a real
   database: fire `Promise.all` of five requests and assert one OpenAI call and
   one row. This turns the one-off manual check into a permanent proof.
2. **Remember unknown films** so an unrecognised title doesn't call OpenAI on
   every visit.
3. **Stop waiting early when the winner fails**, by also checking the lock in
   the waiting loop.
4. **Structured output** (`{ known, title, year, fact }` validated with a
   schema) instead of `UNKNOWN` plus pattern matching. That would also make it
   possible to show "About Dune (2021)" as its own field.
5. **A "new fact" button and an edit-movie flow**, plus per-user rate limiting
   on OpenAI calls.
6. **Structured logging** (JSON with request ids) and alerts on `misconfigured`
   errors.

## AI usage

- Used Claude Code (Anthropic) as a pair programmer throughout: to read the
  brief, plan each step before writing code, and discuss tradeoffs (schema
  design, the lock options, failure behaviour).
- AI drafted most of the OpenAI wrapper, the fact service, the lock and the
  tests. I reviewed every change, asked for the reasoning behind each design
  decision, and made the product calls: English-only replies, how to handle
  films that share a title, and log levels that don't flood dev with errors.
- Every step was checked by more than the unit tests: running the app with a
  real key, inspecting the rows in Postgres, a one-off concurrency check
  against the real database, and deliberately breaking the authorization code
  to confirm the tests catch it.
