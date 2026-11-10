/**
 * 60-second cache: if the latest fact for this user and movie is under 60
 * seconds old it is returned as is; otherwise a new fact is generated, stored
 * and returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, updateMany, findFirst, create, generateMovieFact } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  generateMovieFact: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique, updateMany }, fact: { findFirst, create } },
}));
vi.mock("@/lib/openai", () => ({ generateMovieFact, OPENAI_TIMEOUT_MS: 10_000 }));

import { FACT_CACHE_TTL_MS, getFactForUser, isFresh } from "@/lib/facts";

// The frozen "current time" for every test.
const NOW = new Date("2026-11-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function storedFact(ageMs: number, movie = "Spirited Away") {
  return { content: "An earlier fact.", movie, createdAt: ago(ageMs) };
}

describe("60-second cache window", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "info").mockImplementation(() => {});
    findUnique.mockResolvedValue({ favoriteMovie: "Spirited Away" });
    findFirst.mockResolvedValue(null);
    // Generating a new fact takes the user's generation lock first; let it
    // succeed so these tests only exercise the cache decision.
    updateMany.mockResolvedValue({ count: 1 });
    generateMovieFact.mockResolvedValue({ ok: true, fact: "A fun fact." });
    create.mockImplementation(async ({ data }) => ({
      content: data.content,
      movie: data.movie,
      createdAt: data.createdAt,
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("looks up the latest fact for this user and this movie only", async () => {
    await getFactForUser("user-1");
    expect(findFirst).toHaveBeenCalledWith({
      where: { userId: "user-1", movie: "Spirited Away" },
      orderBy: { createdAt: "desc" },
      select: { content: true, movie: true, createdAt: true },
    });
  });

  it.each([0, 1, 30_000, FACT_CACHE_TTL_MS - 1])(
    "returns the stored fact without calling OpenAI when it is %i ms old",
    async (age) => {
      const fact = storedFact(age);
      findFirst.mockResolvedValue(fact);

      expect(await getFactForUser("user-1")).toEqual({ status: "cached", fact });
      expect(generateMovieFact).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it.each([FACT_CACHE_TTL_MS, FACT_CACHE_TTL_MS + 1, 61_000, 3_600_000])(
    "generates, stores and returns a new fact when the latest is %i ms old",
    async (age) => {
      findFirst.mockResolvedValue(storedFact(age));

      const result = await getFactForUser("user-1");

      expect(generateMovieFact).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { userId: "user-1", movie: "Spirited Away", content: "A fun fact.", createdAt: NOW },
        }),
      );
      expect(result).toEqual({
        status: "fresh",
        fact: { content: "A fun fact.", movie: "Spirited Away", createdAt: NOW },
      });
    },
  );

  it("generates a fact when there is no earlier one", async () => {
    findFirst.mockResolvedValue(null);
    expect((await getFactForUser("user-1")).status).toBe("fresh");
    expect(generateMovieFact).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a fresh fact stored for a different movie", async () => {
    // The query filters on movie, so a fact for another title never comes
    // back. Simulate the database honouring that filter.
    findFirst.mockImplementation(async ({ where }) =>
      where.movie === "Alien" ? storedFact(1_000, "Alien") : null,
    );
    expect((await getFactForUser("user-1")).status).toBe("fresh");
    expect(generateMovieFact).toHaveBeenCalledWith("Spirited Away");
  });
});

describe("isFresh", () => {
  it("is true just under 60 seconds and false at exactly 60", () => {
    expect(isFresh(ago(FACT_CACHE_TTL_MS - 1), NOW)).toBe(true);
    expect(isFresh(ago(FACT_CACHE_TTL_MS), NOW)).toBe(false);
    expect(isFresh(ago(FACT_CACHE_TTL_MS + 1), NOW)).toBe(false);
  });
});
