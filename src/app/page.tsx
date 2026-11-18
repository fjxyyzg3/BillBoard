import { auth } from "@/auth";
import { isOpsAdminInstance } from "@/lib/ops/config";
import { redirect } from "next/navigation";

export default async function RootPage() {
  if (isOpsAdminInstance()) {
    redirect("/ops");
  }

  const session = await auth();

  redirect(session?.user ? "/home" : "/login");
}
