import { cache } from "react";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * Returns the signed-in user's row from the database, or null when signed out.
 * The id always comes from the server-side session, never from the request.
 * Cached per request, so a page and its children share one lookup.
 */
export const getCurrentUser = cache(async () => {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return null;

  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, email: true, image: true, favoriteMovie: true },
  });
});
