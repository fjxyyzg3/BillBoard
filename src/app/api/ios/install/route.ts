import { grantIosInstall } from "@/lib/ios-install";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return grantIosInstall(request);
}
