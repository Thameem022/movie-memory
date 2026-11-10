"use client";

import "./globals.css";
import { ErrorFallback } from "@/components/error-fallback";

// Catches errors in the root layout. It replaces that layout when active,
// so it has to provide its own html, body and styles.
export default function GlobalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorFallback error={error} retry={retry} />
      </body>
    </html>
  );
}
