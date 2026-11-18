import { isVoiceAudioLeaseActive, readVoiceAudioLease } from "@/lib/voice/audio-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const privateHeaders = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

async function download(request: Request, head: boolean) {
  try {
    const params = new URL(request.url).searchParams;
    const token = params.get("token");
    if (params.size === 1 && token && !request.signal.aborted) {
      const audio = await readVoiceAudioLease(token);
      if (audio && isVoiceAudioLeaseActive(token) && !request.signal.aborted) {
        return new Response(head ? null : new Uint8Array(audio), { headers: {
          ...privateHeaders, "Content-Type": "audio/wav", "Content-Length": String(audio.byteLength),
        } });
      }
    }
  } catch {
    // Never expose filesystem failures, configuration, or token validity through error details.
  }
  return new Response(null, { status: 404, headers: privateHeaders });
}

export async function GET(request: Request) { return download(request, false); }
export async function HEAD(request: Request) { return download(request, true); }
