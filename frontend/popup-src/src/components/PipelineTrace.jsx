import { Camera, Eye, ShieldCheck, Brain, MousePointerClick, CheckCircle2, XCircle, CircleDot } from 'lucide-react';

// One icon per pipeline stage broadcast by background.js's broadcastStatus().
const STAGE_ICON = {
  start: CircleDot,
  capture: Camera,
  qwen: Eye,
  privacy: ShieldCheck,
  gemma: Brain,
  action: MousePointerClick,
  verify: ShieldCheck,
  done: CheckCircle2,
  error: XCircle,
};

const STAGE_COLOR = {
  done: 'text-emerald-400',
  error: 'text-red-400',
};

export function PipelineTrace({ events }) {
  if (!events || events.length === 0) return null;

  return (
    <div className="mx-3 mb-2 border border-border/60 rounded-lg bg-card/50 overflow-hidden flex-shrink-0 max-h-36 flex flex-col">
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-border/40 flex-shrink-0">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
        <span className="text-xs font-medium">Pipeline</span>
        <span className="text-[11px] text-muted-foreground">— what PAROKSH is doing right now</span>
      </div>
      <div className="px-3 py-2 space-y-1 overflow-y-auto scrollbar-hide">
        {events.map((ev, i) => {
          const Icon = STAGE_ICON[ev.stage] || CircleDot;
          const isLatest = i === events.length - 1;
          const colorClass = STAGE_COLOR[ev.stage] || (isLatest ? 'text-blue-400' : 'text-muted-foreground');
          return (
            <div key={ev.id ?? i} className="flex items-start gap-2 text-[11px] font-mono animate-slide-up">
              <Icon className={`h-3 w-3 mt-0.5 flex-shrink-0 ${colorClass} ${isLatest && ev.stage !== 'done' && ev.stage !== 'error' ? 'animate-pulse' : ''}`} />
              <span className="text-muted-foreground break-words">{ev.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
