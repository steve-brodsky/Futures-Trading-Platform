import type { AlertDurationSeconds, AlertSound } from "../types";

let context: AudioContext | undefined;
let activeNodes: AudioScheduledSourceNode[] = [];
let output: AudioNode | undefined;

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

function alertOutput(ctx: AudioContext): AudioNode {
  if (output) return output;
  const compressor = ctx.createDynamicsCompressor();
  const master = ctx.createGain();
  compressor.threshold.value = -12;
  compressor.knee.value = 10;
  compressor.ratio.value = 12;
  compressor.attack.value = .003;
  compressor.release.value = .18;
  master.gain.value = 1.05;
  compressor.connect(master).connect(ctx.destination);
  output = compressor;
  return output;
}

function tone(ctx: AudioContext, destination: AudioNode, start: number, duration: number, frequency: number, type: OscillatorType = "sine", endFrequency?: number, peak = .34, detune = 0) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  oscillator.detune.setValueAtTime(detune, start);
  if (endFrequency != null) oscillator.frequency.linearRampToValueAtTime(endFrequency, start + duration);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peak, start + Math.min(0.018, duration / 3));
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain).connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
  activeNodes.push(oscillator);
}

function schedulePattern(ctx: AudioContext, sound: AlertSound, start: number, available: number): number {
  const destination = alertOutput(ctx);
  const add = (offset: number, duration: number, frequency: number, type: OscillatorType = "sine", endFrequency?: number, peak?: number, detune?: number) => {
    if (available <= offset) return;
    tone(ctx, destination, start + offset, Math.min(duration, available - offset), frequency, type, endFrequency, peak, detune);
  };
  if (sound === "chime") {
    add(0, .52, 659.25, "sine", undefined, .38);
    add(0, .38, 1318.5, "triangle", undefined, .16);
    add(.14, .58, 830.61, "sine", undefined, .36);
    add(.14, .42, 1661.22, "triangle", undefined, .14);
    add(.28, .72, 987.77, "sine", undefined, .4);
    add(.28, .5, 1975.54, "triangle", undefined, .14);
    return 1.08;
  }
  if (sound === "bell") {
    add(0, .74, 740, "sine", undefined, .46);
    add(0, .58, 1110, "sine", undefined, .24, 5);
    add(0, .44, 1776, "triangle", undefined, .18, -7);
    add(.38, .52, 740, "sine", undefined, .32);
    add(.38, .4, 1480, "triangle", undefined, .14);
    return 1.12;
  }
  if (sound === "pulse") {
    [0, .22, .44].forEach((offset, index) => {
      add(offset, .15, 620 + index * 70, "square", undefined, .3);
      add(offset, .17, 310 + index * 35, "sine", undefined, .28);
    });
    return .84;
  }
  add(0, .42, 430, "sawtooth", 920, .29);
  add(0, .42, 645, "triangle", 1380, .26, 6);
  add(.44, .42, 920, "sawtooth", 430, .29);
  add(.44, .42, 1380, "triangle", 645, .26, -6);
  return .96;
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
