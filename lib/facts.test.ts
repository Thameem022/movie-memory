import { beforeEach, describe, expect, it, vi } from "vitest";

const { findUnique, create, generateMovieFact } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  generateMovieFact: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique }, fact: { create } },
}));
vi.mock("@/lib/openai", () => ({ generateMovieFact }));

import { factErrorMessage, getFactForUser, type FactErrorReason } from "@/lib/facts";

const createdAt = new Date("2026-11-10T12:00:00Z");

describe("getFactForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({ favoriteMovie: "Spirited Away" });
    generateMovieFact.mockResolvedValue({ ok: true, fact: "A fun fact." });
    create.mockImplementation(async ({ data }) => ({
      content: data.content,
      movie: data.movie,
      createdAt,
    }));
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
        data: { userId: "user-1", movie: "Spirited Away", content: "A fun fact." },
      }),
    );
    expect(result).toEqual({
      status: "fresh",
      fact: { content: "A fun fact.", movie: "Spirited Away", createdAt },
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
