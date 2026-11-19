import { handleIosUpdate } from "@/lib/ios-install";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  return handleIosUpdate(request, "check");
}

export async function POST(request: Request) {
  return handleIosUpdate(request, "grant");
}
