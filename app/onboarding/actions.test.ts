import { beforeEach, describe, expect, it, vi } from "vitest";

const { getServerSession, updateMany } = vi.hoisted(() => ({
  getServerSession: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock("next-auth", () => ({ getServerSession }));
vi.mock("@/lib/auth", () => ({ authOptions: {} }));
vi.mock("@/lib/prisma", () => ({ prisma: { user: { updateMany } } }));
// Like the real one, redirect() throws so the action stops there.
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

import { saveFavoriteMovie } from "@/app/onboarding/actions";

const initial = { error: null, movie: "" };

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

describe("saveFavoriteMovie", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    getServerSession.mockResolvedValue({ user: { id: "user-1" } });
    updateMany.mockResolvedValue({ count: 1 });
  });

  it("redirects to sign-in and writes nothing when signed out", async () => {
    getServerSession.mockResolvedValue(null);
    await expect(saveFavoriteMovie(initial, form({ movie: "Up" }))).rejects.toThrow("REDIRECT:/login");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("returns the validation error and writes nothing for bad input", async () => {
    const result = await saveFavoriteMovie(initial, form({ movie: "   " }));
    expect(result.error).toBeTruthy();
    expect(result.movie).toBe("   ");
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("saves the trimmed movie for the session user only, then goes to the dashboard", async () => {
    // A user id in the form data must be ignored.
    const data = form({ movie: "  Spirited Away ", userId: "someone-else" });
    await expect(saveFavoriteMovie(initial, data)).rejects.toThrow("REDIRECT:/dashboard");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", favoriteMovie: null },
      data: { favoriteMovie: "Spirited Away" },
    });
  });

  it("does not overwrite a movie that is already saved", async () => {
    // The `favoriteMovie: null` filter matches nothing, so nothing changes.
    updateMany.mockResolvedValue({ count: 0 });
    await expect(saveFavoriteMovie(initial, form({ movie: "Alien" }))).rejects.toThrow(
      "REDIRECT:/dashboard",
    );
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: "user-1", favoriteMovie: null });
  });

  it("returns a friendly error when the database fails", async () => {
    updateMany.mockRejectedValue(new Error("connection refused"));
    const result = await saveFavoriteMovie(initial, form({ movie: "Up" }));
    expect(result).toEqual({ error: "We couldn't save your movie. Please try again.", movie: "Up" });
  });
});
