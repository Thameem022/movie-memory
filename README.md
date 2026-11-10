# Movie Memory

## Setup

Requires Node.js 22.12+ and Docker.

```bash
npm install
docker run --name mm-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres
docker exec mm-db createdb -U postgres movie_memory
npm run dev
```

## Environment variables

Add these to `.env`:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/movie_memory?schema=public"
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET=""
GOOGLE_CLIENT_ID=""
GOOGLE_CLIENT_SECRET=""
OPENAI_API_KEY=""
# Optional. Defaults to gpt-4.1-mini. Use a non-reasoning model: replies are
OPENAI_MODEL=""
```

`OPENAI_API_KEY` is only read on the server (`lib/openai.ts` imports
`server-only`), so it never reaches the browser bundle. Don't prefix it with
`NEXT_PUBLIC_`.

## Database migrations

```bash
npx prisma migrate dev
npx prisma generate
```

## Architecture overview

To be added.

## Variant

Variant A: backend caching and correctness.

Why: to be added.

## Key tradeoffs

To be added.

## What I would improve with 2 more hours

To be added.
