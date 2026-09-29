import { useState, useRef } from 'react';
import { Send, Mic, Square } from 'lucide-react';

const SpeechRecognitionAPI =
  typeof window !== 'undefined'
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null;

export function InputComposer({ onSend, onStop, disabled, isStopping, onOpenOrb }) {
  const [input, setInput] = useState('');
  const textareaRef = useRef(null);

  const handleSubmit = (e, textOverride) => {
    e?.preventDefault();
    const text = (textOverride ?? input).trim();
    if (!text || disabled) return;
    onSend(text);
    setInput('');
    requestAnimationFrame(() => {
      if (textareaRef.current) textareaRef.current.style.height = 'auto';
      textareaRef.current?.focus();
    });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleChange = (e) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = Math.min(e.target.scrollHeight, 90) + 'px';
  };

  const isEmpty = !input.trim();

  return (
    <div className="p-2.5 border-t border-border/50 flex-shrink-0">
      <form onSubmit={handleSubmit}>
        <div className="rounded-xl border border-border/70 bg-secondary/30">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Type an instruction…"
            disabled={disabled}
            rows={1}
            className="min-h-[36px] max-h-[90px] w-full resize-none bg-transparent border-0 px-3 pt-2.5 pb-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50"
          />
          <div className="flex items-center justify-between px-2.5 pb-1.5">
            <span className="text-[10px] text-muted-foreground/80">
              {isStopping
                ? 'Stopping…'
                : disabled
                ? 'Working… tap stop to cancel'
                : 'Enter to send · Shift+Enter for new line'}
            </span>
            <div className="flex items-center gap-1.5 flex-shrink-0">
              {SpeechRecognitionAPI && (
                <button
                  type="button"
                  onClick={onOpenOrb}
                  className="h-7 w-7 rounded-full grid place-items-center bg-secondary text-muted-foreground hover:bg-secondary/70 hover:text-foreground transition-colors"
                  title="Hands-free voice mode"
                >
                  <Mic className="h-3.5 w-3.5" />
                </button>
              )}
              {disabled ? (
                <button
                  type="button"
                  onClick={onStop}
                  disabled={isStopping}
                  className={`h-7 w-7 rounded-full text-white grid place-items-center flex-shrink-0 transition-colors ${
                    isStopping
                      ? 'bg-red-500/50 cursor-wait'
                      : 'bg-red-500 hover:bg-red-600'
                  }`}
                  title={isStopping ? 'Stopping…' : 'Stop'}
                >
                  <Square className="h-3 w-3" fill="currentColor" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={isEmpty}
                  className="h-7 w-7 rounded-full bg-slate-800 hover:bg-slate-700 text-white grid place-items-center disabled:opacity-30 disabled:cursor-not-allowed flex-shrink-0"
                  title="Send"
                >
                  <Send className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  );
}
