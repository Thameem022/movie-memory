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

import {
  FACT_CACHE_TTL_MS,
  FACT_LOCK_LEASE_MS,
  WAIT_MAX_MS,
  WAIT_POLL_INTERVAL_MS,
  factErrorMessage,
  getFactForUser,
  isFresh,
  type Fact,
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
    // Fake the clock and timers: freshness checks see NOW, and the waiting
    // loop's sleeps only pass when a test advances time.
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    findUnique.mockResolvedValue({ favoriteMovie: "Spirited Away" });
    findFirst.mockResolvedValue(null);
    // By default this request wins the lock, and releasing it succeeds.
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

  describe("burst protection", () => {
    const token = new Date(NOW.getTime() + FACT_LOCK_LEASE_MS);
    const isAcquire = (call: unknown[]) =>
      (call[0] as { data: { factLockUntil: Date | null } }).data.factLockUntil !== null;
    const acquireCalls = () => updateMany.mock.calls.filter(isAcquire);
    const releaseCalls = () => updateMany.mock.calls.filter((call) => !isAcquire(call));

    // The conditional update matches no row: another request holds the lock.
    function loseTheLock() {
      updateMany.mockResolvedValue({ count: 0 });
    }

    it("makes the lease outlast the slowest OpenAI call", () => {
      expect(FACT_LOCK_LEASE_MS).toBeGreaterThan(10_000);
    });

    it("never touches the lock when a fresh fact is cached", async () => {
      findFirst.mockResolvedValue(storedFact(1_000));
      await getFactForUser("user-1");
      expect(updateMany).not.toHaveBeenCalled();
    });

    it("takes the lock only if it is free or expired, in one conditional update", async () => {
      await getFactForUser("user-1");
      expect(acquireCalls()).toEqual([
        [
          {
            where: {
              id: "user-1",
              OR: [{ factLockUntil: null }, { factLockUntil: { lt: NOW } }],
            },
            data: { factLockUntil: token },
          },
        ],
      ]);
    });

    it("releases only its own lock after storing the fact", async () => {
      await getFactForUser("user-1");
      expect(releaseCalls()).toEqual([
        [{ where: { id: "user-1", factLockUntil: token }, data: { factLockUntil: null } }],
      ]);
      // Released after the fact is stored, not before.
      const releaseOrder = updateMany.mock.invocationCallOrder.at(-1)!;
      expect(releaseOrder).toBeGreaterThan(create.mock.invocationCallOrder[0]);
    });

    it("releases the lock when OpenAI fails", async () => {
      generateMovieFact.mockResolvedValue({ ok: false, reason: "timeout" });
      await getFactForUser("user-1");
      expect(releaseCalls()).toHaveLength(1);
    });

    it("releases the lock when storing the fact fails", async () => {
      create.mockRejectedValue(new Error("connection reset"));
      const result = await getFactForUser("user-1");
      expect(result.status).toBe("fresh");
      expect(releaseCalls()).toHaveLength(1);
    });

    it("returns the result unchanged, without throwing, if releasing fails", async () => {
      updateMany.mockImplementation(async ({ data }) => {
        if (data.factLockUntil === null) throw new Error("connection reset");
        return { count: 1 };
      });
      expect((await getFactForUser("user-1")).status).toBe("fresh");
    });

    it("checks the cache again after taking the lock", async () => {
      // Another request stored a fact between our first check and the lock.
      const justStored = storedFact(200);
      findFirst.mockResolvedValueOnce(storedFact(120_000)).mockResolvedValueOnce(justStored);

      expect(await getFactForUser("user-1")).toEqual({ status: "cached", fact: justStored });
      expect(generateMovieFact).not.toHaveBeenCalled();
      expect(releaseCalls()).toHaveLength(1);
    });

    // The last poll can start just before the deadline and end just after it.
    const PAST_THE_WAIT = WAIT_MAX_MS + WAIT_POLL_INTERVAL_MS;

    describe("when another request holds the lock", () => {
      beforeEach(loseTheLock);

      it("never calls OpenAI, and returns the other request's fact once it appears", async () => {
        const theirs = { content: "Their fact.", movie: "Spirited Away", createdAt: NOW };
        // First check: nothing fresh. Then two polls: nothing, then their fact.
        findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(theirs);

        const pending = getFactForUser("user-1");
        await vi.advanceTimersByTimeAsync(WAIT_POLL_INTERVAL_MS * 2);

        expect(await pending).toEqual({ status: "cached", fact: theirs });
        expect(generateMovieFact).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
        expect(releaseCalls()).toHaveLength(0);
      });

      it("falls back to the latest older fact if none appears in time", async () => {
        const older = storedFact(120_000);
        findFirst.mockResolvedValue(older);

        const pending = getFactForUser("user-1");
        await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);

        expect(await pending).toEqual({ status: "stale", fact: older });
        expect(generateMovieFact).not.toHaveBeenCalled();
        // It polled for the whole wait, then stopped.
        expect(findFirst.mock.calls.length).toBeGreaterThan(WAIT_MAX_MS / WAIT_POLL_INTERVAL_MS - 2);
      });

      it("says the fact is being generated when there is nothing to show", async () => {
        findFirst.mockResolvedValue(null);

        const pending = getFactForUser("user-1");
        await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);

        expect(await pending).toEqual({ status: "error", reason: "generation_in_progress" });
        expect(generateMovieFact).not.toHaveBeenCalled();
      });
    });

    it("falls back to the older fact if taking the lock fails", async () => {
      const older = storedFact(120_000);
      findFirst.mockResolvedValue(older);
      updateMany.mockRejectedValue(new Error("connection reset"));

      expect(await getFactForUser("user-1")).toEqual({ status: "stale", fact: older });
      expect(generateMovieFact).not.toHaveBeenCalled();
    });

    describe("with simultaneous requests against a simulated database", () => {
      // A tiny in-memory stand-in for the Fact table and the lock column that
      // honours the same conditions Postgres would. It shows the pieces work
      // together; that Postgres runs the conditional update atomically is
      // Postgres's guarantee, not something a mock can prove.
      function fakeDatabase() {
        let lockUntil: Date | null = null;
        const facts: Fact[] = [];
        findFirst.mockImplementation(async () => facts.at(-1) ?? null);
        create.mockImplementation(async ({ data }) => {
          const fact = { content: data.content, movie: data.movie, createdAt: data.createdAt };
          facts.push(fact);
          return fact;
        });
        updateMany.mockImplementation(async ({ where, data }) => {
          if (data.factLockUntil === null) {
            // Release: only if the caller's token still matches.
            if (lockUntil?.getTime() !== where.factLockUntil.getTime()) return { count: 0 };
            lockUntil = null;
            return { count: 1 };
          }
          // Acquire: only if free or expired.
          if (lockUntil && lockUntil >= new Date()) return { count: 0 };
          lockUntil = data.factLockUntil;
          return { count: 1 };
        });
        return {
          facts,
          lock: () => lockUntil,
          setLock: (until: Date) => {
            lockUntil = until;
          },
        };
      }

      // OpenAI takes 1.5 seconds, so the requests overlap.
      function slowOpenAI() {
        generateMovieFact.mockImplementation(
          () =>
            new Promise((resolve) =>
              setTimeout(() => resolve({ ok: true, fact: "A fun fact." }), 1_500),
            ),
        );
      }

      it("makes one OpenAI call and one fact for five tabs loading at once", async () => {
        const db = fakeDatabase();
        slowOpenAI();

        const pending = Promise.all(Array.from({ length: 5 }, () => getFactForUser("user-1")));
        await vi.advanceTimersByTimeAsync(PAST_THE_WAIT);
        const results = await pending;

        expect(generateMovieFact).toHaveBeenCalledTimes(1);
        expect(db.facts).toHaveLength(1);
        expect(results.map((r) => r.status).sort()).toEqual([
          "cached",
          "cached",
          "cached",
          "cached",
          "fresh",
        ]);
        for (const result of results) {
          expect(result).toMatchObject({ fact: { content: "A fun fact." } });
        }
        expect(db.lock()).toBeNull();
      });

      it("takes over a lock left behind by a crashed request once its lease expires", async () => {
        const db = fakeDatabase();
        db.setLock(new Date(NOW.getTime() - 1)); // expired a millisecond ago

        expect((await getFactForUser("user-1")).status).toBe("fresh");
        expect(generateMovieFact).toHaveBeenCalledTimes(1);
        expect(db.lock()).toBeNull();
      });

      it("does not clear a lock another request took after ours expired", async () => {
        const db = fakeDatabase();
        generateMovieFact.mockImplementation(async () => {
          // While we call OpenAI, our lease is lost and someone else holds it.
          db.setLock(new Date(NOW.getTime() + 99_000));
          return { ok: true, fact: "A fun fact." };
        });

        await getFactForUser("user-1");
        expect(db.lock()).toEqual(new Date(NOW.getTime() + 99_000));
      });
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

  describe("when OpenAI fails", () => {
    const failures = [
      "timeout",
      "rate_limited",
      "upstream_error",
      "invalid_output",
      "misconfigured",
      "unknown_movie",
      "refused",
    ];

    it.each(failures)(
      "returns the latest earlier fact as stale after %s, and stores nothing",
      async (reason) => {
        const older = storedFact(10 * 60_000); // ten minutes old
        findFirst.mockResolvedValue(older);
        generateMovieFact.mockResolvedValue({ ok: false, reason });

        expect(await getFactForUser("user-1")).toEqual({ status: "stale", fact: older });
        expect(create).not.toHaveBeenCalled();
      },
    );

    it.each(failures)(
      "returns the %s error when there is no earlier fact, and stores nothing",
      async (reason) => {
        findFirst.mockResolvedValue(null);
        generateMovieFact.mockResolvedValue({ ok: false, reason });

        expect(await getFactForUser("user-1")).toEqual({ status: "error", reason });
        expect(create).not.toHaveBeenCalled();
      },
    );

    it("falls back to a fact of any age, not just recent ones", async () => {
      const veryOld = storedFact(30 * 24 * 60 * 60_000); // a month old
      findFirst.mockResolvedValue(veryOld);
      generateMovieFact.mockResolvedValue({ ok: false, reason: "timeout" });

      expect(await getFactForUser("user-1")).toEqual({ status: "stale", fact: veryOld });
    });

    it("uses the newest fact it has seen, from the second check", async () => {
      const first = storedFact(10 * 60_000);
      const newer = storedFact(2 * 60_000);
      findFirst.mockResolvedValueOnce(first).mockResolvedValueOnce(newer);
      generateMovieFact.mockResolvedValue({ ok: false, reason: "timeout" });

      expect(await getFactForUser("user-1")).toEqual({ status: "stale", fact: newer });
    });

    it("uses the first lookup's fact if the second check fails", async () => {
      const older = storedFact(10 * 60_000);
      findFirst.mockResolvedValueOnce(older).mockRejectedValueOnce(new Error("connection reset"));
      generateMovieFact.mockResolvedValue({ ok: false, reason: "timeout" });

      expect(await getFactForUser("user-1")).toEqual({ status: "stale", fact: older });
    });

    it("never falls back to a fact for a different movie", async () => {
      // The lookup filters on the current movie, so another title's fact
      // never comes back. Simulate the database honouring that filter.
      findFirst.mockImplementation(async ({ where }) =>
        where.movie === "Alien" ? storedFact(10 * 60_000, "Alien") : null,
      );
      generateMovieFact.mockResolvedValue({ ok: false, reason: "timeout" });

      expect(await getFactForUser("user-1")).toEqual({ status: "error", reason: "timeout" });
    });
  });

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
    "generation_in_progress",
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
