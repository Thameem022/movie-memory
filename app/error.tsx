"use client";

import { ErrorFallback } from "@/components/error-fallback";

// Catches errors thrown by pages, and keeps the root layout on screen.
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  return <ErrorFallback error={error} retry={retry} />;
}
