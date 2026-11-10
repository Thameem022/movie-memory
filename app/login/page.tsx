import { redirect } from "next/navigation";
import { SignInButton } from "@/components/auth-buttons";
import { getCurrentUser } from "@/lib/session";

const LOGIN_ERRORS: Record<string, string> = {
  OAuthAccountNotLinked: "This email is already linked to a different sign-in method.",
  AccessDenied: "This Google account doesn't have access.",
};
const DEFAULT_LOGIN_ERROR = "We couldn't sign you in. Please try again.";

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const user = await getCurrentUser();
  if (user) redirect(user.favoriteMovie ? "/dashboard" : "/onboarding");

  const { error } = await searchParams;
  const errorMessage = error
    ? (typeof error === "string" && LOGIN_ERRORS[error]) || DEFAULT_LOGIN_ERROR
    : null;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Movie Memory</h1>
          <p className="mt-2 text-sm text-gray-500">Sign in to continue</p>
        </div>
        {errorMessage && (
          <p role="alert" className="w-full rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">
            {errorMessage}
          </p>
        )}
        <SignInButton />
      </div>
    </main>
  );
}
