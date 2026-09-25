import { useCallback, useEffect, useRef, useState } from "react";
import { applyCallTranscriptEvent, type CallTranscriptMessage } from "../react/features/voice-call/call-transcript";

export type CallUiState = "IDLE" | "LISTENING" | "THINKING" | "SPEAKING" | "ERROR" | "ENDED";

const AUDIO_MOUTH_DELAY_MS = 800;

export function useCallSession() {
  const [state, setState] = useState<CallUiState>("IDLE");
  const [messages, setMessages] = useState<CallTranscriptMessage[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState("");
  const [volume, setVolume] = useState(0);
  const stateRef = useRef<CallUiState>("IDLE");
  const analyserRef = useRef<AnalyserNode | null>(null);
  const analyserDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const micRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const vadIntervalRef = useRef<number | null>(null);
  const silenceTimerRef = useRef<number | null>(null);
  const hasSpokenRef = useRef(false);
  const pendingRef = useRef(false);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const speechTokenRef = useRef(0);
  const vadThresholdRef = useRef(0.01);
  const vadSilenceRef = useRef(1000);

  const transition = useCallback((next: CallUiState) => {
    stateRef.current = next;
    setState(next);
    if (next === "LISTENING") pendingRef.current = false;
    if (next === "LISTENING" || next === "THINKING" || next === "SPEAKING") {
      startedAtRef.current ??= Date.now();
    }
    if (next === "ENDED") startedAtRef.current = null;
  }, []);

  const submitTurn = useCallback(() => {
    if (stateRef.current !== "LISTENING" || pendingRef.current) return;
    pendingRef.current = true;
    hasSpokenRef.current = false;
    if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = null;
    window.call?.turnEnd();
  }, []);

  const stopPlayback = useCallback(() => {
    speechTokenRef.current++;
    if (currentAudioRef.current) {
      currentAudioRef.current.pause();
      currentAudioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    window.live2dSpeech?.stopMouth();
  }, []);

  const stopMicrophone = useCallback(() => {
    if (vadIntervalRef.current !== null) window.clearInterval(vadIntervalRef.current);
    if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
    vadIntervalRef.current = null;
    silenceTimerRef.current = null;
    try { workletRef.current?.disconnect(); } catch { /* already disconnected */ }
    workletRef.current = null;
    try { analyserRef.current?.disconnect(); } catch { /* already disconnected */ }
    analyserRef.current = null;
    micRef.current?.getTracks().forEach((track) => track.stop());
    micRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") void context.close();
  }, []);

  const startMicrophone = useCallback(async (vadThreshold: number, vadSilenceMs: number) => {
    if (micRef.current) return;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("当前环境无法访问麦克风");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      if (stateRef.current === "ENDED") {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      micRef.current = stream;
      const context = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = context;
      await context.audioWorklet.addModule(new URL("../call/pcm-processor.js", import.meta.url));
      if (stateRef.current === "ENDED") {
        stream.getTracks().forEach((track) => track.stop());
        void context.close();
        return;
      }
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      analyserRef.current = analyser;
      analyserDataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
      source.connect(analyser);

      const worklet = new AudioWorkletNode(context, "pcm-processor");
      workletRef.current = worklet;
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => window.call?.sendAudioFrame(event.data);
      source.connect(worklet);

      vadIntervalRef.current = window.setInterval(() => {
        const activeAnalyser = analyserRef.current;
        const data = analyserDataRef.current;
        if (!activeAnalyser || !data || stateRef.current !== "LISTENING") return;
        activeAnalyser.getByteFrequencyData(data);
        const average = data.reduce((total, value) => total + value, 0) / data.length / 255;
        setVolume(average);
        if (average >= vadThreshold) {
          hasSpokenRef.current = true;
          if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        } else if (hasSpokenRef.current && silenceTimerRef.current === null) {
          silenceTimerRef.current = window.setTimeout(() => {
            silenceTimerRef.current = null;
            submitTurn();
          }, vadSilenceMs);
        }
      }, 100);
    } catch (cause) {
      stopMicrophone();
      setError(cause instanceof Error ? cause.message : "无法访问麦克风，请检查权限");
      transition("ERROR");
    }
  }, [stopMicrophone, submitTurn, transition]);

  const hangup = useCallback(() => {
    window.call?.stop();
    stopMicrophone();
    stopPlayback();
    transition("ENDED");
    window.setTimeout(() => window.close(), 350);
  }, [stopMicrophone, stopPlayback, transition]);

  useEffect(() => {
    let disposed = false;
    const call = window.call;
    const off = [
      call?.onState((next) => {
        transition(next as CallUiState);
        if (next === "LISTENING") void startMicrophone(vadThresholdRef.current, vadSilenceRef.current);
      }),
      call?.onAsrResult((result) => {
        if (result.partial) {
          setError("");
          setMessages((items) => applyCallTranscriptEvent(items, { speaker: "user", text: result.partial!, final: false }));
        }
        if (result.final) {
          setError("");
          setMessages((items) => applyCallTranscriptEvent(items, { speaker: "user", text: result.final!, final: true }));
        }
      }),
      call?.onTtsAudio(({ base64, text }) => {
        setError("");
        if (text) setMessages((items) => applyCallTranscriptEvent(items, { speaker: "assistant", text, final: true }));
        stopPlayback();
        const token = ++speechTokenRef.current;
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/mp3" }));
        audioUrlRef.current = url;
        const audio = new Audio(url);
        currentAudioRef.current = audio;
        window.live2dSpeech?.prepare();
        const finish = () => {
          if (speechTokenRef.current !== token) return;
          if (audioUrlRef.current === url) {
            URL.revokeObjectURL(url);
            audioUrlRef.current = null;
          }
          currentAudioRef.current = null;
          window.live2dSpeech?.stopMouth();
          call?.ttsDone();
        };
        audio.onended = finish;
        audio.onerror = finish;
        void audio.play().catch(finish);
        audio.addEventListener("loadedmetadata", () => {
          if (speechTokenRef.current !== token || !Number.isFinite(audio.duration)) return;
          window.setTimeout(() => {
            if (speechTokenRef.current === token) window.live2dSpeech?.startMouth(Math.max(0, audio.duration * 1000 - AUDIO_MOUTH_DELAY_MS));
          }, AUDIO_MOUTH_DELAY_MS);
        }, { once: true });
      }),
      call?.onError(({ message }) => setError(message)),
    ].filter((unsubscribe): unsubscribe is () => void => typeof unsubscribe === "function");

    void (async () => {
      const settings = await window.tts?.loadSettings().catch(() => undefined);
      if (disposed) return;
      vadThresholdRef.current = typeof settings?.asrVadThreshold === "number" ? settings.asrVadThreshold : 0.01;
      vadSilenceRef.current = typeof settings?.asrVadSilenceMs === "number" ? settings.asrVadSilenceMs : 1000;
      call?.start();
    })();

    const timer = window.setInterval(() => {
      if (startedAtRef.current !== null) setElapsed(Date.now() - startedAtRef.current);
    }, 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      off.forEach((unsubscribe) => unsubscribe());
      stopMicrophone();
      stopPlayback();
      if (stateRef.current !== "ENDED") call?.stop();
    };
  }, [startMicrophone, stopMicrophone, stopPlayback, transition]);

  return { state, messages, elapsed, error, volume, submitTurn, hangup };
}
