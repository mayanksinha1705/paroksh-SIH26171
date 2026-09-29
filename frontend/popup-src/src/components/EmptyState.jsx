export function EmptyState() {
  return (
    <div className="flex-1 flex flex-col items-center justify-center text-center gap-3 px-5 overflow-y-auto scrollbar-hide">
      <h1 className="text-2xl font-semibold text-foreground">
        Hello, <span className="text-blue-400">there</span>
      </h1>
      <p className="text-xs text-muted-foreground max-w-[260px]">
        Tell me what to do in this tab — I&apos;ll drive the browser for you.
      </p>
      <section className="w-full max-w-[300px] rounded-xl border border-border bg-card/70 p-3 text-left">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">
            Estimated performance
          </h2>
          <span className="text-[9px] text-muted-foreground">Provisional</span>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Metric label="Visual accuracy" value="~95%" />
          <Metric label="PII precision" value="92.7%" />
          <Metric label="PII recall" value="99.2%" />
          <Metric label="Redaction precision" value="86.3%" />
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }) {
  return (
    <div className="rounded-lg bg-secondary/70 px-2.5 py-2">
      <div className="text-sm font-semibold text-blue-400">{value}</div>
      <div className="mt-0.5 text-[10px] leading-tight text-muted-foreground">{label}</div>
    </div>
  );
}
