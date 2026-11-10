import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, findFirst, create, generateMovieFact } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  generateMovieFact: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique }, fact: { findFirst, create } },
}));
vi.mock("@/lib/openai", () => ({ generateMovieFact }));

import {
  FACT_CACHE_TTL_MS,
  factErrorMessage,
  getFactForUser,
  isFresh,
  type FactErrorReason,
} from "@/lib/facts";

// The frozen "current time" for every test.
const NOW = new Date("2026-11-10T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function storedFact(ageMs: number, movie = "Spirited Away") {
  return { content: "An earlier fact.", movie, createdAt: ago(ageMs) };
}

describe("getFactForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Fake only Date, so promises and timers behave normally.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({ favoriteMovie: "Spirited Away" });
    findFirst.mockResolvedValue(null);
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

  it("generates a fact for the user's saved movie, stores it and returns it", async () => {
    const result = await getFactForUser("user-1");

    expect(findUnique).toHaveBeenCalledWith({
      where: { id: "user-1" },
      select: { favoriteMovie: true },
    });
    expect(generateMovieFact).toHaveBeenCalledWith("Spirited Away");
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { userId: "user-1", movie: "Spirited Away", content: "A fun fact.", createdAt: NOW },
      }),
    );
    expect(result).toEqual({
      status: "fresh",
      fact: { content: "A fun fact.", movie: "Spirited Away", createdAt: NOW },
    });
  });

  describe("60-second cache window", () => {
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
        expect(create).toHaveBeenCalledTimes(1);
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

    it("does not look up facts when there is no saved movie", async () => {
      findUnique.mockResolvedValue({ favoriteMovie: null });
      await getFactForUser("user-1");
      expect(findFirst).not.toHaveBeenCalled();
    });

    it("returns database_error and calls nothing when the fact lookup fails", async () => {
      findFirst.mockRejectedValue(new Error("connection reset"));
      expect(await getFactForUser("user-1")).toEqual({ status: "error", reason: "database_error" });
      expect(generateMovieFact).not.toHaveBeenCalled();
    });
  });

  it("only ever reads and writes the given user's rows", async () => {
    findUnique.mockImplementation(async ({ where }) =>
      where.id === "user-2" ? { favoriteMovie: "Alien" } : { favoriteMovie: "Up" },
    );
    await getFactForUser("user-2");

    expect(findUnique.mock.calls[0][0].where).toEqual({ id: "user-2" });
    expect(generateMovieFact).toHaveBeenCalledWith("Alien");
    expect(create.mock.calls[0][0].data.userId).toBe("user-2");
  });

  it.each([null, { favoriteMovie: null }])(
    "returns no_movie and calls nothing when there is no saved movie (%j)",
    async (user) => {
      findUnique.mockResolvedValue(user);
      expect(await getFactForUser("user-1")).toEqual({ status: "error", reason: "no_movie" });
      expect(generateMovieFact).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("returns database_error and calls nothing when the user can't be read", async () => {
    findUnique.mockRejectedValue(new Error("connection refused"));
    expect(await getFactForUser("user-1")).toEqual({ status: "error", reason: "database_error" });
    expect(generateMovieFact).not.toHaveBeenCalled();
  });

  it.each(["unknown_movie", "refused", "timeout", "rate_limited", "upstream_error"])(
    "passes the %s failure through and stores nothing",
    async (reason) => {
      generateMovieFact.mockResolvedValue({ ok: false, reason });
      expect(await getFactForUser("user-1")).toEqual({ status: "error", reason });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it("still returns the fact when storing it fails", async () => {
    create.mockRejectedValue(new Error("connection reset"));
    const result = await getFactForUser("user-1");
    expect(result).toMatchObject({
      status: "fresh",
      fact: { content: "A fun fact.", movie: "Spirited Away" },
    });
  });
});

describe("isFresh", () => {
  it("is true just under 60 seconds and false at exactly 60", () => {
    expect(isFresh(ago(FACT_CACHE_TTL_MS - 1), NOW)).toBe(true);
    expect(isFresh(ago(FACT_CACHE_TTL_MS), NOW)).toBe(false);
    expect(isFresh(ago(FACT_CACHE_TTL_MS + 1), NOW)).toBe(false);
  });
});

describe("factErrorMessage", () => {
  const reasons: FactErrorReason[] = [
    "invalid_input",
    "misconfigured",
    "unknown_movie",
    "refused",
    "timeout",
    "rate_limited",
    "invalid_output",
    "upstream_error",
    "no_movie",
    "database_error",
  ];

  it.each(reasons)("has a user-facing message for %s", (reason) => {
    const message = factErrorMessage(reason);
    expect(message.length).toBeGreaterThan(0);
    // No internal codes leak to the user.
    expect(message).not.toMatch(/_/);
  });

  it("tells the user when the movie isn't recognised", () => {
    expect(factErrorMessage("unknown_movie")).toMatch(/couldn't find a fun fact/);
    expect(factErrorMessage("refused")).toBe(factErrorMessage("unknown_movie"));
  });

  it("suggests a refresh for temporary failures", () => {
    expect(factErrorMessage("timeout")).toMatch(/Refresh/);
  });
});
