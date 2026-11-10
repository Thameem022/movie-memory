import "server-only";
import { prisma } from "@/lib/prisma";
import { generateMovieFact, type FactFailureReason } from "@/lib/openai";

export type Fact = { content: string; movie: string; createdAt: Date };

// A fact younger than this is reused instead of asking OpenAI for a new one.
export const FACT_CACHE_TTL_MS = 60_000;

export type FactErrorReason =
  | FactFailureReason
  // The user has no favourite movie yet (or no longer exists).
  | "no_movie"
  // Reading the user's movie or latest fact from the database failed.
  | "database_error";

export type FactResult =
  // A new fact, just generated and stored.
  | { status: "fresh"; fact: Fact }
  // The latest stored fact, reused because it is under 60 seconds old.
  | { status: "cached"; fact: Fact }
  | { status: "error"; reason: FactErrorReason };

const factFields = { content: true, movie: true, createdAt: true } as const;

/**
 * True when a fact created at `createdAt` is still inside the cache window at
 * `now`. Strictly under 60 seconds: at exactly 60 seconds a new fact is made.
 */
export function isFresh(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() < FACT_CACHE_TTL_MS;
}

/**
 * Returns a fun fact about the user's favourite movie. If the latest fact for
 * this user and movie is under 60 seconds old it is reused; otherwise a new
 * one is generated, stored and returned.
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
    if (movie) {
      // Uses the (userId, movie, createdAt DESC) index. No time filter here:
      // the latest fact of any age is what the failure fallback will need.
      latest = await prisma.fact.findFirst({
        where: { userId, movie },
        orderBy: { createdAt: "desc" },
        select: factFields,
      });
    }
  } catch (error) {
    console.error(`[facts] failed to read movie or latest fact for user=${userId}`, error);
    return { status: "error", reason: "database_error" };
  }

  if (!movie) return { status: "error", reason: "no_movie" };

  if (latest && isFresh(latest.createdAt, new Date())) {
    console.info(`[facts] reused cached fact for user=${userId}`);
    return { status: "cached", fact: latest };
  }

  const generated = await generateMovieFact(movie);
  if (!generated.ok) {
    // Only real facts are stored. A failure is never saved as a fact.
    console.warn(`[facts] no fact for user=${userId}: reason=${generated.reason}`);
    return { status: "error", reason: generated.reason };
  }

  // Set here rather than left to the column default, so the timestamp and the
  // freshness check above come from the same clock (this server's).
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
    case "invalid_input":
    case "timeout":
    case "rate_limited":
    case "invalid_output":
    case "upstream_error":
    case "database_error":
      return "We couldn't get a fun fact right now. Refresh the page to try again.";
  }
}
