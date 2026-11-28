"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { LiveConnectConfig, LiveServerMessage, Session } from "@google/genai";
import { isNativeShell } from "@/native/native-bridge";
import { Modal } from "@/components/modal";
import { Button } from "@/components/ui";
import { optionalAuthHeaders } from "@/lib/client/api";
import { decodePcm16, pcm16Base64 } from "@/lib/voice/live-audio";

type Resources = {
  context: AudioContext;
  controller: AbortController;
  session?: Session;
  stream?: MediaStream;
  source?: MediaStreamAudioSourceNode;
  worklet?: AudioWorkletNode;
  silent?: GainNode;
  timers: ReturnType<typeof setTimeout>[];
  frames?: ReturnType<typeof setInterval>;
  sources: Set<AudioBufferSourceNode>;
  nextAt: number;
  ready: boolean;
  muted: boolean;
  discardOutput: boolean;
};

export function LiveConversation({ open, onClose, language }: { open: boolean; onClose: () => void; language: string }) {
  const [state, setState] = useState<"idle" | "connecting" | "listening" | "speaking">("idle");
  const [error, setError] = useState("");
  const [camera, setCamera] = useState(false);
  const [muted, setMuted] = useState(false);
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const current = useRef<Resources | null>(null);

  const clearPlayback = useCallback((run: Resources) => {
    for (const source of run.sources) {
      source.onended = null;
      try { source.stop(); } catch { /* already ended */ }
      source.disconnect();
    }
    run.sources.clear();
    run.nextAt = 0;
  }, []);

  const stop = useCallback(() => {
    const run = current.current;
    current.current = null; // Invalidate every async continuation before cleanup.
    if (run) {
      run.ready = false;
      run.controller.abort();
      run.timers.forEach(clearTimeout);
      clearInterval(run.frames);
      run.stream?.getTracks().forEach((track) => { track.onended = null; track.stop(); });
      if (run.worklet) { run.worklet.port.onmessage = null; run.worklet.port.close(); run.worklet.disconnect(); }
      run.source?.disconnect();
      run.silent?.disconnect();
      clearPlayback(run);
      try { run.session?.close(); } catch { /* socket already closed */ }
      void run.context.close().catch(() => {});
    }
    if (video.current) video.current.srcObject = null;
    setState("idle");
    setMuted(false);
  }, [clearPlayback]);

  useEffect(() => {
    if (!open) stop();
    return stop;
  }, [open, stop]);
  useEffect(() => {
    const hidden = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", stop);
    return () => { document.removeEventListener("visibilitychange", hidden); window.removeEventListener("pagehide", stop); };
  }, [stop]);

  async function start() {
    if (current.current) return;
    if (isNativeShell()) {
      setError("Live voice/video is currently available on the web. Open QORVYNA in your browser; the installed app keeps its existing voice assistant.");
      return;
    }
    setError(""); setInput(""); setOutput("");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      setError("Live audio needs HTTPS and a browser supporting microphone access and AudioWorklet. Try a current Chrome, Edge, Safari or Firefox browser.");
      return;
    }
    let context: AudioContext;
    try { context = new AudioContext(); } catch {
      setError("Audio output could not start. Check your browser's audio settings."); return;
    }
    const run: Resources = { context, controller: new AbortController(), sources: new Set(), timers: [], nextAt: 0, ready: false, muted: false, discardOutput: false };
    current.current = run;
    setState("connecting");
    const active = () => current.current === run;
    const fail = (message: string) => { if (active()) { stop(); setError(message); } };
    run.timers.push(setTimeout(() => fail("Connection timed out. Check permissions and try again."), 30000));
    const receive = (message: LiveServerMessage) => {
      if (!active()) return;
      try {
        if (message.setupComplete) run.ready = true;
        const content = message.serverContent;
        if (!content) return;
        if (content.interrupted) { clearPlayback(run); run.discardOutput = false; setState("listening"); }
        if (content.inputTranscription?.text) setInput((text) => (text + content.inputTranscription!.text).slice(-4000));
        if (content.outputTranscription?.text) setOutput((text) => (text + content.outputTranscription!.text).slice(-6000));
        for (const part of content.modelTurn?.parts ?? []) {
          const data = part.inlineData;
          if (!data?.data || !data.mimeType?.startsWith("audio/pcm") || run.discardOutput) continue;
          const rate = Number(data.mimeType.match(/rate=(\d+)/)?.[1] ?? 24000);
          if (rate < 8000 || rate > 96000) throw new Error("Unsupported sample rate");
          const samples = decodePcm16(data.data);
          if (!samples.length) continue;
          if (run.nextAt - context.currentTime > 30) throw new Error("Playback queue exceeded");
          const buffer = context.createBuffer(1, samples.length, rate);
          buffer.copyToChannel(new Float32Array(samples), 0);
          const source = context.createBufferSource();
          source.buffer = buffer;
          source.connect(context.destination);
          run.sources.add(source);
          source.onended = () => {
            run.sources.delete(source); source.disconnect();
            if (active() && run.sources.size === 0) setState("listening");
          };
          const at = Math.max(context.currentTime, run.nextAt);
          source.start(at); run.nextAt = at + buffer.duration;
          setState("speaking");
        }
        if (content.turnComplete) { run.discardOutput = false; if (!run.sources.size) setState("listening"); }
      } catch { fail("Live audio playback failed. Ended the session safely; please retry."); }
    };
    try {
      await context.resume();
      if (!active()) return;
      const response = await fetch("/api/voice/live-token", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...(await optionalAuthHeaders()) },
        body: JSON.stringify({ language }), signal: run.controller.signal,
      });
      const grant = await response.json() as { token?: string; model: string; config: LiveConnectConfig; expiresAt: number; error?: string };
      if (!active()) return;
      if (!response.ok || !grant.token) throw new Error(grant.error || "Live session could not be authorized.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: camera ? { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "environment" } : false,
      });
      if (!active()) { stream.getTracks().forEach((track) => track.stop()); return; }
      run.stream = stream;
      stream.getTracks().forEach((track) => { track.onended = () => fail("Microphone or camera disconnected. Session ended."); });
      if (video.current && camera) { video.current.srcObject = stream; await video.current.play(); }
      await context.audioWorklet.addModule("/audio/live-capture.js");
      if (!active()) return;
      const { GoogleGenAI } = await import("@google/genai");
      if (!active()) return;
      const ai = new GoogleGenAI({ apiKey: grant.token, httpOptions: { apiVersion: "v1alpha" } });
      const session = await ai.live.connect({
        model: grant.model, config: grant.config,
        callbacks: {
          onmessage: receive,
          onerror: () => fail("Gemini Live connection failed. Check model availability, network and quota."),
          onclose: () => fail("Live session ended. Start a new session to continue."),
        },
      });
      if (!active()) { session.close(); return; }
      run.session = session;
      run.ready = true;
      clearTimeout(run.timers[0]);
      run.timers.push(setTimeout(() => fail("The 10-minute session limit was reached. Start a new session to continue."), Math.max(0, grant.expiresAt - Date.now())));
      const source = context.createMediaStreamSource(stream);
      const worklet = new AudioWorkletNode(context, "live-capture");
      const silent = context.createGain(); silent.gain.value = 0;
      run.source = source; run.worklet = worklet; run.silent = silent;
      source.connect(worklet); worklet.connect(silent); silent.connect(context.destination);
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!active() || !run.ready || run.muted) return;
        // Keep one stream alive, but never feed the assistant's reply back in.
        const samples = run.sources.size ? new Float32Array(event.data.length) : event.data;
        try { session.sendRealtimeInput({ audio: { data: pcm16Base64(samples), mimeType: "audio/pcm;rate=16000" } }); }
        catch { fail("The audio connection was lost. Session ended."); }
      };
      if (camera) {
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 480;
        run.frames = setInterval(() => {
          if (!active() || !run.ready || !stream.getVideoTracks().some((track) => track.readyState === "live")) return;
          const element = video.current;
          if (!element || element.readyState < 2) return;
          try {
            canvas.getContext("2d")?.drawImage(element, 0, 0, 640, 480);
            session.sendRealtimeInput({ video: { data: canvas.toDataURL("image/jpeg", 0.6).split(",")[1], mimeType: "image/jpeg" } });
          } catch { fail("Camera streaming failed. Session ended."); }
        }, 1000);
      }
      setState("listening");
    } catch (err) {
      fail(err instanceof Error && err.name === "NotAllowedError" ? "Microphone/camera permission was denied. Enable access in browser settings and try again." : err instanceof Error ? err.message : "Could not start Live.");
    }
  }

  return <Modal open={open} onClose={() => { stop(); onClose(); }} title="Live voice & video">
    <div className="space-y-4">
      <p className="text-sm text-ink-2">Talk naturally and get streamed voice replies. Optional camera shares one frame per second with Google Gemini. This separate session does not use your chat history or execute agent tools. This app does not save live media; Google's data policies apply.</p>
      <p className="text-xs text-ink-3">Language: {language === "auto" ? "Follow your spoken language" : language}. Availability depends on the configured model. Use headphones to reduce echo. Sessions end after 10 minutes or when the tab is hidden.</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={camera} disabled={state !== "idle"} onChange={(event) => setCamera(event.target.checked)} />Share camera when starting</label>
      <video ref={video} autoPlay playsInline muted className={camera ? "max-h-64 w-full rounded-xl bg-black" : "hidden"} aria-label="Your camera preview" />
      <p role="status" aria-live="polite" className="font-medium">{state === "speaking" ? "AI speaking" : state === "listening" ? muted ? "Microphone muted" : "Listening — speak now" : state === "connecting" ? "Connecting…" : "Ready — press Start to allow microphone access"}</p>
      {error && <p role="alert" className="text-sm text-warning">{error}</p>}
      {input && <p className="text-sm" dir="auto"><strong>You: </strong>{input}</p>}
      {output && <p className="text-sm" dir="auto"><strong>QORVYNA: </strong>{output}</p>}
      <div className="flex flex-wrap gap-2">
        {state === "idle" ? <Button onClick={() => void start()}>Start Live</Button> : <>
          <Button variant="danger" onClick={stop}>End session</Button>
          {state !== "connecting" && <>
            <Button variant="ghost" onClick={() => {
              const run = current.current; if (!run) return;
              run.muted = !run.muted;
              run.stream?.getAudioTracks().forEach((track) => { track.enabled = !run.muted; });
              if (run.muted) { try { run.session?.sendRealtimeInput({ audioStreamEnd: true }); } catch { stop(); } }
              setMuted(run.muted);
            }}>{muted ? "Unmute" : "Mute microphone"}</Button>
            <Button variant="ghost" onClick={() => {
              const run = current.current; if (!run) return;
              clearPlayback(run); run.discardOutput = true; setState("listening");
            }}>Interrupt reply</Button>
            {camera && <Button variant="ghost" onClick={() => {
              const run = current.current;
              clearInterval(run?.frames);
              run?.stream?.getVideoTracks().forEach((track) => { track.onended = null; track.stop(); });
              if (video.current) video.current.srcObject = null;
              setCamera(false);
            }}>Stop camera</Button>}
          </>}
        </>}
      </div>
    </div>
  </Modal>;
}
