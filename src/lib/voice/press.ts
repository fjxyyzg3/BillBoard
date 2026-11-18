export const VOICE_LONG_PRESS_MS = 400;
export const VOICE_CANCEL_DISTANCE_PX = 60;

export function createVoicePress(callbacks: {
  onLongPress: () => void;
  onCancelChange: (cancelled: boolean) => void;
}) {
  let held: { pointerId: number; y: number; long: boolean; cancelled: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cancel = () => {
    clearTimeout(timer);
    held = null;
  };

  return {
    begin(pointerId: number, y: number) {
      if (held) return false;
      held = { pointerId, y, long: false, cancelled: false };
      timer = setTimeout(() => {
        if (!held) return;
        held.long = true;
        callbacks.onLongPress();
        if (held?.cancelled) callbacks.onCancelChange(true);
      }, VOICE_LONG_PRESS_MS);
      return true;
    },
    move(pointerId: number, y: number) {
      if (!held || held.pointerId !== pointerId) return;
      const cancelled = held.y - y >= VOICE_CANCEL_DISTANCE_PX;
      if (held.cancelled === cancelled) return;
      held.cancelled = cancelled;
      if (held.long) callbacks.onCancelChange(cancelled);
    },
    end(pointerId: number): "short" | "submit" | "cancel" | "ignored" {
      if (!held || held.pointerId !== pointerId) return "ignored";
      const result = held.cancelled ? "cancel" : held.long ? "submit" : "short";
      cancel();
      return result;
    },
    cancel,
  };
}
