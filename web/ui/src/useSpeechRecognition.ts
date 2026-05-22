import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Thin wrapper around the browser's Web Speech API SpeechRecognition.
 * - Chrome / Edge support it natively (engine = Google Cloud Speech, free to the user).
 * - Safari has partial support; Firefox does not. The hook reports `supported = false` there.
 *
 * Use pattern: pass `onFinal` to `toggle()` (or `start()`). Each finalized utterance
 * fires the callback with the transcript text. UI is expected to accumulate those
 * into a textarea so the user can review/edit before sending.
 */
export function useSpeechRecognition() {
  const [supported, setSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const finalHandlerRef = useRef<((text: string) => void) | null>(null);

  useEffect(() => {
    const w = window as any;
    setSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
  }, []);

  const stop = useCallback(() => {
    try {
      recognitionRef.current?.stop();
    } catch {
      // already stopped
    }
    setIsListening(false);
    setInterim("");
  }, []);

  const start = useCallback(
    (onFinal: (text: string) => void) => {
      if (!supported || isListening) return;
      const w = window as any;
      const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
      const rec = new SR();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-US";

      finalHandlerRef.current = onFinal;
      setError(null);

      rec.onresult = (e: any) => {
        let interimStr = "";
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const transcript: string = e.results[i][0].transcript;
          if (e.results[i].isFinal) {
            finalHandlerRef.current?.(transcript);
          } else {
            interimStr += transcript;
          }
        }
        setInterim(interimStr);
      };

      rec.onerror = (e: any) => {
        setError(typeof e?.error === "string" ? e.error : "speech-recognition error");
        setIsListening(false);
        setInterim("");
      };

      rec.onend = () => {
        setIsListening(false);
        setInterim("");
      };

      recognitionRef.current = rec;
      try {
        rec.start();
        setIsListening(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [supported, isListening],
  );

  const toggle = useCallback(
    (onFinal: (text: string) => void) => {
      if (isListening) stop();
      else start(onFinal);
    },
    [isListening, start, stop],
  );

  useEffect(() => {
    return () => {
      try {
        recognitionRef.current?.abort();
      } catch {
        // ignore
      }
    };
  }, []);

  return { supported, isListening, interim, error, toggle, start, stop };
}
