import React, { useCallback, useEffect, useRef, useState, useMemo } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";

import { getTtsStatus, saveInterviewTranscript, speakWithPiper } from "./api";
import { useSpeechRecognition } from "./useSpeechRecognition";

type ChatMode =
  | "general"
  | "ofertas"
  | "contacto"
  | "deep"
  | "training"
  | "project"
  | "apply"
  | "decision-maker";

export type InterviewContext = {
  reportNumber: string;
  company: string;
  role: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

const MODES: { value: ChatMode; label: string; hint: string }[] = [
  { value: "general", label: "General", hint: "Free-form career advice using your full profile context" },
  { value: "ofertas", label: "Compare Offers", hint: "Compare multiple evaluated offers side-by-side" },
  { value: "contacto", label: "LinkedIn Outreach", hint: "Generate targeted LinkedIn connection messages" },
  { value: "deep", label: "Company Research", hint: "Deep research on a company for interview prep" },
  { value: "training", label: "Evaluate Training", hint: "Evaluate whether a course or cert is worth taking" },
  { value: "project", label: "Evaluate Project", hint: "Score a portfolio project idea on 6 dimensions" },
  { value: "apply", label: "Application Helper", hint: "Generate answers for application form questions" },
];

function classNames(...xs: Array<string | false | undefined | null>) {
  return xs.filter(Boolean).join(" ");
}

let msgCounter = 0;
function nextId() {
  return `msg-${++msgCounter}-${Date.now()}`;
}

export function Chat(props: { interviewContext?: InterviewContext | null; onExitInterview?: () => void }) {
  const interviewContext = props.interviewContext ?? null;
  const inInterview = interviewContext !== null;
  const [mode, setMode] = useState<ChatMode>(inInterview ? "decision-maker" : "general");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Speech-to-text (browser, Chrome/Edge only).
  const stt = useSpeechRecognition();
  const handleMicFinal = useCallback((text: string) => {
    setInput((prev) => {
      const trimmed = text.trim();
      if (!trimmed) return prev;
      return prev ? `${prev} ${trimmed}` : trimmed;
    });
  }, []);
  function handleMicToggle() {
    stt.toggle(handleMicFinal);
  }

  // Piper TTS (server-side neural voice). Probed once on mount; played per assistant turn when on.
  const [ttsAvailable, setTtsAvailable] = useState<boolean | null>(null);
  const [ttsVoice, setTtsVoice] = useState<string | null>(null);
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("career-ops:tts-enabled") === "1";
    } catch {
      return false;
    }
  });
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let ignore = false;
    getTtsStatus()
      .then((s) => {
        if (ignore) return;
        setTtsAvailable(s.available);
        setTtsVoice(s.voice ?? null);
      })
      .catch(() => {
        if (!ignore) setTtsAvailable(false);
      });
    return () => {
      ignore = true;
    };
  }, []);

  function setTtsEnabledPersisted(v: boolean) {
    setTtsEnabled(v);
    try {
      window.localStorage.setItem("career-ops:tts-enabled", v ? "1" : "0");
    } catch {
      // ignore storage failures
    }
    if (!v && audioRef.current) {
      audioRef.current.pause();
    }
  }

  function stopAudio() {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        // ignore
      }
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
  }

  const playAssistantAudio = useCallback(
    async (text: string) => {
      if (!ttsEnabled || !ttsAvailable) return;
      try {
        stopAudio();
        const url = await speakWithPiper(text);
        audioUrlRef.current = url;
        const audio = new Audio(url);
        audioRef.current = audio;
        audio.onended = () => {
          stopAudio();
        };
        await audio.play();
      } catch (err) {
        console.warn("Piper TTS failed:", err);
      }
    },
    [ttsEnabled, ttsAvailable],
  );

  // Stop any playing audio when the user starts a new send.
  useEffect(() => {
    if (streaming) stopAudio();
  }, [streaming]);

  // Clean up audio on unmount.
  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, []);

  // Reset transcript whenever a new interview context arrives.
  useEffect(() => {
    if (interviewContext) {
      setMode("decision-maker");
      setMessages([]);
      setStreamingText("");
      setInput("");
      setSavedNotice(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interviewContext?.reportNumber]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingText, scrollToBottom]);

  function handleModeChange(newMode: ChatMode) {
    if (inInterview) return; // mode is locked when scoped to a role
    if (newMode === mode) return;
    if (messages.length > 0 && !window.confirm("Changing modes will clear the conversation. Continue?")) {
      return;
    }
    setMode(newMode);
    setMessages([]);
    setStreamingText("");
    setInput("");
  }

  function buildTranscriptMarkdown(): string {
    return messages
      .map((m) => `**${m.role === "user" ? "Candidate" : "Decision Maker"}:**\n\n${m.content}\n`)
      .join("\n---\n\n");
  }

  async function handleSaveTranscript() {
    if (!interviewContext || messages.length === 0) return;
    try {
      const md = buildTranscriptMarkdown();
      const res = await saveInterviewTranscript(interviewContext.reportNumber, md);
      setSavedNotice(`Saved → ${res.path}`);
      window.setTimeout(() => setSavedNotice(null), 4000);
    } catch (e) {
      setSavedNotice(`Save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function handleClear() {
    if (messages.length === 0) return;
    if (!window.confirm("Clear the conversation?")) return;
    setMessages([]);
    setStreamingText("");
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  async function handleSend() {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: Message = { id: nextId(), role: "user", content: text };
    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    setInput("");
    setStreaming(true);
    setStreamingText("");

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const apiMessages = nextMessages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const body: { mode: ChatMode; messages: typeof apiMessages; reportNumber?: string } = {
        mode,
        messages: apiMessages,
      };
      if (interviewContext) body.reportNumber = interviewContext.reportNumber;

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;

          try {
            const parsed = JSON.parse(payload);
            if (parsed.type === "text") {
              fullText += parsed.text;
              setStreamingText(fullText);
            } else if (parsed.type === "error") {
              fullText += `\n\n**Error:** ${parsed.error}`;
              setStreamingText(fullText);
            }
          } catch {
            // skip malformed SSE lines
          }
        }
      }

      if (fullText) {
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", content: fullText },
        ]);
        // In interview mode with TTS enabled, narrate the response.
        if (inInterview) {
          void playAssistantAudio(fullText);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        const partial = streamingText;
        if (partial) {
          setMessages((prev) => [
            ...prev,
            { id: nextId(), role: "assistant", content: partial + "\n\n*(stopped)*" },
          ]);
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          { id: nextId(), role: "assistant", content: `**Error:** ${msg}` },
        ]);
      }
    } finally {
      setStreaming(false);
      setStreamingText("");
      abortRef.current = null;
      inputRef.current?.focus();
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  }

  const currentModeHint = MODES.find((m) => m.value === mode)?.hint || "";
  const atLimit = messages.length >= 50;

  return (
    <section className="flex h-[calc(100vh-120px)] flex-col rounded-3xl bg-zinc-900/30 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-800/60 px-5 py-3">
        {inInterview ? (
          <>
            <div className="flex items-center gap-2">
              <span className="rounded-lg bg-fuchsia-500/15 px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-fuchsia-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
                Interview prep
              </span>
              <span className="text-xs text-zinc-300">
                #{interviewContext?.reportNumber} · {interviewContext?.company} — {interviewContext?.role}
              </span>
            </div>
          </>
        ) : (
          <>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              Mode
              <select
                value={mode}
                onChange={(e) => handleModeChange(e.target.value as ChatMode)}
                className="rounded-lg bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]"
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </select>
            </label>
            <span className="text-xs text-zinc-500">{currentModeHint}</span>
          </>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {savedNotice && (
            <span className="text-[11px] text-emerald-300">{savedNotice}</span>
          )}
          {inInterview && ttsAvailable !== null && (
            <button
              onClick={() => setTtsEnabledPersisted(!ttsEnabled)}
              disabled={!ttsAvailable}
              title={
                ttsAvailable
                  ? `${ttsEnabled ? "Mute" : "Unmute"} interviewer voice (${ttsVoice ?? "piper"})`
                  : "Run `npm run setup:tts` from web/ to enable neural TTS"
              }
              className={classNames(
                "rounded-lg px-2.5 py-1.5 text-xs shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition",
                !ttsAvailable && "bg-zinc-950/40 text-zinc-500 cursor-help",
                ttsAvailable && ttsEnabled && "bg-cyan-500/15 text-cyan-200 hover:bg-cyan-500/25",
                ttsAvailable && !ttsEnabled && "bg-zinc-950/60 text-zinc-300 hover:bg-zinc-950/80",
              )}
            >
              {!ttsAvailable ? "🔇 voice off (no piper)" : ttsEnabled ? "🔊 voice on" : "🔈 voice off"}
            </button>
          )}
          {inInterview && (
            <button
              onClick={() => void handleSaveTranscript()}
              disabled={messages.length === 0 || streaming}
              className="rounded-lg bg-emerald-500/15 px-2.5 py-1.5 text-xs text-emerald-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-emerald-500/25 disabled:opacity-30"
            >
              Save transcript
            </button>
          )}
          {inInterview && props.onExitInterview && (
            <button
              onClick={props.onExitInterview}
              className="rounded-lg bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80"
            >
              Exit interview
            </button>
          )}
          {streaming && (
            <button
              onClick={handleStop}
              className="rounded-lg bg-rose-500/15 px-2.5 py-1.5 text-xs text-rose-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-rose-500/25"
            >
              Stop
            </button>
          )}
          <button
            onClick={handleClear}
            disabled={messages.length === 0 && !streaming}
            className="rounded-lg bg-zinc-950/60 px-2.5 py-1.5 text-xs text-zinc-300 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80 disabled:opacity-30"
          >
            Clear chat
          </button>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {messages.length === 0 && !streaming && (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-md text-center">
              <div className="text-sm font-medium text-zinc-300">
                {inInterview ? "Mock interview" : "career-ops chat"}
              </div>
              <div className="mt-1 text-xs text-zinc-500">
                {inInterview
                  ? "You'll be interviewed by the hiring manager for this role. Each answer is scored 1–10 with the exact 10/10 rewrite. Send a short opener like \"I'm ready\" to begin."
                  : `${currentModeHint}. Your CV, profile, and career context are loaded automatically.`}
              </div>
              <div className="mt-4 grid gap-2 text-left">
                {inInterview && <Suggestion text="I'm ready — start the interview." />}
                {!inInterview && mode === "general" && <Suggestion text='What roles am I best suited for right now?' />}
                {!inInterview && mode === "ofertas" && <Suggestion text='Compare offers #001 and #003 — which should I prioritize?' />}
                {!inInterview && mode === "contacto" && <Suggestion text='Write a LinkedIn message for the hiring manager at Anthropic for a Sales Enablement role' />}
                {!inInterview && mode === "deep" && <Suggestion text='Do a deep dive on Vericast — I have an interview coming up' />}
                {!inInterview && mode === "training" && <Suggestion text='Should I get the Salesforce Sales Cloud certification?' />}
                {!inInterview && mode === "project" && <Suggestion text='Evaluate a project idea: an AI-powered enablement content recommender' />}
                {!inInterview && mode === "apply" && <Suggestion text='Help me answer these application questions: [paste questions]' />}
              </div>
            </div>
          </div>
        )}

        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}

        {streaming && streamingText && (
          <MessageBubble
            message={{ id: "streaming", role: "assistant", content: streamingText }}
            isStreaming
          />
        )}

        {streaming && !streamingText && (
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
            <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
            Thinking...
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-zinc-800/60 px-5 py-3">
        {atLimit ? (
          <div className="flex items-center justify-between rounded-xl bg-zinc-950/40 px-4 py-3">
            <span className="text-xs text-zinc-400">Conversation limit reached (50 messages).</span>
            <button
              onClick={handleClear}
              className="rounded-lg bg-zinc-950/60 px-3 py-1.5 text-xs text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] hover:bg-zinc-950/80"
            >
              Start new conversation
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={
                  stt.isListening
                    ? "Listening… click the mic again to stop."
                    : "Type a message… (Enter to send, Shift+Enter for newline)"
                }
                rows={2}
                disabled={streaming}
                className="flex-1 resize-none rounded-xl bg-zinc-950/60 px-4 py-3 text-sm text-zinc-100 placeholder:text-zinc-500 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] disabled:opacity-50"
              />
              {stt.supported && (
                <button
                  onClick={handleMicToggle}
                  disabled={streaming}
                  title={stt.isListening ? "Stop recording" : "Record voice (Chrome/Edge)"}
                  className={classNames(
                    "self-end rounded-xl px-3 py-3 text-sm shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition disabled:opacity-40",
                    stt.isListening
                      ? "bg-rose-500/25 text-rose-100 ring-1 ring-rose-400/60 animate-pulse"
                      : "bg-zinc-950/60 text-zinc-200 hover:bg-zinc-950/80",
                  )}
                  aria-label={stt.isListening ? "Stop recording" : "Start recording"}
                >
                  {stt.isListening ? "● Rec" : "🎤"}
                </button>
              )}
              <button
                onClick={() => void handleSend()}
                disabled={streaming || !input.trim()}
                className="self-end rounded-xl bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-5 py-3 text-sm font-semibold text-zinc-950 hover:opacity-95 disabled:opacity-40"
              >
                Send
              </button>
            </div>
            {(stt.interim || stt.error) && (
              <div className="px-1 text-[11px] text-zinc-500">
                {stt.error ? (
                  <span className="text-rose-300">mic: {stt.error}</span>
                ) : (
                  <span className="italic">…{stt.interim}</span>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function MessageBubble({ message, isStreaming }: { message: Message; isStreaming?: boolean }) {
  const html = useMemo(() => {
    const raw = marked.parse(message.content || "");
    return DOMPurify.sanitize(String(raw));
  }, [message.content]);

  const isUser = message.role === "user";

  return (
    <div className={classNames("mt-3 flex", isUser && "justify-end")}>
      <div
        className={classNames(
          "max-w-[85%] rounded-2xl px-4 py-3 text-sm",
          isUser
            ? "bg-zinc-800/60 text-zinc-100 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
            : "bg-zinc-950/40 text-zinc-200 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
        )}
      >
        {isUser ? (
          <div className="whitespace-pre-wrap">{message.content}</div>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none">
            <div dangerouslySetInnerHTML={{ __html: html }} />
            {isStreaming && (
              <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-cyan-400" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Suggestion({ text }: { text: string }) {
  return (
    <div className="rounded-xl bg-zinc-950/40 px-3 py-2 text-xs text-zinc-400 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]">
      <span className="text-zinc-500">Try:</span> {text}
    </div>
  );
}
