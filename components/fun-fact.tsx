import { factErrorMessage, getFactForUser } from "@/lib/facts";

function FactCard({ children }: { children: React.ReactNode }) {
  return (
    <section className="w-full rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-left">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-xs font-medium uppercase tracking-wide text-amber-800">Fun fact</h2>
        <span className="text-[11px] text-amber-700/80">AI-generated, may be inaccurate</span>
      </div>
      <div className="mt-1">{children}</div>
    </section>
  );
}

/**
 * Server component: fetches a fun fact for the signed-in user. Render it
 * inside <Suspense> so the rest of the dashboard doesn't wait for OpenAI.
 * `userId` must come from the server-side session.
 */
export async function FunFact({ userId }: { userId: string }) {
  const result = await getFactForUser(userId);

  if (result.status === "error") {
    return (
      <FactCard>
        <p className="text-sm text-gray-600">{factErrorMessage(result.reason)}</p>
      </FactCard>
    );
  }

  // "fresh" and "cached" look the same: the user doesn't need to know which.
  return (
    <FactCard>
      <p className="break-words text-sm leading-relaxed text-gray-900">{result.fact.content}</p>
      {result.status === "stale" && (
        <p className="mt-2 text-xs text-gray-500">
          Showing an earlier fact. Refresh in a moment for a new one.
        </p>
      )}
    </FactCard>
  );
}

export function FunFactSkeleton() {
  return (
    <FactCard>
      <div role="status" className="animate-pulse space-y-2 py-1">
        <span className="sr-only">Loading a fun fact…</span>
        <div className="h-3 w-full rounded bg-amber-200/70" />
        <div className="h-3 w-4/5 rounded bg-amber-200/70" />
      </div>
    </FactCard>
  );
}
