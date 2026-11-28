// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JARVIS_SETTINGS_KEY, DEFAULT_JARVIS_SETTINGS } from "@/lib/voice/jarvis-engine";
vi.mock("@/components/voice/native-assistant-panel", () => ({ NativeAssistantPanel: () => null }));
vi.mock("@/lib/client/api", () => ({ rpc: vi.fn(), RpcCallError: class extends Error {}, optionalAuthHeaders: async () => ({}) }));
vi.mock("@/components/modal", () => ({ Modal: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <div role="dialog">{children}</div> : null }));
import { JarvisAssistantBar } from "@/components/voice/jarvis-assistant-bar";
import { useVoiceRecorder } from "@/lib/client/use-voice-recorder";
import { speakPlainText, stopSpeech } from "@/lib/chat-speech";

class Recognition {
  static instances: Recognition[] = [];
  continuous = false; interimResults = false; lang = "";
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  start = vi.fn(); stop = vi.fn();
  constructor() { Recognition.instances.push(this); }
}
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  Recognition.instances = [];
  vi.stubGlobal("SpeechRecognition", Recognition);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  localStorage.setItem(JARVIS_SETTINGS_KEY, JSON.stringify({ ...DEFAULT_JARVIS_SETTINGS, wakeEnabled: true }));
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); stopSpeech(); container.remove(); localStorage.clear(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const props = () => ({ speaking: false, autoSpeak: true, voiceLang: "en-US", onVoiceLangChange: vi.fn(), onToggleAutoSpeak: vi.fn(), onInterruptSpeech: vi.fn(), onStartPushToTalk: vi.fn(), onSubmitSpokenCommand: vi.fn(), onJarvisNotice: vi.fn() });

describe("wake microphone ownership", () => {
  it("does not reconnect on streamed token renders / changed callback identities", async () => {
    await act(async () => root.render(<JarvisAssistantBar {...props()} />));
    for (let i = 0; i < 20; i++) await act(async () => root.render(<JarvisAssistantBar {...props()} />));
    expect(Recognition.instances).toHaveLength(1);
    expect(Recognition.instances[0].start).toHaveBeenCalledOnce();
    expect(Recognition.instances[0].stop).not.toHaveBeenCalled();
  });
  it("stops during generation, recording and playback, cancelling pending restart timers", async () => {
    const base = props();
    await act(async () => root.render(<JarvisAssistantBar {...base} />));
    const rec = Recognition.instances[0];
    await act(async () => rec.onend?.());
    await act(async () => root.render(<JarvisAssistantBar {...base} captureBusy />));
    await act(async () => vi.advanceTimersByTime(10000));
    expect(rec.start).toHaveBeenCalledOnce(); expect(rec.stop).toHaveBeenCalledOnce();
    await act(async () => root.render(<JarvisAssistantBar {...base} speaking />));
    expect(Recognition.instances).toHaveLength(1);
    await act(async () => root.render(<JarvisAssistantBar {...base} recording />));
    expect(container.textContent).toContain("Recording your command");
    await act(async () => root.render(<JarvisAssistantBar {...base} />));
    expect(Recognition.instances).toHaveLength(2);
  });
  it("hands wake activation to real recorder only after recognition releases mic", async () => {
    const base = props(); await act(async () => root.render(<JarvisAssistantBar {...base} />));
    const rec = Recognition.instances[0];
    await act(async () => rec.onresult?.({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "Hey AI" } }] }));
    expect(rec.stop).toHaveBeenCalledOnce();
    expect(base.onStartPushToTalk).not.toHaveBeenCalled();
    await act(async () => rec.onend?.());
    expect(base.onStartPushToTalk).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTime(10000));
    expect(rec.start).toHaveBeenCalledOnce();
  });
  it("stops on hidden tabs and resumes only when visible", async () => {
    const base = props(); await act(async () => root.render(<JarvisAssistantBar {...base} />));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(Recognition.instances[0].stop).toHaveBeenCalledOnce();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(Recognition.instances).toHaveLength(2);
  });
  it("does not retry permission/service failures", async () => {
    await act(async () => root.render(<JarvisAssistantBar {...props()} />));
    const rec = Recognition.instances[0];
    await act(async () => rec.onerror?.({ error: "not-allowed" }));
    await act(async () => vi.advanceTimersByTime(60000));
    expect(rec.start).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("not-allowed");
  });
});

describe("browser speech settles even without native end events", () => {
  function synth(voices = [{ lang: "en-US", name: "English" }]) {
    const speak = vi.fn();
    vi.stubGlobal("speechSynthesis", { cancel: vi.fn(), speak, getVoices: () => voices, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal("SpeechSynthesisUtterance", class { text: string; constructor(text: string) { this.text = text; } });
    return speak;
  }
  it("resets owner on explicit cancellation, once", () => {
    synth(); const end = vi.fn();
    speakPlainText("Hello", { onend: end }); stopSpeech(); stopSpeech();
    expect(end).toHaveBeenCalledOnce();
  });
  it("bounds missing end/error callbacks with a watchdog", () => {
    synth(); const error = vi.fn();
    speakPlainText("Hello", { onerror: error }); vi.advanceTimersByTime(20000);
    expect(error).toHaveBeenCalledOnce();
  });
  it("does not silently substitute an English-only voice for Bangla", () => {
    const speak = synth(); const error = vi.fn();
    speakPlainText("বাংলা", { lang: "bn-BD", onerror: error });
    expect(error).toHaveBeenCalledOnce(); expect(speak).not.toHaveBeenCalled();
  });
});


it("releases a recorder permission grant arriving after cancellation", async () => {
  let grant!: (stream: unknown) => void;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(() => new Promise((resolve) => { grant = resolve; })) } });
  vi.stubGlobal("MediaRecorder", class {});
  let recorder!: ReturnType<typeof useVoiceRecorder>;
  function Harness() { recorder = useVoiceRecorder(); return null; }
  await act(async () => root.render(<Harness />));
  let pending!: ReturnType<typeof recorder.start>;
  await act(async () => { pending = recorder.start(); });
  expect(recorder.state).toBe("requesting");
  await act(async () => recorder.cancel());
  const track = { stop: vi.fn() };
  await act(async () => { grant({ getTracks: () => [track] }); await pending; });
  expect(track.stop).toHaveBeenCalledOnce();
  expect(recorder.state).toBe("idle");
});
