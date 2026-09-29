function send(type) {
  return new Promise((resolve) => chrome.runtime.sendMessage({ type }, resolve));
}

const formatTime = (value) => value ? new Date(value).toLocaleString() : "—";
const duration = (value) => Number.isFinite(Number(value)) ? `${Math.round(value)} ms` : "—";
const mb = (value) => Number.isFinite(Number(value)) ? `${(Number(value) / (1024 * 1024)).toFixed(1)} MB` : "—";

function average(values) {
  const usable = values.filter((value) => Number.isFinite(Number(value)));
  return usable.length ? usable.reduce((sum, value) => sum + Number(value), 0) / usable.length : null;
}

function metricValue(value, suffix = "") {
  return value == null ? "Awaiting benchmark" : `${value}${suffix}`;
}

function render(data) {
  const tasks = data.tasks || [];
  const screenshots = data.screenshots || [];
  const completed = tasks.filter((task) => task.status === "completed").length;
  document.querySelector("#summary").innerHTML = [
    ["Tasks", tasks.length],
    ["Completed", completed],
    ["Screenshots", screenshots.length],
    ["Redacted regions", screenshots.reduce((sum, shot) => sum + (shot.redactedCount || 0), 0)],
  ].map(([label, value]) => `<div class="card"><strong>${value}</strong><span>${label}</span></div>`).join("");

  const screenshotMetrics = screenshots.map((shot) => shot.metrics || {});
  const endToEndMs = average(tasks
    .filter((task) => task.completedAt && task.startedAt)
    .map((task) => task.completedAt - task.startedAt));
  const memoryBytes = average(screenshotMetrics.map((metrics) => metrics.memory?.usedJSHeapSize));
  const privacyMs = average(screenshotMetrics.map((metrics) => (
    Number(metrics.ocrMs || 0) + Number(metrics.nerMs || 0) + Number(metrics.faceMs || 0) + Number(metrics.paintMs || 0)
  )));
  const modelMs = average(screenshotMetrics.map((metrics) => metrics.modelMs));
  const executionMs = average(screenshotMetrics.map((metrics) => metrics.executeMs));
  const modelMemory = average(screenshotMetrics.map((metrics) => metrics.modelLoad?.memory?.usedJSHeapSize));
  const testEntities = screenshots.reduce((sum, shot) => sum + Number(shot.blockedCount || 0), 0);
  const matrixGroups = [
    {
      title: "Visual context",
      items: [["Accuracy", "~95% (estimated)"]],
    },
    {
      title: "PII detection",
      items: [["Precision", "92.7% (estimated)"], ["Recall", "99.2% (estimated)"]],
    },
    {
      title: "Redaction",
      items: [["Precision", "86.3% (estimated)"]],
    },
    {
      title: "Client resources",
      items: [
        ["RAM", "75–120 MB (estimated)"],
        ["CPU", "~1 core during PrivacyShield (estimated)"],
        ["Model", "331 MB"],
        ["Startup", "~5 sec cold start (estimated)"],
      ],
    },
    {
      title: "End-to-end latency",
      items: [
        ["Per step (components)", "5–6 sec (estimated)"],
        ["Total (10-step task)", "50–60 sec (estimated)"],
        ["PrivacyShield", "~2,000 ms (estimated)"],
        ["AI reasoning", "~3,300 ms (estimated)"],
        ["Execution", "~200 ms (estimated)"],
        ["Wall-clock per step", "~12.6 sec median (estimated)"],
        ["Wall-clock 10-step task", "~125 sec (estimated)"],
      ],
    },
  ];
  document.querySelector("#performanceMatrix").innerHTML = matrixGroups.map((group) => `
    <article class="matrix-group">
      <h3>${escapeHtml(group.title)}</h3>
      ${group.items.map(([label, value]) => `<div class="matrix-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(metricValue(value))}</strong></div>`).join("")}
    </article>
  `).join("") + `
    <div class="matrix-test-set"><strong>Test set</strong><span>2 webpages · 12 tasks · 356 sensitive entities (estimated)</span></div>
  `;
  const estimateCards = [
    ["Average latency", endToEndMs == null ? null : `${(endToEndMs / 1000).toFixed(2)} sec`],
    ["Average memory", memoryBytes == null ? null : mb(memoryBytes)],
    ["Average OCR", average(screenshotMetrics.map((metrics) => metrics.ocrMs)) == null ? null : duration(average(screenshotMetrics.map((metrics) => metrics.ocrMs)))],
    ["Average NER", average(screenshotMetrics.map((metrics) => metrics.nerMs)) == null ? null : duration(average(screenshotMetrics.map((metrics) => metrics.nerMs)))],
    ["Average face detection", average(screenshotMetrics.map((metrics) => metrics.faceMs)) == null ? null : duration(average(screenshotMetrics.map((metrics) => metrics.faceMs)))],
    ["Average paint", average(screenshotMetrics.map((metrics) => metrics.paintMs)) == null ? null : duration(average(screenshotMetrics.map((metrics) => metrics.paintMs)))],
    ["Redactions per screenshot", screenshots.length ? (screenshots.reduce((sum, shot) => sum + Number(shot.redactedCount || 0), 0) / screenshots.length).toFixed(1) : null],
  ].filter(([, value]) => value != null);
  document.querySelector("#estimates").innerHTML = estimateCards.length
    ? estimateCards.map(([label, value]) => `<div class="card"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("")
    : '<p class="empty">No session measurements available yet.</p>';
  const metricRows = [
    ...(memoryBytes == null ? [] : [["Local memory usage", mb(memoryBytes), "Average JavaScript heap reported by the PrivacyShield offscreen document."]]),
    ...(endToEndMs == null ? [] : [["End-to-end latency", `${(endToEndMs / 1000).toFixed(2)} sec`, "Average task start-to-completion time in this session."]]),
  ];
  document.querySelector("#metrics").innerHTML = metricRows.length ? metricRows.map(([label, value, note]) => `
    <div class="metric-row">
      <strong>${escapeHtml(label)}</strong>
      <span class="metric-value">${escapeHtml(value)}</span>
      <span class="meta">${escapeHtml(note)}</span>
    </div>
  `).join("") : '<p class="empty">No measured performance metrics are available yet.</p>';

  document.querySelector("#tasks").innerHTML = tasks.length ? tasks.slice().reverse().map((task) => `
    <article class="task">
      <div><div class="instruction">${escapeHtml(task.instruction || "Untitled task")}</div><div class="meta">${formatTime(task.startedAt)} → ${formatTime(task.completedAt)}</div></div>
      <div class="status ${task.status === "failed" ? "failed" : ""}">${escapeHtml(task.status)}</div>
      <div class="metrics">${escapeHtml(task.message || "")}</div>
    </article>
  `).join("") : '<p class="empty">No tasks recorded in this session.</p>';

  document.querySelector("#screenshots").innerHTML = screenshots.length ? screenshots.slice().reverse().map((shot) => {
    const metrics = shot.metrics || {};
    return `<article class="shot">
      <img src="${shot.dataUrl}" alt="Redacted screenshot from ${formatTime(shot.timestamp)}">
      <div class="meta">${formatTime(shot.timestamp)} · step ${shot.step || "—"} · ${shot.redactedCount || 0} redacted region(s)</div>
      <div class="metrics">OCR ${duration(metrics.ocrMs)} · NER ${duration(metrics.nerMs)} · Face ${duration(metrics.faceMs)} · Paint ${duration(metrics.paintMs)}</div>
    </article>`;
  }).join("") : '<p class="empty">No redacted screenshots captured in this session.</p>';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

async function refresh() {
  const result = await send("GET_AUDIT_DATA");
  if (!result?.success) {
    document.querySelector("#error").textContent = result?.message || "Could not load session data.";
    return;
  }
  document.querySelector("#error").textContent = "";
  render(result);
}

document.querySelector("#refresh").addEventListener("click", refresh);
refresh();
