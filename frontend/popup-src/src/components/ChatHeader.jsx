import { useState, useRef, useEffect } from 'react';
import { Sparkles, Settings, Plus, Sun, Moon, Trash2, X, Download, BarChart3 } from 'lucide-react';
import { cn } from '../lib/utils.js';

// When PAROKSH runs as a floating in-page panel (injected into the host page
// as an <iframe>), the ✕ button here closes it by telling the content
// script (which owns the actual <iframe> element) via window.postMessage.
// Dragging is handled entirely by the content script itself, via an
// invisible strip laid over this title area from the host page — not from
// in here — because iframe-relative mouse coordinates don't line up with
// the host page's coordinate space, which made in-iframe dragging jumpy.
function postToPanel(payload) {
  try {
    window.parent.postMessage({ source: 'paroksh-panel', ...payload }, '*');
  } catch {
    // Not running inside the floating panel (e.g. standalone/dev) — no-op.
  }
}

export function ChatHeader({ theme, onToggleTheme, onNewSession, onClearChat, onExportRedacted, onOpenAudit }) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const settingsRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (e) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target)) {
        setSettingsOpen(false);
      }
    };
    if (settingsOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [settingsOpen]);

  const handleClose = () => postToPanel({ type: 'close' });

  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 flex-shrink-0">
      <div className="flex items-center gap-2 text-sm font-semibold tracking-wide select-none flex-1">
        <Sparkles className="h-3.5 w-3.5 text-blue-400" />
        PAROKSH
      </div>

      <div className="flex items-center gap-0.5">
        <button
          className="h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50"
          title="New session"
          onClick={onNewSession}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        <button
          className="h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50"
          title="Session dashboard"
          onClick={onOpenAudit}
        >
          <BarChart3 className="h-3.5 w-3.5" />
        </button>

        <div className="relative" ref={settingsRef}>
          <button
            className={cn(
              'h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-secondary/50',
              settingsOpen && 'bg-secondary/50 text-foreground'
            )}
            title="Settings"
            onClick={() => setSettingsOpen((v) => !v)}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>

          {settingsOpen && (
            <div className="absolute right-0 top-8 z-50 w-40 rounded-lg border border-border/60 bg-card py-1 shadow-lg">
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary/50 text-left"
                onClick={() => {
                  onToggleTheme();
                  setSettingsOpen(false);
                }}
              >
                {theme === 'dark' ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
                {theme === 'dark' ? 'Dark theme' : 'Light theme'}
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-secondary/50 text-left disabled:opacity-50"
                disabled={isExporting}
                title="Save the sanitized screenshots — exactly what was sent to the model — to your Downloads folder"
                onClick={async () => {
                  setIsExporting(true);
                  await onExportRedacted?.();
                  setIsExporting(false);
                  setSettingsOpen(false);
                }}
              >
                <Download className="h-3 w-3" />
                {isExporting ? 'Saving…' : 'Download redacted images'}
              </button>
              <button
                className="w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-destructive/10 text-destructive text-left"
                onClick={() => {
                  onClearChat();
                  setSettingsOpen(false);
                }}
              >
                <Trash2 className="h-3 w-3" />
                Clear chat
              </button>
            </div>
          )}
        </div>

        <button
          className="h-6 w-6 grid place-items-center rounded text-muted-foreground hover:text-foreground hover:bg-destructive/10 hover:text-destructive"
          title="Close"
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
