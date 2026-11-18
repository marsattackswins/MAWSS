import { useAppStore } from "@/lib/store";

/**
 * sounds.ts — feedback sounds for the trading HMI: order/position execution and
 * price alerts. Driven by the persisted `executionSound` / `alertSound` /
 * `executionSoundName` chart settings. WebAudio oscillator beeps: no audio
 * assets needed.
 */

type SoundName = "alarm" | "beep" | "chime";

const PROFILES: Record<SoundName, { freq: number; notes: number; durMs: number; gain: number }> = {
  beep: { freq: 880, notes: 1, durMs: 120, gain: 0.12 },
  chime: { freq: 660, notes: 2, durMs: 160, gain: 0.10 },
  alarm: { freq: 520, notes: 3, durMs: 140, gain: 0.14 },
};

let ctx: AudioContext | null = null;

function audioCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function soundName(value: string): SoundName {
  return (["alarm", "beep", "chime"] as const).includes(value as SoundName)
    ? (value as SoundName)
    : "alarm";
}

/** Play one of the configured tones (no-op when the browser has no WebAudio). */
function playTone(name: SoundName): void {
  const ac = audioCtx();
  if (!ac) return;
  const profile = PROFILES[name];
  const t0 = ac.currentTime;
  for (let i = 0; i < profile.notes; i += 1) {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const start = t0 + i * (profile.durMs / 1000) * 1.4;
    osc.type = "sine";
    osc.frequency.setValueAtTime(profile.freq * (name === "chime" ? 1 + i * 0.35 : 1), start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(profile.gain, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + profile.durMs / 1000);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + profile.durMs / 1000 + 0.05);
  }
}

/** Play the configured execution sound (no-op when muted or unsupported). */
export function playExecutionSound(): void {
  const s = useAppStore.getState().chartSettings;
  if (s.executionSound !== true) return;
  playTone(soundName(s.executionSoundName));
}

/** Alert tone. Its own switch, so muting trade sounds keeps alerts audible —
 *  and a trade fill never turns into a missed level. */
export function playAlertSound(): void {
  const s = useAppStore.getState().chartSettings;
  if (s.alertSound !== true) return;
  playTone(soundName(s.executionSoundName));
}
