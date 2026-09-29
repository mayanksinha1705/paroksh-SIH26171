import { CheckCircle2, Sparkles } from 'lucide-react';

export function TaskCompletion({ onNewTask, message }) {
  return (
    <div className="mx-3 mb-2 p-4 rounded-lg border border-emerald-500/40 bg-emerald-500/5 text-center animate-slide-up flex-shrink-0">
      <div className="h-11 w-11 rounded-full bg-emerald-500/15 grid place-items-center mx-auto mb-2.5">
        <CheckCircle2 className="h-5.5 w-5.5 text-emerald-400" />
      </div>
      <h3 className="text-sm font-semibold mb-1">Task completed</h3>
      <p className="text-xs text-muted-foreground mb-3">
        {message || 'Your request has been processed successfully.'}
      </p>
      <button
        onClick={onNewTask}
        className="w-full flex items-center justify-center gap-1.5 bg-primary text-primary-foreground text-xs font-medium py-1.5 rounded-lg hover:opacity-90"
      >
        <Sparkles className="h-3.5 w-3.5" />
        Start another task
      </button>
    </div>
  );
}
