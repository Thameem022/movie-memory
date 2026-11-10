import { redirect } from "next/navigation";
import { SignOutButton } from "@/components/auth-buttons";
import { getCurrentUser } from "@/lib/session";

export default async function Dashboard() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // First-time users (including ones who left before finishing) onboard first.
  if (!user.favoriteMovie) redirect("/onboarding");

  const { name, email, image, favoriteMovie } = user;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        {image && (
          <img
            src={image}
            alt=""
            referrerPolicy="no-referrer"
            width={64}
            height={64}
            className="rounded-full"
          />
        )}
        <div>
          <p className="font-semibold text-gray-900">{name ?? "No name available"}</p>
          <p className="break-all text-sm text-gray-500">{email}</p>
        </div>
        <div className="w-full rounded-lg bg-gray-50 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
            Favorite movie
          </p>
          <p className="mt-1 break-words font-medium text-gray-900">{favoriteMovie}</p>
        </div>
        <SignOutButton />
      </div>
    </main>
  );
}
