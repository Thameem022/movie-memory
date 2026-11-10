import "server-only";
import { prisma } from "@/lib/prisma";
import { generateMovieFact, OPENAI_TIMEOUT_MS, type FactFailureReason } from "@/lib/openai";

export type Fact = { content: string; movie: string; createdAt: Date };

// A fact younger than this is reused instead of asking OpenAI for a new one.
export const FACT_CACHE_TTL_MS = 60_000;

// How long one request may hold the generation lock. Must outlast the slowest
// OpenAI call, or a second request could take the lock mid-call and generate
// too. Derived from the timeout so the two can't drift apart.
export const FACT_LOCK_LEASE_MS = OPENAI_TIMEOUT_MS + 10_000;

// A request that finds the lock taken checks this often for the other
// request's fact, and gives up after WAIT_MAX_MS.
export const WAIT_POLL_INTERVAL_MS = 300;
export const WAIT_MAX_MS = 5_000;

export type FactErrorReason =
  | FactFailureReason
  // The user has no favourite movie yet (or no longer exists).
  | "no_movie"
  // Reading the user's movie or latest fact from the database failed.
  | "database_error"
  // Another request (another tab, a quick refresh) is generating this user's
  // fact, it didn't finish in time, and there is no earlier fact to show.
  | "generation_in_progress";

export type FactResult =
  // A new fact, just generated and stored.
  | { status: "fresh"; fact: Fact }
  // A stored fact under 60 seconds old, reused instead of generating.
  | { status: "cached"; fact: Fact }
  // An older fact, shown because a newer one couldn't be produced right now.
  | { status: "stale"; fact: Fact }
  | { status: "error"; reason: FactErrorReason };

const factFields = { content: true, movie: true, createdAt: true } as const;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * True when a fact created at `createdAt` is still inside the cache window at
 * `now`. Strictly under 60 seconds: at exactly 60 seconds a new fact is made.
 */
export function isFresh(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < FACT_CACHE_TTL_MS;
}

/** The newest fact for this user and movie, of any age. */
function findLatestFact(userId: string, movie: string): Promise<Fact | null> {
  // Served by the (userId, movie, createdAt DESC) index.
  return prisma.fact.findFirst({
    where: { userId, movie },
    orderBy: { createdAt: "desc" },
    select: factFields,
  });
}

/**
 * Tries to take this user's generation lock. Returns the expiry it set, which
 * is the caller's proof of ownership for releaseLock, or null if another
 * request holds an unexpired lock.
 *
 * One conditional UPDATE: Postgres lets only one of several concurrent
 * requests match "lock is free", so checking and taking happen in one step.
 */
async function tryAcquireLock(userId: string): Promise<Date | null> {
  const now = new Date();
  const until = new Date(now.getTime() + FACT_LOCK_LEASE_MS);
  const { count } = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ factLockUntil: null }, { factLockUntil: { lt: now } }],
    },
    data: { factLockUntil: until },
  });
  return count === 1 ? until : null;
}

/**
 * Frees the lock, but only if it is still ours: if our lease ran out and
 * another request took the lock, `token` no longer matches and theirs stays.
 * Never throws: if this fails, the lease simply expires.
 */
async function releaseLock(userId: string, token: Date): Promise<void> {
  try {
    await prisma.user.updateMany({
      where: { id: userId, factLockUntil: token },
      data: { factLockUntil: null },
    });
  } catch (error) {
    console.error(`[facts] failed to release lock for user=${userId}`, error);
  }
}

/**
 * Waits for the request holding the lock to store its fact. Returns that fact
 * once it appears, or null after WAIT_MAX_MS.
 */
async function waitForFreshFact(userId: string, movie: string): Promise<Fact | null> {
  const deadline = Date.now() + WAIT_MAX_MS;
  while (Date.now() < deadline) {
    await sleep(WAIT_POLL_INTERVAL_MS);
    try {
      const fact = await findLatestFact(userId, movie);
      if (fact && isFresh(fact.createdAt, new Date())) return fact;
    } catch (error) {
      console.error(`[facts] failed to check for a fresh fact for user=${userId}`, error);
      return null;
    }
  }
  return null;
}

/** Calls OpenAI, stores the fact and returns it. The caller holds the lock. */
async function generateAndStore(userId: string, movie: string): Promise<FactResult> {
  const generated = await generateMovieFact(movie);
  if (!generated.ok) {
    // Only real facts are stored. A failure is never saved as a fact.
    console.warn(`[facts] no fact for user=${userId}: reason=${generated.reason}`);
    return { status: "error", reason: generated.reason };
  }

  // Set here rather than left to the column default, so the timestamp and the
  // freshness check come from the same clock (this server's).
  const createdAt = new Date();
  try {
    const fact = await prisma.fact.create({
      data: { userId, movie, content: generated.fact, createdAt },
      select: factFields,
    });
    console.info(`[facts] stored fact for user=${userId}`);
    return { status: "fresh", fact };
  } catch (error) {
    // The fact is still good, so show it. Losing the record costs less than
    // showing an error for a fact that was already paid for.
    console.error(`[facts] failed to store fact for user=${userId}`, error);
    return { status: "fresh", fact: { content: generated.fact, movie, createdAt } };
  }
}

/**
 * Returns a fun fact about the user's favourite movie.
 *
 * - The latest fact for this user and movie is under 60 seconds old: reuse it.
 * - Otherwise take the user's generation lock, so that only one request at a
 *   time (across tabs, refreshes and server instances) calls OpenAI. The
 *   winner generates and stores a new fact. Other requests wait briefly for
 *   that fact, then fall back to the latest older one.
 * - If OpenAI fails, return the latest older fact as "stale", or an error the
 *   user can understand if there is none.
 *
 * `userId` must come from the server-side session. The movie is read from the
 * database here rather than passed in, so a fact is always for the movie this
 * user has saved. Never throws, so a failure can't take down the dashboard.
 */
export async function getFactForUser(userId: string): Promise<FactResult> {
  let movie: string | null | undefined;
  let latest: Fact | null = null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { favoriteMovie: true },
    });
    movie = user?.favoriteMovie;
    // No time filter: an older fact is still the fallback if a new one can't
    // be produced.
    if (movie) latest = await findLatestFact(userId, movie);
  } catch (error) {
    console.error(`[facts] failed to read movie or latest fact for user=${userId}`, error);
    return { status: "error", reason: "database_error" };
  }

  if (!movie) return { status: "error", reason: "no_movie" };

  // The common case: one read, no lock.
  if (latest && isFresh(latest.createdAt, new Date())) {
    console.info(`[facts] reused cached fact for user=${userId}`);
    return { status: "cached", fact: latest };
  }

  let token: Date | null;
  try {
    token = await tryAcquireLock(userId);
  } catch (error) {
    console.error(`[facts] failed to take lock for user=${userId}`, error);
    return latest ? { status: "stale", fact: latest } : { status: "error", reason: "database_error" };
  }

  if (!token) {
    // Another request is generating. Don't call OpenAI a second time.
    console.info(`[facts] waiting for another request's fact for user=${userId}`);
    const fact = await waitForFreshFact(userId, movie);
    if (fact) return { status: "cached", fact };
    if (latest) return { status: "stale", fact: latest };
    return { status: "error", reason: "generation_in_progress" };
  }

  try {
    // Check again: another request may have stored a fact between our first
    // check and taking the lock.
    const again = await findLatestFact(userId, movie).catch(() => null);
    if (again && isFresh(again.createdAt, new Date())) {
      console.info(`[facts] reused cached fact for user=${userId}`);
      return { status: "cached", fact: again };
    }

    const result = await generateAndStore(userId, movie);
    if (result.status !== "error") return result;

    // OpenAI failed (timeout, outage, bad reply...). Show the most recent fact
    // for this movie if there is one, of any age, rather than an error.
    const fallback = again ?? latest;
    if (fallback) {
      console.info(`[facts] showing an earlier fact for user=${userId} after reason=${result.reason}`);
      return { status: "stale", fact: fallback };
    }
    return result;
  } finally {
    // Runs on every path, including OpenAI and database failures.
    await releaseLock(userId, token);
  }
}

/** The message the user sees for each failure. Never exposes internal details. */
export function factErrorMessage(reason: FactErrorReason): string {
  switch (reason) {
    case "unknown_movie":
    case "refused":
      return "We couldn't find a fun fact about this movie. The title may be misspelled, or the film may be too obscure.";
    case "no_movie":
      return "Add a favorite movie to see a fun fact.";
    case "misconfigured":
      return "Fun facts aren't available right now.";
    case "generation_in_progress":
      return "Your fun fact is being generated. Refresh in a moment to see it.";
    case "invalid_input":
    case "timeout":
    case "rate_limited":
    case "invalid_output":
    case "upstream_error":
    case "database_error":
      return "We couldn't get a fun fact right now. Refresh the page to try again.";
  }
}
