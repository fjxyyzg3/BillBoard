import { afterEach, describe, expect, it, vi } from "vitest";
import { GET, HEAD } from "@/app/api/voice/audio/route";
import { createVoiceAudioLease } from "@/lib/voice/audio-store";
import { wav } from "../fixtures/voice-wav";

const leases: Array<{ url: string; dispose(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(leases.splice(0).map((lease) => lease.dispose()));
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function create() {
  vi.stubEnv("VOICE_AUDIO_PUBLIC_ORIGIN", "https://audio.example.test");
  const lease = await createVoiceAudioLease(wav());
  leases.push(lease);
  return lease;
}

function expectPrivateHeaders(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow, noarchive");
  expect(response.headers.get("set-cookie")).toBeNull();
}

describe("public token-authorized voice audio download", () => {
  it("serves the exact WAV without session cookies and gives HEAD only its metadata", async () => {
    const lease = await create();
    const get = await GET(new Request(lease.url));
    expect(get.status).toBe(200);
    expectPrivateHeaders(get);
    expect(get.headers.get("content-type")).toBe("audio/wav");
    expect(get.headers.get("content-length")).toBe(String(wav().byteLength));
    expect(Buffer.from(await get.arrayBuffer())).toEqual(wav());
    const head = await HEAD(new Request(lease.url, { method: "HEAD" }));
    expect(head.status).toBe(200);
    expectPrivateHeaders(head);
    expect(head.headers.get("content-length")).toBe(String(wav().byteLength));
    expect(await head.text()).toBe("");
  });

  it("uses identical empty 404 responses for missing, unknown, malformed and revoked tokens", async () => {
    const lease = await create();
    await lease.dispose();
    for (const url of [lease.url, "https://audio.example.test/api/voice/audio", "https://audio.example.test/api/voice/audio?token=bad",
      `https://audio.example.test/api/voice/audio?token=${"a".repeat(43)}`, `${lease.url}&token=second`, `${lease.url}&path=/outside.wav`]) {
      for (const handler of [GET, HEAD]) {
        const response = await handler(new Request(url));
        expect(response.status).toBe(404);
        expectPrivateHeaders(response);
        expect(await response.text()).toBe("");
      }
    }
  });

  it("rejects expired URLs for both GET and HEAD", async () => {
    vi.useFakeTimers();
    const lease = await create();
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await GET(new Request(lease.url))).status).toBe(404);
    expect((await HEAD(new Request(lease.url, { method: "HEAD" }))).status).toBe(404);
  });
});
