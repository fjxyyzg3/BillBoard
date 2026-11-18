import { afterEach, describe, expect, it, vi } from "vitest";
import { createVoicePress, VOICE_LONG_PRESS_MS } from "@/lib/voice/press";

afterEach(() => vi.useRealTimers());

function press() {
  const onLongPress = vi.fn();
  const onCancelChange = vi.fn();
  return { ...createVoicePress({ onLongPress, onCancelChange }), onLongPress, onCancelChange };
}

describe("voice press", () => {
  it("leaves a short press as ordinary navigation without starting recording", () => {
    vi.useFakeTimers();
    const gesture = press();
    expect(gesture.begin(1, 100)).toBe(true);
    vi.advanceTimersByTime(VOICE_LONG_PRESS_MS - 1);
    expect(gesture.end(1)).toBe("short");
    vi.runAllTimers();
    expect(gesture.onLongPress).not.toHaveBeenCalled();
  });

  it("records only after the hold threshold and does not submit until release", () => {
    vi.useFakeTimers();
    const gesture = press();
    gesture.begin(1, 100);
    vi.advanceTimersByTime(VOICE_LONG_PRESS_MS);
    expect(gesture.onLongPress).toHaveBeenCalledOnce();
    expect(gesture.end(2)).toBe("ignored");
    expect(gesture.end(1)).toBe("submit");
    expect(gesture.end(1)).toBe("ignored");
  });

  it("allows sliding up to cancel and returning before release to send", () => {
    vi.useFakeTimers();
    const gesture = press();
    gesture.begin(1, 200);
    vi.advanceTimersByTime(VOICE_LONG_PRESS_MS);
    gesture.move(1, 140);
    expect(gesture.onCancelChange).toHaveBeenLastCalledWith(true);
    gesture.move(1, 141);
    expect(gesture.onCancelChange).toHaveBeenLastCalledWith(false);
    expect(gesture.end(1)).toBe("submit");
    gesture.begin(1, 200);
    vi.advanceTimersByTime(VOICE_LONG_PRESS_MS);
    gesture.move(1, 100);
    expect(gesture.end(1)).toBe("cancel");
  });

  it("ignores other pointers and cancels the timer when interrupted", () => {
    vi.useFakeTimers();
    const gesture = press();
    gesture.begin(1, 200);
    expect(gesture.begin(2, 200)).toBe(false);
    gesture.move(2, 100);
    gesture.cancel();
    vi.runAllTimers();
    expect(gesture.onLongPress).not.toHaveBeenCalled();
    expect(gesture.end(1)).toBe("ignored");
    expect(gesture.begin(2, 200)).toBe(true);
  });
});
