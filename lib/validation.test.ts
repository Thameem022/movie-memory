import { describe, expect, it } from "vitest";
import { MOVIE_MAX_LENGTH, parseFavoriteMovie } from "@/lib/validation";

describe("parseFavoriteMovie", () => {
  it("accepts a normal title", () => {
    expect(parseFavoriteMovie("Spirited Away")).toEqual({ ok: true, value: "Spirited Away" });
  });

  it("trims and collapses whitespace", () => {
    expect(parseFavoriteMovie("  The \t Matrix \n ")).toEqual({ ok: true, value: "The Matrix" });
  });

  it("accepts a one-character title", () => {
    expect(parseFavoriteMovie(" 9 ")).toEqual({ ok: true, value: "9" });
  });

  it.each(["", "   ", "\n\t"])("rejects an empty or blank title (%j)", (input) => {
    expect(parseFavoriteMovie(input).ok).toBe(false);
  });

  it("accepts a title at the maximum length", () => {
    const title = "a".repeat(MOVIE_MAX_LENGTH);
    expect(parseFavoriteMovie(title)).toEqual({ ok: true, value: title });
  });

  it("rejects a title over the maximum length", () => {
    expect(parseFavoriteMovie("a".repeat(MOVIE_MAX_LENGTH + 1)).ok).toBe(false);
  });

  it("checks the length after trimming", () => {
    const title = "a".repeat(MOVIE_MAX_LENGTH);
    expect(parseFavoriteMovie(`   ${title}   `)).toEqual({ ok: true, value: title });
  });

  it("counts characters the way Postgres does, not UTF-16 units", () => {
    // Each emoji is 2 UTF-16 units but 1 character in Postgres.
    const title = "🎬".repeat(MOVIE_MAX_LENGTH);
    expect(parseFavoriteMovie(title)).toEqual({ ok: true, value: title });
  });

  it("rejects control characters", () => {
    expect(parseFavoriteMovie("Alien\u0000").ok).toBe(false);
  });

  it.each([null, undefined, 42, {}, ["Up"]])("rejects non-string input (%j)", (input) => {
    expect(parseFavoriteMovie(input).ok).toBe(false);
  });
});
