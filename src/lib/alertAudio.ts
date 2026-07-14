import type { AlertDurationSeconds, AlertSound } from "../types";

let context: AudioContext | undefined;
let activeNodes: AudioScheduledSourceNode[] = [];

function audioContext(): AudioContext {
  context ??= new AudioContext();
  if (context.state === "suspended") void context.resume();
  return context;
}

export function prepareAlertAudio() {
  audioContext();
}

function stopActive() {
  activeNodes.forEach((node) => {
    try { node.stop(); } catch { /* already stopped */ }
  });
  activeNodes = [];
}

function tone(ctx: AudioContext, output: AudioNode, start: number, duration: number, frequency: number, type: OscillatorType = "sine", endFrequency?: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (endFrequency != null) oscillator.frequency.linearRampToValueAtTime(endFrequency, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + Math.min(0.025, duration / 3));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(output);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
  activeNodes.push(oscillator);
}

function schedulePattern(ctx: AudioContext, sound: AlertSound, start: number, available: number): number {
  const output = ctx.destination;
  if (sound === "chime") {
    tone(ctx, output, start, Math.min(.28, available), 660);
    if (available > .2) tone(ctx, output, start + .18, Math.min(.42, available - .18), 990);
    return .85;
  }
  if (sound === "bell") {
    tone(ctx, output, start, Math.min(.62, available), 784, "sine");
    tone(ctx, output, start, Math.min(.48, available), 1568, "sine");
    return .9;
  }
  if (sound === "pulse") {
    tone(ctx, output, start, Math.min(.16, available), 520, "square");
    if (available > .26) tone(ctx, output, start + .26, Math.min(.16, available - .26), 520, "square");
    return .72;
  }
  tone(ctx, output, start, Math.min(.52, available), 420, "sawtooth", 860);
  if (available > .55) tone(ctx, output, start + .55, Math.min(.52, available - .55), 860, "sawtooth", 420);
  return 1.18;
}

export function playAlertSound(sound: AlertSound, durationSeconds: AlertDurationSeconds | 1 = 1) {
  const ctx = audioContext();
  stopActive();
  const start = ctx.currentTime + .025;
  let offset = 0;
  while (offset < durationSeconds) {
    const cycle = schedulePattern(ctx, sound, start + offset, durationSeconds - offset);
    offset += cycle;
  }
}
