import { redirect } from "next/navigation";
import { OnboardingForm } from "@/components/onboarding-form";
import { getCurrentUser } from "@/lib/session";

export default async function Onboarding() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // Onboarding is first-time only.
  if (user.favoriteMovie) redirect("/dashboard");

  const firstName = user.name?.split(" ")[0];

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {firstName ? `Welcome, ${firstName}!` : "Welcome!"}
          </h1>
          <p className="mt-2 text-sm text-gray-500">What&apos;s your favorite movie?</p>
        </div>
        <OnboardingForm />
      </div>
    </main>
  );
}
