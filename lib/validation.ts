export const MOVIE_MIN_LENGTH = 1;
// Must match the VarChar(100) on User.favoriteMovie in prisma/schema.prisma.
export const MOVIE_MAX_LENGTH = 100;

export type ParseResult = { ok: true; value: string } | { ok: false; error: string };

// Control characters that are not whitespace (whitespace is collapsed first).
const CONTROL_CHARS = /\p{Cc}/u;

/**
 * Validates and cleans a favourite movie title from untrusted input.
 * Trims it, collapses runs of whitespace into one space and checks its length.
 */
export function parseFavoriteMovie(raw: unknown): ParseResult {
  if (typeof raw !== "string") {
    return { ok: false, error: "Please enter a movie title." };
  }

  const value = raw.normalize("NFC").replace(/\s+/g, " ").trim();

  if (CONTROL_CHARS.test(value)) {
    return { ok: false, error: "The movie title contains characters that aren't allowed." };
  }

  // Count code points, not UTF-16 units, so the limit matches Postgres VarChar.
  const length = [...value].length;
  if (length < MOVIE_MIN_LENGTH) {
    return { ok: false, error: "Please enter a movie title." };
  }
  if (length > MOVIE_MAX_LENGTH) {
    return {
      ok: false,
      error: `The movie title must be ${MOVIE_MAX_LENGTH} characters or fewer.`,
    };
  }

  return { ok: true, value };
}
