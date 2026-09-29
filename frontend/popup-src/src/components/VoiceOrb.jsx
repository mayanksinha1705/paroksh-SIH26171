import { useEffect, useRef, useState, useCallback } from 'react';
import { X, Mic, Sparkles } from 'lucide-react';

const SpeechRecognitionAPI =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

// Tells the content script (which owns the actual page and the real
// <iframe> element) whether orb mode is currently on, so it can blur any
// text field that grabs focus on the host page — see content.js for why:
// OS-level dictation (e.g. Windows Voice Typing) listens to the same mic
// independently of us and will type straight into whatever's focused there.
function notifyHostVoiceMode(active) {
  try {
    window.parent.postMessage({ source: 'paroksh-panel', type: 'voice-mode', active }, '*');
  } catch {
    // Not running inside the floating panel (e.g. standalone/dev) — no-op.
  }
}

// How long to wait after the user stops talking before we treat whatever
// they said as a finished command and send it off. Long enough to survive
// natural pauses mid-sentence, short enough to still feel hands-free.
const SILENCE_MS = 2000;

/**
 * Full-panel hands-free voice mode.
 *
 * Behavior:
 *  - Mic stays open continuously; there's no "tap to stop" step.
 *  - After ~2s of silence following speech, whatever was said is sent as a
 *    command immediately (no confirmation, no send button).
 *  - If the user starts talking again while the agent is still working on
 *    the previous command, that new command IMMEDIATELY interrupts/stops
 *    the current one and takes over — handled by the parent via onCommand,
 *    this component just keeps listening no matter what `isBusy` is.
 */
export function VoiceOrb({ onClose, onCommand, isBusy, statusLabel }) {
  const [phase, setPhase] = useState('listening'); // 'listening' | 'hearing' | 'busy'
  const [liveText, setLiveText] = useState('');
  const [error, setError] = useState('');

  const recognitionRef = useRef(null);
  const manualStopRef = useRef(false);
  const bufferRef = useRef('');
  const silenceTimerRef = useRef(null);
  const isBusyRef = useRef(isBusy);

  useEffect(() => {
    isBusyRef.current = isBusy;
  }, [isBusy]);

  const clearSilenceTimer = () => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  };

  const armSilenceTimer = useCallback(() => {
    clearSilenceTimer();
    silenceTimerRef.current = setTimeout(() => {
      const command = bufferRef.current.trim();
      bufferRef.current = '';
      setLiveText('');
      if (command) {
        // Fire immediately — if the agent is mid-task this doubles as the
        // interrupt signal, the parent decides how to handle that.
        onCommand(command);
      }
      setPhase('listening');
    }, SILENCE_MS);
  }, [onCommand]);

  const startRecognition = useCallback(() => {
    if (!SpeechRecognitionAPI) {
      setError('Voice mode isn\u2019t supported in this browser.');
      return;
    }
    const recognition = new SpeechRecognitionAPI();
    recognition.lang = 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let interim = '';
      let finalChunk = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalChunk += transcript + ' ';
        } else {
          interim += transcript;
        }
      }
      if (finalChunk) bufferRef.current += finalChunk;
      setLiveText((bufferRef.current + interim).trim());
      setPhase('hearing');
      // Any speech at all — final or still-interim — means the user isn't
      // done yet, so keep pushing the silence deadline back.
      armSilenceTimer();
    };

    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setError('Microphone access was blocked. Allow it in the browser\u2019s site settings.');
        manualStopRef.current = true;
        return;
      }
      // 'no-speech' and transient network blips: just keep the session
      // alive, onend below will restart it.
    };

    recognition.onend = () => {
      if (manualStopRef.current) return;
      // Browsers often auto-stop a continuous session after a pause even
      // though we still want to be listening — restart transparently.
      try {
        recognition.start();
      } catch {
        setTimeout(() => {
          if (!manualStopRef.current) startRecognitionSafe();
        }, 250);
      }
    };

    function startRecognitionSafe() {
      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        /* ignore double-start races */
      }
    }

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setError('Couldn\u2019t start the microphone. Please try again.');
    }
  }, [armSilenceTimer]);

  useEffect(() => {
    manualStopRef.current = false;
    bufferRef.current = '';
    setLiveText('');
    setError('');
    notifyHostVoiceMode(true);
    startRecognition();

    return () => {
      manualStopRef.current = true;
      clearSilenceTimer();
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      notifyHostVoiceMode(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reflect agent busy/idle state, but never stop listening — that's the
  // whole point of orb mode: you can talk over a running task.
  useEffect(() => {
    if (isBusy) {
      setPhase((p) => (p === 'hearing' ? p : 'busy'));
    } else {
      setPhase((p) => (p === 'hearing' ? p : 'listening'));
    }
  }, [isBusy]);

  const handleClose = () => {
    manualStopRef.current = true;
    clearSilenceTimer();
    recognitionRef.current?.stop();
    onClose();
  };

  const ringClass =
    phase === 'hearing'
      ? 'animate-orb-pulse-fast'
      : phase === 'busy'
      ? 'animate-orb-spin'
      : 'animate-orb-pulse-slow';

  const caption = error
    ? error
    : phase === 'hearing'
    ? liveText || 'Listening…'
    : phase === 'busy'
    ? statusLabel || 'Working on it…'
    : isBusy
    ? 'Still listening — say something to jump in'
    : 'Listening… just start talking';

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-background/98 backdrop-blur-sm animate-slide-up">
      <div className="flex items-center justify-between px-4 pt-4 pb-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 text-accent" />
          Voice mode
        </div>
        <button
          type="button"
          onClick={handleClose}
          className="h-7 w-7 rounded-full grid place-items-center text-muted-foreground hover:text-foreground hover:bg-secondary/70 transition-colors"
          title="Exit voice mode"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 flex flex-col items-center justify-center gap-6 px-6">
        <div className="relative h-28 w-28 grid place-items-center">
          {/* Outer glow rings — purely decorative, react to phase via ringClass */}
          <span
            className={`absolute inset-0 rounded-full bg-gradient-to-br from-blue-500/30 to-cyan-400/30 ${ringClass}`}
          />
          <span
            className={`absolute inset-3 rounded-full bg-gradient-to-br from-blue-500/40 to-cyan-400/40 ${
              phase === 'busy' ? 'animate-orb-spin-rev' : ringClass
            }`}
          />
          <span className="relative h-16 w-16 rounded-full bg-gradient-to-br from-blue-500 to-cyan-400 shadow-lg shadow-blue-500/30 grid place-items-center">
            <Mic className="h-6 w-6 text-white" />
          </span>
          {isBusy && (
            <span className="absolute -bottom-1 -right-1 h-4 w-4 rounded-full bg-amber-400 border-2 border-background animate-pulse-dot" />
          )}
        </div>

        <p className="text-center text-sm text-foreground/90 leading-snug max-w-[260px] min-h-[2.5em]">
          {caption}
        </p>

        {isBusy && (
          <p className="text-[11px] text-muted-foreground/70 text-center -mt-3">
            Keep talking anytime to interrupt and switch tasks
          </p>
        )}
      </div>

      <div className="pb-4 text-center text-[10px] text-muted-foreground/60 flex-shrink-0">
        Pauses of ~2s send your command automatically
      </div>
    </div>
  );
}
