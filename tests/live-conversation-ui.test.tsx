// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LiveServerMessage } from "@google/genai";
const mocks = vi.hoisted(() => ({ connect: vi.fn(), send: vi.fn(), close: vi.fn() }));
vi.mock("@google/genai", () => ({ GoogleGenAI: class { live = { connect: mocks.connect }; } }));
vi.mock("@/native/native-bridge", () => ({ isNativeShell: () => false }));
vi.mock("@/lib/client/api", () => ({ optionalAuthHeaders: async () => ({}) }));
vi.mock("@/components/modal", () => ({ Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
import { LiveConversation } from "@/components/voice/live-conversation";

class Node {
  connect = vi.fn(); disconnect = vi.fn();
  port = { onmessage: null as ((event: { data: Float32Array }) => void) | null, close: vi.fn() };
}
class Source extends Node {
  buffer: unknown; onended: (() => void) | null = null;
  start = vi.fn(); stop = vi.fn();
}
class Context {
  static instances: Context[] = [];
  currentTime = 0; destination = {};
  resume = vi.fn(async () => {}); close = vi.fn(async () => {});
  audioWorklet = { addModule: vi.fn(async () => {}) };
  sources: Source[] = [];
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, copyToChannel: vi.fn() }; }
  createMediaStreamSource = () => new Node();
  createGain = () => Object.assign(new Node(), { gain: { value: 1 } });
  constructor() { Context.instances.push(this); }
}
class Worklet extends Node {
  static instances: Worklet[] = [];
  constructor() { super(); Worklet.instances.push(this); }
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let receive: (message: LiveServerMessage) => void;
let closed: () => void;
let mic: { enabled: boolean; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };
let getMedia: ReturnType<typeof vi.fn>;
const button = (text: string) => [...container.querySelectorAll("button")].find((element) => element.textContent === text)!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers(); Context.instances = []; Worklet.instances = [];
  mocks.connect.mockReset().mockImplementation(async ({ callbacks }) => {
    receive = callbacks.onmessage; closed = callbacks.onclose;
    return { sendRealtimeInput: mocks.send, close: mocks.close };
  });
  mocks.send.mockReset(); mocks.close.mockReset();
  mic = { enabled: true, stop: vi.fn(), onended: null };
  getMedia = vi.fn(async () => ({ getTracks: () => [mic], getAudioTracks: () => [mic], getVideoTracks: () => [] }));
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: getMedia } });
  vi.stubGlobal("AudioContext", Context); vi.stubGlobal("AudioWorkletNode", Worklet);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ token: "auth_tokens/test", model: "live-model", config: {}, expiresAt: Date.now() + 600000 })));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const render = (open = true) => root.render(<LiveConversation open={open} onClose={() => {}} language="bn-BD" />);

it("streams PCM on one retained mic, settles speaking at playback end, and cleans up on close", async () => {
  await act(async () => render());
  await act(async () => button("Start Live").click());
  expect(getMedia).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("Listening — speak now");
  const frame = { data: new Float32Array([0.5, -0.5]) };
  Worklet.instances[0].port.onmessage?.(frame);
  expect(mocks.send).toHaveBeenLastCalledWith({ audio: { data: expect.any(String), mimeType: "audio/pcm;rate=16000" } });
  await act(async () => receive({ serverContent: { modelTurn: { parts: [{ inlineData: { data: btoa("\u0000\u0040"), mimeType: "audio/pcm;rate=24000" } }] } } } as LiveServerMessage));
  expect(container.textContent).toContain("AI speaking");
  Worklet.instances[0].port.onmessage?.(frame);
  expect(mocks.send).toHaveBeenLastCalledWith({ audio: { data: "AAAAAA==", mimeType: "audio/pcm;rate=16000" } });
  await act(async () => Context.instances[0].sources[0].onended?.());
  expect(container.textContent).toContain("Listening — speak now");
  expect(getMedia).toHaveBeenCalledOnce(); expect(mic.stop).not.toHaveBeenCalled();
  await act(async () => render(false));
  expect(mic.stop).toHaveBeenCalledOnce(); expect(mocks.close).toHaveBeenCalledOnce();
  expect(Context.instances[0].close).toHaveBeenCalledOnce();
  expect(Worklet.instances[0].port.onmessage).toBeNull();
});

it("mutes without reopening capture and clears state on provider disconnect", async () => {
  await act(async () => render()); await act(async () => button("Start Live").click());
  await act(async () => button("Mute microphone").click());
  expect(mic.enabled).toBe(false);
  expect(mocks.send).toHaveBeenCalledWith({ audioStreamEnd: true });
  const calls = mocks.send.mock.calls.length;
  Worklet.instances[0].port.onmessage?.({ data: new Float32Array([1]) });
  expect(mocks.send).toHaveBeenCalledTimes(calls);
  await act(async () => button("Unmute").click()); expect(mic.enabled).toBe(true);
  expect(getMedia).toHaveBeenCalledOnce();
  await act(async () => closed());
  expect(container.textContent).toContain("Live session ended");
  expect(button("Start Live")).toBeTruthy(); expect(mic.stop).toHaveBeenCalledOnce();
});

it("stops media granted after the user cancelled a pending permission prompt", async () => {
  let grant!: (stream: unknown) => void;
  getMedia.mockImplementationOnce(() => new Promise((resolve) => { grant = resolve; }));
  await act(async () => render()); await act(async () => button("Start Live").click());
  expect(container.textContent).toContain("Connecting");
  await act(async () => button("End session").click());
  await act(async () => grant({ getTracks: () => [mic] }));
  expect(mic.stop).toHaveBeenCalledOnce(); expect(mocks.connect).not.toHaveBeenCalled();
});

it("bounds connection attempts and closes late sessions rather than reviving capture", async () => {
  let connected!: (session: unknown) => void;
  mocks.connect.mockImplementationOnce(() => new Promise((resolve) => { connected = resolve; }));
  await act(async () => render()); await act(async () => button("Start Live").click());
  await act(async () => vi.advanceTimersByTime(30001));
  expect(container.textContent).toContain("Connection timed out");
  expect(mic.stop).toHaveBeenCalledOnce();
  await act(async () => connected({ close: mocks.close }));
  expect(mocks.close).toHaveBeenCalledOnce(); expect(Worklet.instances).toHaveLength(0);
});
