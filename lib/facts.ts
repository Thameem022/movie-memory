import "server-only";
import { prisma } from "@/lib/prisma";
import { generateMovieFact, type FactFailureReason } from "@/lib/openai";

export type Fact = { content: string; movie: string; createdAt: Date };

export type FactErrorReason =
  | FactFailureReason
  // The user has no favourite movie yet (or no longer exists).
  | "no_movie"
  // Reading the user's movie from the database failed.
  | "database_error";

export type FactResult =
  | { status: "fresh"; fact: Fact }
  | { status: "error"; reason: FactErrorReason };

/**
 * Generates a fun fact about the user's favourite movie, stores it and
 * returns it. Base version: a new fact on every call.
 *
 * `userId` must come from the server-side session. The movie is read from the
 * database here rather than passed in, so a fact is always for the movie this
 * user has saved. Never throws, so a failure can't take down the dashboard.
 */
export async function getFactForUser(userId: string): Promise<FactResult> {
  let movie: string | null | undefined;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { favoriteMovie: true },
    });
    movie = user?.favoriteMovie;
  } catch (error) {
    console.error(`[facts] failed to read movie for user=${userId}`, error);
    return { status: "error", reason: "database_error" };
  }

  if (!movie) return { status: "error", reason: "no_movie" };

  const generated = await generateMovieFact(movie);
  if (!generated.ok) {
    // Only real facts are stored. A failure is never saved as a fact.
    console.warn(`[facts] no fact for user=${userId}: reason=${generated.reason}`);
    return { status: "error", reason: generated.reason };
  }

  try {
    const fact = await prisma.fact.create({
      data: { userId, movie, content: generated.fact },
      select: { content: true, movie: true, createdAt: true },
    });
    console.info(`[facts] stored fact for user=${userId}`);
    return { status: "fresh", fact };
  } catch (error) {
    // The fact is still good, so show it. Losing the record costs less than
    // showing an error for a fact that was already paid for.
    console.error(`[facts] failed to store fact for user=${userId}`, error);
    return { status: "fresh", fact: { content: generated.fact, movie, createdAt: new Date() } };
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
