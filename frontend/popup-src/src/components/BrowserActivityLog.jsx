import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

export function BrowserActivityLog({ steps }) {
  const [isExpanded, setIsExpanded] = useState(true);

  if (!steps || steps.length === 0) return null;

  return (
    <div className="mx-3 mb-2 border border-border/60 rounded-lg bg-card/50 overflow-hidden flex-shrink-0 max-h-40 flex flex-col">
      <button
        className="w-full px-3 py-2 flex items-center gap-2 hover:bg-secondary/30 transition-colors flex-shrink-0"
        onClick={() => setIsExpanded((v) => !v)}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse-dot" />
        <span className="text-xs font-medium">Browser Activity</span>
        <span className="text-[11px] text-muted-foreground">
          ({steps.length} {steps.length === 1 ? 'action' : 'actions'})
        </span>
        {isExpanded ? (
          <ChevronUp className="h-3.5 w-3.5 text-muted-foreground ml-auto" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground ml-auto" />
        )}
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-1.5 overflow-y-auto scrollbar-hide">
          {steps.map((step, index) => (
            <div key={index} className="flex items-start gap-2 text-[11px] font-mono animate-slide-up">
              <span className="text-blue-300 flex-shrink-0">{index + 1}.</span>
              <span className="text-muted-foreground break-words">{step}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
