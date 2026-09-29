import { useState, useEffect, useCallback, useRef } from 'react';
import { ChatHeader } from './components/ChatHeader.jsx';
import { EmptyState } from './components/EmptyState.jsx';
import { ChatInterface } from './components/ChatInterface.jsx';
import { AgentExecutionPanel } from './components/AgentExecutionPanel.jsx';
import { BrowserActivityLog } from './components/BrowserActivityLog.jsx';
import { PipelineTrace } from './components/PipelineTrace.jsx';
import { TaskCompletion } from './components/TaskCompletion.jsx';
import { InputComposer } from './components/InputComposer.jsx';
import { VoiceOrb } from './components/VoiceOrb.jsx';
import {
  executeInstruction,
  stopInstruction,
  parseResultMessage,
  getTheme,
  setTheme as persistTheme,
  loadChatState,
  saveChatState,
  clearChatState,
  exportRedactedImages,
  subscribeToPipelineStatus,
  getTaskStatus,
  subscribeToTaskResult,
  openAuditDashboard,
} from './lib/chromeBridge.js';

export default function App() {
  const [messages, setMessages] = useState([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [execLabel, setExecLabel] = useState(null);
  const [activitySteps, setActivitySteps] = useState(null);
  const [pipelineEvents, setPipelineEvents] = useState([]);
  const [showTaskComplete, setShowTaskComplete] = useState(false);
  const [completionText, setCompletionText] = useState('');
  const [theme, setThemeState] = useState('dark');
  const [orbMode, setOrbMode] = useState(false);
  const hydrated = useRef(false);
  // Mirrors isBusy for code paths (voice interrupt handling) that fire from
  // event callbacks and need the current value without waiting on a re-render.
  const isBusyRef = useRef(false);
  // Holds a voice command that arrived while a task was already running.
  // Picked up automatically the moment the in-flight task finishes.
  const pendingVoiceRef = useRef(null);
  // A finished task's result can arrive via TWO channels: the direct
  // executeInstruction() response (normal case), or the PAROKSH_TASK_RESULT
  // broadcast (needed when a page navigation destroyed the panel that made
  // the original call — see the mount-time resume effect below). When
  // nothing navigated, both fire for the same task; this ref makes sure the
  // reply is only ever applied once.
  const resultHandledRef = useRef(true);

  useEffect(() => {
    getTheme().then((t) => {
      setThemeState(t);
      document.documentElement.classList.toggle('light', t === 'light');
    });
  }, []);

  // Live pipeline status: background.js broadcasts one event per stage of
  // every step (capture → Qwen3.5-0.8B → PrivacyShield → Gemma → action
  // execution). Kept for the whole panel lifetime (not just while isBusy)
  // so a message that arrives right at the tail end of a run isn't missed.
  useEffect(() => {
    const unsubscribe = subscribeToPipelineStatus((ev) => {
      setPipelineEvents((prev) => [...prev.slice(-49), ev]);
      setExecLabel(ev.label);
    });
    return unsubscribe;
  }, []);

  // Restore whatever conversation was persisted for this tab (e.g. right
  // after a page navigation recreated this whole panel from scratch).
  useEffect(() => {
    loadChatState().then((saved) => {
      if (saved) {
        setMessages(saved.messages || []);
        setActivitySteps(saved.activitySteps || null);
        setShowTaskComplete(saved.showTaskComplete || false);
        setCompletionText(saved.completionText || '');
        // The agent navigating the tab tears down and recreates this whole
        // panel (it's an iframe on the page, and navigation is a fresh
        // page load). Without this, voice mode would silently "close"
        // every time the agent opened a link mid-task.
        setOrbMode(saved.orbMode || false);
      }
      hydrated.current = true;
    });
  }, []);

  // Persist on every change, once initial hydration has happened (so we
  // don't immediately overwrite saved state with the empty initial state).
  useEffect(() => {
    if (!hydrated.current) return;
    saveChatState({ messages, activitySteps, showTaskComplete, completionText, orbMode });
  }, [messages, activitySteps, showTaskComplete, completionText, orbMode]);

  const toggleTheme = useCallback(() => {
    setThemeState((prev) => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('light', next === 'light');
      persistTheme(next);
      return next;
    });
  }, []);

  const resetSession = useCallback(() => {
    setMessages([]);
    setActivitySteps(null);
    setPipelineEvents([]);
    setShowTaskComplete(false);
    setCompletionText('');
    setOrbMode(false);
    clearChatState();
  }, []);

  // Applies a finished task's result to the UI — used by both the direct
  // executeInstruction() response and the PAROKSH_TASK_RESULT broadcast (see
  // resultHandledRef's comment above for why both exist). Whichever of the
  // two arrives first wins; the other is a no-op.
  const applyTaskResult = useCallback((response) => {
    if (resultHandledRef.current) return;
    resultHandledRef.current = true;

    setIsBusy(false);
    isBusyRef.current = false;
    setIsStopping(false);
    setExecLabel(null);

    // response.message is the raw, mechanical step log — still used to
    // populate the activity log. response.reply is the separate,
    // human-sounding chat message from ollama2.js; that's what goes in the
    // chat bubble. Falling back to the old raw summary only if, for some
    // reason, no reply came back at all.
    const { steps, summary } = parseResultMessage(response.message);
    setActivitySteps(steps.length > 0 ? steps : null);
    const chatText = response.reply || (response.success ? summary : response.message);
    setMessages((prev) => [
      ...prev,
      // A user-requested stop isn't an error, so don't paint it red.
      { role: 'assistant', text: chatText, isError: !response.success && !response.stopped },
    ]);
    if (response.success) {
      setCompletionText(chatText);
      setShowTaskComplete(true);
    }

    // A voice command that arrived while this one was running (or being
    // stopped to make room for it) waits here — now that we're free, run
    // it immediately, no extra confirmation needed.
    if (pendingVoiceRef.current) {
      const next = pendingVoiceRef.current;
      pendingVoiceRef.current = null;
      runInstruction(next);
    }
    // runInstruction is defined below and referenced here only inside this
    // callback's body (never at render time), so the forward reference is
    // safe — see the comment on the mount-time resume effect for the same
    // pattern applied to getTaskStatus().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Recovers from a mid-task page navigation: the panel this task started
  // in may have been destroyed and recreated (fresh React state, isBusy
  // defaults back to false) while the agent loop kept running in
  // background.js, which never navigates. On every mount, ask whether a
  // task is still in flight for this tab and, if so, resume watching it —
  // including replaying its pipeline trace so far instead of showing a
  // blank one. If it already finished in the gap, apply that instead.
  useEffect(() => {
    getTaskStatus().then((status) => {
      if (status?.busy) {
        resultHandledRef.current = false;
        setIsBusy(true);
        isBusyRef.current = true;
        setIsStopping(false);
        const events = status.events || [];
        setPipelineEvents(events.slice(-50));
        if (events.length) setExecLabel(events[events.length - 1].label);
        else setExecLabel('Resuming task…');
      } else if (status?.finishedResult) {
        resultHandledRef.current = false;
        applyTaskResult(status.finishedResult);
      }
    });
  }, [applyTaskResult]);

  // The other half of resuming after navigation: once we know (above) that
  // a task is still running, this is what actually delivers its outcome —
  // the original executeInstruction() call that started it belonged to the
  // now-destroyed panel and can never resolve here.
  useEffect(() => {
    const unsubscribe = subscribeToTaskResult(applyTaskResult);
    return unsubscribe;
  }, [applyTaskResult]);

  const runInstruction = useCallback(async (instruction) => {
    setShowTaskComplete(false);
    setMessages((prev) => [...prev, { role: 'user', text: instruction }]);
    setIsBusy(true);
    isBusyRef.current = true;
    setExecLabel('Capturing screenshot and asking the model…');
    setActivitySteps(null);
    setPipelineEvents([]);
    resultHandledRef.current = false;

    // The ONLY call out of the UI layer — same contract the original popup
    // used against the untouched background.js. Its response is one of the
    // two channels applyTaskResult can receive from (see above); if this
    // exact panel gets destroyed by a navigation before this resolves, the
    // PAROKSH_TASK_RESULT broadcast (delivered to whatever panel exists by
    // then) is what actually applies the result instead.
    const response = await executeInstruction(instruction);
    applyTaskResult(response);
  }, [applyTaskResult]);

  // Typed / single-shot voice-dictated sends: normal path, input is already
  // disabled while busy so this only ever fires when idle.
  const handleSend = useCallback((instruction) => {
    runInstruction(instruction);
  }, [runInstruction]);

  // Cancels whatever agent run is currently in flight. The background
  // worker aborts its in-progress LLM call and stops before the next step,
  // and the still-pending executeInstruction() promise above resolves
  // normally with a { stopped: true } response — no separate code path
  // needed here.
  const handleStop = useCallback(() => {
    setIsStopping(true);
    setExecLabel('Stopping…');
    stopInstruction();
  }, []);

  // Called by orb mode for every command it hears. If the agent is idle,
  // run it right away. If a task is already in progress, this new command
  // wins immediately: stop the current task and queue this one to fire the
  // instant the stop resolves — no waiting for the user to confirm.
  const handleVoiceCommand = useCallback((instruction) => {
    if (!instruction) return;
    if (isBusyRef.current) {
      pendingVoiceRef.current = instruction;
      setIsStopping(true);
      setExecLabel('Stopping…');
      stopInstruction();
    } else {
      runInstruction(instruction);
    }
  }, [runInstruction]);

  // Exports every sanitized screenshot from the local privacy vault —
  // exactly what was sent to the LLM — as files in Downloads/paroksh_redacted.
  const handleExportRedacted = useCallback(async () => {
    const res = await exportRedactedImages();
    setMessages((prev) => [
      ...prev,
      { role: 'assistant', text: res.message, isError: !res.success },
    ]);
  }, []);

  const hasMessages = messages.length > 0;

  return (
    <div className="relative flex flex-col h-full w-full">
      <ChatHeader
        theme={theme}
        onToggleTheme={toggleTheme}
        onNewSession={resetSession}
        onClearChat={resetSession}
        onExportRedacted={handleExportRedacted}
        onOpenAudit={openAuditDashboard}
      />

      {!hasMessages ? (
        <EmptyState />
      ) : (
        <ChatInterface messages={messages} isTyping={isBusy} />
      )}

      <AgentExecutionPanel label={execLabel} />
      <PipelineTrace events={isBusy ? pipelineEvents : []} />
      <BrowserActivityLog steps={activitySteps} />
      {showTaskComplete && !isBusy && (
        <TaskCompletion onNewTask={resetSession} message={completionText} />
      )}

      <InputComposer
        onSend={handleSend}
        onStop={handleStop}
        disabled={isBusy}
        isStopping={isStopping}
        onOpenOrb={() => setOrbMode(true)}
      />

      {orbMode && (
        <VoiceOrb
          onClose={() => setOrbMode(false)}
          onCommand={handleVoiceCommand}
          isBusy={isBusy}
          statusLabel={execLabel}
        />
      )}
    </div>
  );
}
