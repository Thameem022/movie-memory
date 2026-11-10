"use server";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { parseFavoriteMovie } from "@/lib/validation";

export type OnboardingState = {
  error: string | null;
  // What the user typed, so the field keeps it after a failed submit.
  movie: string;
};

export async function saveFavoriteMovie(
  _prev: OnboardingState,
  formData: FormData,
): Promise<OnboardingState> {
  // Only the server-side session decides whose row is written. Any user id in
  // the form data is ignored.
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) redirect("/login");

  const raw = formData.get("movie");
  const movie = typeof raw === "string" ? raw : "";
  const parsed = parseFavoriteMovie(raw);
  if (!parsed.ok) return { error: parsed.error, movie };

  try {
    // `favoriteMovie: null` makes onboarding first-time only, checked in the
    // same statement as the write. A second submit (double click, another
    // tab) matches no row and leaves the saved movie alone.
    const { count } = await prisma.user.updateMany({
      where: { id: userId, favoriteMovie: null },
      data: { favoriteMovie: parsed.value },
    });
    console.info(`[onboarding] user=${userId} saved=${count === 1}`);
  } catch (error) {
    // Log the user id only, never the input.
    console.error(`[onboarding] failed to save movie for user=${userId}`, error);
    return { error: "We couldn't save your movie. Please try again.", movie };
  }

  // Outside the try block: redirect() works by throwing.
  redirect("/dashboard");
}
