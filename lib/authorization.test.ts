/**
 * Authorization: a user can only ever see their own facts.
 *
 * A fact reaches the screen along one path, and every link is tested here:
 *   session cookie → getCurrentUser() → Dashboard → <FunFact userId> → getFactForUser()
 *
 * 1. getCurrentUser takes the user id from the server-side session only.
 * 2. The dashboard passes that id to FunFact. Nothing in the request (query
 *    string, form data, headers) can change it, and signed-out visitors never
 *    reach it.
 * 3. getFactForUser scopes every read and write to that id, so even two users
 *    with the same favourite movie never see, reuse, wait for or fall back to
 *    each other's facts, or block each other's lock.
 *
 * The database is a small in-memory fake with two users that honours the same
 * filters Postgres would, so a query missing its `userId` filter would return
 * the other user's rows and fail these tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const { getServerSession, generateMovieFact, db } = vi.hoisted(() => {
  type UserRow = {
    id: string;
    name: string | null;
    email: string | null;
    image: string | null;
    favoriteMovie: string | null;
    factLockUntil: Date | null;
  };
  type FactRow = { userId: string; movie: string; content: string; createdAt: Date };
  return {
    getServerSession: vi.fn(),
    generateMovieFact: vi.fn(),
    db: { users: new Map<string, UserRow>(), facts: [] as FactRow[] },
  };
});

// Picks the requested fields, as Prisma's `select` does.
function pick<T extends object>(row: T, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((key) => [key, row[key as keyof T]]));
}

vi.mock("server-only", () => ({}));
vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/openai", () => ({ generateMovieFact, OPENAI_TIMEOUT_MS: 10_000 }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
// Stand-ins for the UI pieces, so the dashboard test can see which user id
// the page hands to the fact component.
vi.mock("@/components/fun-fact", () => ({
  FunFact: function FunFact() {
    return null;
  },
  FunFactSkeleton: () => null,
}));
vi.mock("@/components/auth-buttons", () => ({ SignOutButton: () => null }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where, select }) => {
        const row = db.users.get(where.id);
        return row ? pick(row, select) : null;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const row = db.users.get(where.id);
        if (!row) return { count: 0 };
        if (data.factLockUntil === null) {
          // Release: only if the token matches.
          if (row.factLockUntil?.getTime() !== where.factLockUntil?.getTime()) return { count: 0 };
        } else if (row.factLockUntil && row.factLockUntil >= new Date()) {
          // Acquire: only if free or expired.
          return { count: 0 };
        }
        row.factLockUntil = data.factLockUntil;
        return { count: 1 };
      }),
    },
    fact: {
      findFirst: vi.fn(async ({ where, select }) => {
        const matches = db.facts
          .filter((f) => f.userId === where.userId && f.movie === where.movie)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return matches[0] ? pick(matches[0], select) : null;
      }),
      create: vi.fn(async ({ data, select }) => {
        db.facts.push({ ...data });
        return pick(data, select);
      }),
    },
  },
}));

import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { getFactForUser } from "@/lib/facts";
import { FunFact } from "@/components/fun-fact";
import Dashboard from "@/app/dashboard/page";

const ALICE = "user-alice";
const BOB = "user-bob";

function addUser(id: string, favoriteMovie: string | null) {
  db.users.set(id, {
    id,
    name: id,
    email: `${id}@example.test`,
    image: null,
    favoriteMovie,
    factLockUntil: null,
  });
}

function addFact(userId: string, movie: string, content: string, ageMs: number) {
  db.facts.push({ userId, movie, content, createdAt: new Date(Date.now() - ageMs) });
}

function signInAs(userId: string | null) {
  getServerSession.mockResolvedValue(userId ? { user: { id: userId } } : null);
}

/** Finds the first element of the given component type in a rendered tree. */
function findElement(node: ReactNode, type: unknown): ReactElement | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  const element = node as ReactElement<{ children?: ReactNode }>;
  if (element.type === type) return element;
  return findElement(element.props?.children, type);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  db.users.clear();
  db.facts.length = 0;
  // Both users love the same film, so only the user id can keep them apart.
  addUser(ALICE, "Dune");
  addUser(BOB, "Dune");
  generateMovieFact.mockResolvedValue({ ok: true, fact: "A new fact." });
});

describe("getCurrentUser: the user id comes from the session only", () => {
  it("returns null, and reads nothing, when there is no session", async () => {
    signInAs(null);
    expect(await getCurrentUser()).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the session has no user id", async () => {
    getServerSession.mockResolvedValue({ user: { email: "someone@example.test" } });
    expect(await getCurrentUser()).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("loads exactly the session's user", async () => {
    signInAs(BOB);
    expect(await getCurrentUser()).toMatchObject({ id: BOB });
    expect(vi.mocked(prisma.user.findUnique).mock.calls[0][0].where).toEqual({ id: BOB });
  });
});

describe("Dashboard: facts are only ever requested for the signed-in user", () => {
  it("sends signed-out visitors to the login page without requesting a fact", async () => {
    signInAs(null);
    await expect(Dashboard()).rejects.toThrow("REDIRECT:/login");
    expect(generateMovieFact).not.toHaveBeenCalled();
  });

  it("asks for the session user's fact", async () => {
    signInAs(BOB);
    const funFact = findElement(await Dashboard(), FunFact);
    expect(funFact?.props).toEqual({ userId: BOB });
  });

  it("ignores a user id passed in the URL", async () => {
    signInAs(BOB);
    // Next.js passes route props to pages. The dashboard takes none, so a
    // `?userId=` in the URL has nowhere to go.
    const page = Dashboard as unknown as (props: unknown) => Promise<ReactNode>;
    const tree = await page({ searchParams: Promise.resolve({ userId: ALICE }) });
    expect(findElement(tree, FunFact)?.props).toEqual({ userId: BOB });
  });
});

describe("getFactForUser: one user's facts never reach another user", () => {
  it("does not serve another user's fresh fact for the same movie", async () => {
    addFact(ALICE, "Dune", "Alice's fact.", 1_000);

    const result = await getFactForUser(BOB);

    expect(result).toMatchObject({ status: "fresh", fact: { content: "A new fact." } });
    expect(generateMovieFact).toHaveBeenCalledTimes(1);
  });

  it("stores new facts under the requesting user only", async () => {
    await getFactForUser(BOB);
    expect(db.facts).toEqual([expect.objectContaining({ userId: BOB, content: "A new fact." })]);
  });

  it("never falls back to another user's fact when OpenAI fails", async () => {
    addFact(ALICE, "Dune", "Alice's fact.", 10 * 60_000);
    generateMovieFact.mockResolvedValue({ ok: false, reason: "timeout" });

    expect(await getFactForUser(BOB)).toEqual({ status: "error", reason: "timeout" });
  });

  it("falls back to the user's own earlier fact, not the other user's newer one", async () => {
    addFact(BOB, "Dune", "Bob's old fact.", 60 * 60_000);
    addFact(ALICE, "Dune", "Alice's newer fact.", 5 * 60_000);
    generateMovieFact.mockResolvedValue({ ok: false, reason: "timeout" });

    expect(await getFactForUser(BOB)).toMatchObject({
      status: "stale",
      fact: { content: "Bob's old fact." },
    });
  });

  it("is not blocked by another user's generation lock", async () => {
    // Alice is mid-generation.
    db.users.get(ALICE)!.factLockUntil = new Date(Date.now() + 20_000);

    const result = await getFactForUser(BOB);

    expect(result.status).toBe("fresh");
    expect(generateMovieFact).toHaveBeenCalledTimes(1);
    // Alice's lock is untouched.
    expect(db.users.get(ALICE)!.factLockUntil).not.toBeNull();
  });

  it("scopes every query and write to the requesting user", async () => {
    await getFactForUser(BOB);

    for (const [args] of vi.mocked(prisma.user.findUnique).mock.calls) {
      expect(args.where).toEqual({ id: BOB });
    }
    for (const [args] of vi.mocked(prisma.user.updateMany).mock.calls) {
      expect(args.where).toMatchObject({ id: BOB });
    }
    for (const [args] of vi.mocked(prisma.fact.findFirst).mock.calls) {
      expect(args?.where).toMatchObject({ userId: BOB });
    }
    for (const [args] of vi.mocked(prisma.fact.create).mock.calls) {
      expect(args.data).toMatchObject({ userId: BOB });
    }
  });
});
