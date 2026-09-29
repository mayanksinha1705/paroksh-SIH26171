import { Loader2 } from 'lucide-react';

export function AgentExecutionPanel({ label }) {
  if (!label) return null;

  return (
    <div className="mx-3 mb-2 px-3 py-2 border border-border/60 rounded-lg text-sm flex-shrink-0">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin text-blue-400" />
        <span className="text-xs">{label}</span>
      </div>
    </div>
  );
}
