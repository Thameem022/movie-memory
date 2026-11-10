import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/session";

// "/" has no page of its own. It sends each visitor where they belong.
export default async function Home() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(user.favoriteMovie ? "/dashboard" : "/onboarding");
}
