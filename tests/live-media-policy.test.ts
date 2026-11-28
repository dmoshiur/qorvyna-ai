import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import nextConfig from "../next.config";

it("allows same-origin camera/mic with browser consent, not arbitrary frame origins", async () => {
  const rules = await nextConfig.headers!();
  const policy = rules.flatMap((rule) => rule.headers).find((header) => header.key === "Permissions-Policy")!.value;
  expect(policy).toContain("camera=(self)"); expect(policy).toContain("microphone=(self)");
  expect(policy).not.toContain("*");
});

it.each([44100, 48000])("worklet batches device audio at %i Hz to contiguous 16 kHz frames", (sampleRate) => {
  const frames: Float32Array[] = [];
  let Processor!: new () => { process: (inputs: Float32Array[][]) => boolean };
  runInNewContext(readFileSync("public/audio/live-capture.js", "utf8"), {
    sampleRate,
    AudioWorkletProcessor: class { port = { postMessage: (frame: Float32Array) => frames.push(frame) }; },
    registerProcessor: (_name: string, constructor: typeof Processor) => { Processor = constructor; },
  });
  const processor = new Processor();
  for (let i = 0; i < sampleRate; i += 128) {
    expect(processor.process([[new Float32Array(Math.min(128, sampleRate - i)).fill(0.5)]])).toBe(true);
  }
  expect(frames.length).toBe(Math.floor(16000 / 2048));
  expect(frames.every((frame) => frame.length === 2048 && frame.every((value) => value === 0.5))).toBe(true);
});
