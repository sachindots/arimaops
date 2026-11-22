import { useEffect, useRef, useState } from "react";
import type {
  AgentInstruction,
  MeetingMinutes,
  MeetingSession,
  MeetingTurn,
  ProposedDecision,
  ProposedTask,
  VoiceProvider,
} from "../../data/generated";
import { BRAND } from "../../data/brand";
import { HUMAN_ID } from "../../data/types";
import { isViewer, officeActions, useOffice } from "../../store/office";
import { Icon } from "../deck/Icon";
import { SafeMarkdown, VisualDecisionCard } from "../decisions/VisualDecisionCard";
import { ago, Portrait, useNow } from "../kit";
import { Select } from "../primitives/Select";

const VOICE_OPTIONS: { value: VoiceProvider; label: string }[] = [
  { value: "browser-web-speech", label: "Browser Web Speech (Free)" },
  { value: "open-ai", label: "OpenAI Voice (Vault)" },
  { value: "gemini", label: "Gemini Voice (Vault)" },
  { value: "off", label: "Off" },
];

interface VoiceStatusPayload {
  providers: {
    browserWebSpeech: boolean;
    openai: boolean;
    gemini: boolean;
  };
  activeProvider?: string;
}

function voiceAuthHeaders(): Record<string, string> {
  try {
    const tok = sessionStorage.getItem("hq-token") ?? "";
    return tok ? { Authorization: `Bearer ${tok}` } : {};
  } catch {
    return {};
  }
}

interface SpeechRecognitionInstance {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
}

function getSpeechRecognition(): (new () => SpeechRecognitionInstance) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionInstance;
    webkitSpeechRecognition?: new () => SpeechRecognitionInstance;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function MeetingRoom({
  meeting,
  turns,
  onBack,
}: {
  meeting: MeetingSession;
  turns: MeetingTurn[];
  onBack?: () => void;
}) {
  const snap = useOffice((s) => s.snap);
  const live = useOffice((s) => s.live);
  const now = useNow(10_000);
  const [draft, setDraft] = useState("");
  const [voiceProvider, setVoiceProvider] = useState<VoiceProvider>(meeting.voiceProvider ?? "browser-web-speech");
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatusPayload | null>(null);
  const [voiceActive, setVoiceActive] = useState(meeting.voiceEnabled && meeting.voiceProvider !== "off");
  const [listening, setListening] = useState(false);
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [minutesModalOpen, setMinutesModalOpen] = useState(false);
  const lastSpokenTurnId = useRef<string | null>(turns[turns.length - 1]?.id ?? null);
  const recRef = useRef<SpeechRecognitionInstance | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!live) return;
    let stop = false;
    fetch("/api/voice/status", { credentials: "same-origin", headers: voiceAuthHeaders() })
      .then((r) => (r.ok ? (r.json() as Promise<VoiceStatusPayload>) : null))
      .then((data) => {
        if (!stop && data?.providers) setVoiceStatus(data);
      })
      .catch(() => {
        /* ignore offline voice status */
      });
    return () => {
      stop = true;
    };
  }, [live]);

  const team = snap?.config.team ?? [];
  const decisions = snap?.visualDecisions ?? [];
  const who = (id: string) => {
    if (id === HUMAN_ID || id === "you") {
      return { id: HUMAN_ID, name: "You", role: "Owner", color: "#10b981", isLead: false };
    }
    const a = team.find((x) => x.id === id);
    if (a) return a;
    return { id, name: id === "hq" ? BRAND.name : id, role: "HQ", color: "#0891b2", isLead: false };
  };

  const stopAudioPlayback = () => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* ignore */
      }
    }
  };

  const speakBrowserWebSpeech = (text: string, speakerId: string) => {
    if (typeof window === "undefined" || !("speechSynthesis" in window)) {
      setVoiceNotice("Browser speech synthesis is unavailable in this environment; showing visual transcript.");
      return;
    }
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const idx = Math.max(
        0,
        team.findIndex((a) => a.id === speakerId),
      );
      if (voices.length > 0) {
        u.voice = voices[idx % voices.length];
      }
      u.pitch = 0.92 + (idx % 4) * 0.08;
      u.rate = 1.02;
      window.speechSynthesis.speak(u);
    } catch {
      /* ignore speechSynthesis restrictions in headless browsers */
    }
  };

  const speakText = (text: string, speakerId: string, providerOverride?: VoiceProvider) => {
    const activeProv = providerOverride ?? voiceProvider;
    if (activeProv === "off") return;

    if (live && (activeProv === "open-ai" || activeProv === "gemini")) {
      const apiProvider = activeProv === "open-ai" ? "openai" : "gemini";
      const label = activeProv === "open-ai" ? "OpenAI Voice (Vault)" : "Gemini Voice (Vault)";
      void fetch("/api/voice/tts", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", ...voiceAuthHeaders() },
        body: JSON.stringify({ text, voice: speakerId, provider: apiProvider }),
      })
        .then(async (res) => {
          if (!res.ok) {
            const errBody = (await res.json().catch(() => ({}))) as { error?: string };
            setVoiceNotice(
              `${errBody.error ?? `${label} is not configured in Vault.`} Falling back to Browser Web Speech.`,
            );
            speakBrowserWebSpeech(text, speakerId);
            return;
          }
          const ct = res.headers.get("content-type") ?? "";
          let audioUrl = "";
          if (ct.includes("application/json")) {
            const payload = (await res.json()) as { audioBase64?: string; mimeType?: string };
            if (payload.audioBase64) {
              audioUrl = `data:${payload.mimeType ?? "audio/mpeg"};base64,${payload.audioBase64}`;
            }
          } else {
            audioUrl = URL.createObjectURL(await res.blob());
          }
          if (!audioUrl) {
            speakBrowserWebSpeech(text, speakerId);
            return;
          }
          stopAudioPlayback();
          const audio = new Audio(audioUrl);
          audioRef.current = audio;
          audio.onended = () => {
            if (audioUrl.startsWith("blob:")) URL.revokeObjectURL(audioUrl);
          };
          await audio.play().catch(() => speakBrowserWebSpeech(text, speakerId));
        })
        .catch(() => {
          setVoiceNotice(`${label} unavailable — falling back to Browser Web Speech.`);
          speakBrowserWebSpeech(text, speakerId);
        });
      return;
    }

    speakBrowserWebSpeech(text, speakerId);
  };

  const handleVoiceProviderChange = (next: VoiceProvider) => {
    setVoiceProvider(next);
    if (next === "off") {
      setVoiceActive(false);
      stopAudioPlayback();
      setVoiceNotice(null);
      officeActions.joinMeeting(meeting.id, "join", false);
      return;
    }
    if (next === "open-ai" || next === "gemini") {
      const label = next === "open-ai" ? "OpenAI Voice (Vault)" : "Gemini Voice (Vault)";
      const configured =
        next === "open-ai" ? Boolean(voiceStatus?.providers.openai) : Boolean(voiceStatus?.providers.gemini);
      if (!live) {
        setVoiceNotice(
          `${label} selected — configure an API key in Settings → API accounts on live HQ; using Browser Web Speech fallback in Demo mode.`,
        );
      } else if (!configured) {
        setVoiceNotice(
          `${label} has no vaulted key configured yet — add an account in Settings → API accounts. Falling back to Browser Web Speech.`,
        );
      } else {
        setVoiceNotice(`${label} active via vaulted API credentials.`);
      }
      return;
    }
    setVoiceNotice(null);
  };

  useEffect(() => {
    const latest = turns[turns.length - 1];
    if (!latest || latest.id === lastSpokenTurnId.current) return;
    lastSpokenTurnId.current = latest.id;
    if (voiceActive && latest.speakerId !== "you" && latest.speakerId !== HUMAN_ID) {
      speakText(latest.spokenText || latest.bodyMarkdown, latest.speakerId);
    }
  }, [turns, voiceActive]);

  useEffect(() => {
    return () => {
      stopAudioPlayback();
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
    };
  }, []);

  const toggleCall = () => {
    const next = !voiceActive;
    const effectiveProvider: VoiceProvider = next && voiceProvider === "off" ? "browser-web-speech" : voiceProvider;
    if (next && voiceProvider === "off") setVoiceProvider("browser-web-speech");
    setVoiceActive(next);
    officeActions.joinMeeting(meeting.id, "join", next);
    if (next) {
      const latestAgentTurn = [...turns].reverse().find((t) => t.speakerId !== "you");
      if (latestAgentTurn) {
        speakText(latestAgentTurn.spokenText || latestAgentTurn.bodyMarkdown, latestAgentTurn.speakerId, effectiveProvider);
      }
    } else {
      stopAudioPlayback();
    }
  };

  const toggleMic = () => {
    if (listening) {
      try {
        recRef.current?.stop();
      } catch {
        /* ignore */
      }
      setListening(false);
      return;
    }
    const Ctor = getSpeechRecognition();
    if (!Ctor) {
      setVoiceNotice("Speech recognition is not supported by this browser. Type below to speak to the room.");
      return;
    }
    try {
      const rec = new Ctor();
      rec.lang = "en-US";
      rec.interimResults = false;
      rec.continuous = false;
      rec.onresult = (e) => {
        const transcript = e.results?.[0]?.[0]?.transcript;
        if (transcript) {
          setDraft((d) => (d ? `${d} ${transcript}` : transcript));
        }
      };
      rec.onerror = () => {
        setListening(false);
        setVoiceNotice("Microphone capture unavailable; type your turn in the composer below.");
      };
      rec.onend = () => setListening(false);
      recRef.current = rec;
      setListening(true);
      setVoiceNotice(null);
      rec.start();
    } catch {
      setListening(false);
      setVoiceNotice("Microphone access unavailable; use the text input below.");
    }
  };

  const sendTurn = () => {
    const text = draft.trim();
    if (!text || isViewer) return;
    officeActions.addMeetingTurn(meeting.id, text, "you", null);
    setDraft("");
  };

  const committed = Boolean(meeting.minutes?.committedAt);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Room Header */}
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-cream-2/40 px-5 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {onBack && (
            <button type="button" className="btn px-2.5 text-[13px] md:hidden" onClick={onBack} aria-label="Back to meetings">
              ‹
            </button>
          )}
          <span
            className="chip text-[12px] capitalize"
            style={{
              ["--c" as string]:
                meeting.status === "live"
                  ? "var(--color-green)"
                  : meeting.status === "closed"
                    ? "var(--color-muted)"
                    : "var(--color-amber)",
            }}
          >
            <span className={`h-2 w-2 rounded-full ${meeting.status === "live" ? "bg-green animate-pulse" : "bg-amber"}`} />
            {meeting.status} · {meeting.kind}
          </span>
          <h2 className="m-0 truncate text-[15px] font-semibold text-ink">{meeting.title}</h2>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            className="w-auto min-w-[185px]"
            value={voiceProvider}
            aria-label="Voice adapter"
            options={VOICE_OPTIONS}
            onChange={(v) => handleVoiceProviderChange(v as VoiceProvider)}
          />

          <button
            type="button"
            aria-pressed={voiceActive}
            onClick={toggleCall}
            className={`btn flex items-center gap-1.5 text-[13px] ${
              voiceActive ? "border-[var(--color-green)] bg-green/10 text-green" : ""
            }`}
          >
            <Icon name={voiceActive ? "spatial_audio_off" : "record_voice_over"} size={16} />
            {voiceActive
              ? `In Voice Call (${
                  voiceProvider === "open-ai"
                    ? "OpenAI"
                    : voiceProvider === "gemini"
                      ? "Gemini"
                      : "Web Speech"
                })`
              : "Join Call"}
          </button>

          {voiceActive && !isViewer && (
            <button
              type="button"
              aria-pressed={listening}
              onClick={toggleMic}
              className={`btn flex items-center gap-1.5 text-[13px] ${
                listening ? "border-red bg-red/10 text-red" : ""
              }`}
              title="Push-to-talk speech recognition"
            >
              <Icon name={listening ? "mic" : "mic_none"} size={16} />
              {listening ? "Listening…" : "Push to Talk"}
            </button>
          )}

          {!isViewer && meeting.minutes && (
            <button
              type="button"
              onClick={() => setMinutesModalOpen(true)}
              className={`btn flex items-center gap-1.5 text-[13px] ${committed ? "" : "btn-primary"}`}
            >
              <Icon name={committed ? "task_alt" : "fact_check"} size={16} />
              {committed ? "Minutes Committed" : "Commit Minutes"}
            </button>
          )}
        </div>
      </header>

      {voiceNotice && (
        <div className="flex items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-amber/10 px-5 py-1.5 text-[12px] text-ink">
          <span>{voiceNotice}</span>
          <button type="button" className="text-[12px] underline" onClick={() => setVoiceNotice(null)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Main Split: Transcript + Agenda Sidebar */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Turn-by-turn Moderated Transcript */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-5" aria-label="Meeting transcript">
            {turns.length === 0 && (
              <p className="m-0 text-[13px] text-muted">No turns recorded yet. Start the discussion below.</p>
            )}
            {turns.map((turn) => {
              const speaker = who(turn.speakerId);
              const linkedDecision = turn.decisionId ? decisions.find((d) => d.id === turn.decisionId) : undefined;
              return (
                <article
                  key={turn.id}
                  className="flex gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] p-4 shadow-[var(--card-shadow)]"
                >
                  <div className="shrink-0">
                    <Portrait name={speaker.name} color={speaker.color} lead={speaker.isLead} size={36} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[13px] font-semibold text-ink">{speaker.name}</span>
                      <span className="text-[12px] text-muted">{turn.speakerRole}</span>
                      {turn.kind.startsWith("moderator") && (
                        <span className="chip text-[12px]" style={{ ["--c" as string]: "var(--accent)" }}>
                          Moderator
                        </span>
                      )}
                      <span className="ml-auto text-[12px] text-muted">{ago(turn.createdAt, now)}</span>
                      <button
                        type="button"
                        onClick={() => speakText(turn.spokenText || turn.bodyMarkdown, turn.speakerId)}
                        className="rounded p-1 text-muted hover:bg-cream-2 hover:text-ink"
                        title="Read turn aloud"
                        aria-label={`Read ${speaker.name}'s turn aloud`}
                      >
                        <Icon name="volume_up" size={16} />
                      </button>
                    </div>
                    <div className="mt-1.5">
                      <SafeMarkdown markdown={turn.bodyMarkdown} />
                    </div>
                    {linkedDecision && (
                      <div className="mt-3">
                        <VisualDecisionCard decision={linkedDecision} compact />
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>

          {/* Turn Composer */}
          {!isViewer && meeting.status !== "closed" && (
            <form
              className="flex items-center gap-2 border-t border-[var(--border-hairline)] bg-[var(--surface-card)] px-5 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                sendTurn();
              }}
            >
              <input
                className="field flex-1 text-[13px]"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Speak to the room or give a direction to the moderator…"
                aria-label="Add turn to meeting"
              />
              <button type="submit" className="btn btn-primary text-[13px]" disabled={!draft.trim()}>
                <Icon name="send" size={16} /> Send turn
              </button>
            </form>
          )}
        </div>

        {/* Agenda & Participants Sidebar */}
        <aside className="scroll-thin flex w-full shrink-0 flex-col gap-4 overflow-y-auto border-t border-[var(--border-hairline)] bg-cream-2/30 p-4 lg:w-[320px] lg:border-t-0 lg:border-l">
          <div>
            <h3 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
              Participants · {meeting.participantIds.length}
            </h3>
            <div className="flex flex-wrap gap-1.5">
              {meeting.participantIds.map((pid) => {
                const p = who(pid);
                const isMod = pid === meeting.moderatorId;
                return (
                  <span
                    key={pid}
                    className="flex items-center gap-1.5 rounded-full border border-[var(--border-hairline)] bg-[var(--surface-card)] py-0.5 pr-2.5 pl-1 text-[12px]"
                  >
                    <Portrait name={p.name} color={p.color} lead={p.isLead} size={20} />
                    <span className="font-medium text-ink">{p.name}</span>
                    {isMod && <span className="text-[12px] text-accent">(Lead)</span>}
                  </span>
                );
              })}
            </div>
          </div>

          <div>
            <h3 className="m-0 mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">
              Agenda · {meeting.agenda.length}
            </h3>
            <ol className="m-0 flex list-none flex-col gap-2 p-0">
              {meeting.agenda.map((item, i) => {
                const owner = item.ownerId ? who(item.ownerId) : null;
                return (
                  <li
                    key={item.id}
                    className="flex flex-col gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-2.5 text-[13px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-ink">
                        {i + 1}. {item.title}
                      </span>
                      <span
                        className="chip text-[12px] capitalize"
                        style={{
                          ["--c" as string]:
                            item.status === "done"
                              ? "var(--color-green)"
                              : item.status === "active"
                                ? "var(--accent)"
                                : "var(--color-muted)",
                        }}
                      >
                        {item.status}
                      </span>
                    </div>
                    {owner && <span className="text-[12px] text-muted">Owner: {owner.name}</span>}
                  </li>
                );
              })}
            </ol>
          </div>

          {meeting.minutes && (
            <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[13px] font-semibold text-ink">Draft Minutes</span>
                <span className="text-[12px] text-muted">
                  {meeting.minutes.decisions.length} decisions · {meeting.minutes.proposedTasks.length} tasks
                </span>
              </div>
              <SafeMarkdown markdown={meeting.minutes.summaryMarkdown} />
              {!isViewer && (
                <button
                  type="button"
                  onClick={() => setMinutesModalOpen(true)}
                  className="btn btn-primary mt-3 flex w-full items-center justify-center gap-1.5 text-[13px]"
                >
                  <Icon name="fact_check" size={16} />
                  {committed ? "View Committed Minutes" : "1-Click Commit Minutes"}
                </button>
              )}
            </div>
          )}
        </aside>
      </div>

      {minutesModalOpen && meeting.minutes && (
        <CommitMinutesModal
          meeting={meeting}
          initialMinutes={meeting.minutes}
          onClose={() => setMinutesModalOpen(false)}
        />
      )}
    </div>
  );
}

function CommitMinutesModal({
  meeting,
  initialMinutes,
  onClose,
}: {
  meeting: MeetingSession;
  initialMinutes: MeetingMinutes;
  onClose: () => void;
}) {
  const snap = useOffice((s) => s.snap);
  const [decisions, setDecisions] = useState<ProposedDecision[]>(() => structuredClone(initialMinutes.decisions));
  const [tasks, setTasks] = useState<ProposedTask[]>(() => structuredClone(initialMinutes.proposedTasks));
  const [instructions, setInstructions] = useState<AgentInstruction[]>(() =>
    structuredClone(initialMinutes.agentInstructions),
  );
  const committed = Boolean(initialMinutes.committedAt);
  const who = (id: string | null) => snap?.config.team.find((a) => a.id === id)?.name ?? id ?? "Unassigned";

  const commit = () => {
    officeActions.commitMeetingMinutes(meeting.id, {
      ...initialMinutes,
      decisions,
      proposedTasks: tasks,
      agentInstructions: instructions,
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label="Commit Meeting Minutes"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="hud-drawer flex max-h-[90dvh] w-full max-w-[680px] flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)]">
        <header className="flex items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
          <div>
            <h2 className="m-0 text-[20px] font-semibold text-ink">1-Click Meeting Minutes Commit</h2>
            <p className="m-0 text-[12px] text-muted">
              Approve decisions to save into certified Team Memory, tasks to add to the Board, and instructions to send to agents.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-8 w-8 cursor-pointer place-items-center rounded-md text-muted hover:bg-cream-2 hover:text-ink"
            aria-label="Close modal"
          >
            <Icon name="close" size={18} />
          </button>
        </header>

        <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
          <div className="rounded-lg border border-[var(--border-hairline)] bg-cream-2/40 p-3">
            <SafeMarkdown markdown={initialMinutes.summaryMarkdown} />
          </div>

          {/* Proposed Decisions -> Certified Team Memory */}
          <div>
            <h3 className="m-0 mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Icon name="neurology" size={18} className="text-accent" />
              Decisions → Certified Team Memory ({decisions.filter((d) => d.saveToMemory).length}/{decisions.length})
            </h3>
            <div className="flex flex-col gap-2">
              {decisions.map((d, idx) => (
                <label
                  key={d.id}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3"
                >
                  <input
                    type="checkbox"
                    checked={d.saveToMemory}
                    disabled={committed}
                    onChange={(e) =>
                      setDecisions((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, saveToMemory: e.target.checked } : item)),
                      )
                    }
                    className="mt-1"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink">{d.title}</span>
                    <span className="block text-[12px] text-muted">{d.rationale}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>

          {/* Proposed Tasks -> Board */}
          <div>
            <h3 className="m-0 mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Icon name="view_kanban" size={18} className="text-accent" />
              Proposed Tasks → Board ({tasks.filter((t) => t.approved).length}/{tasks.length})
            </h3>
            {tasks.length === 0 ? (
              <p className="m-0 text-[12px] text-muted">No new tasks proposed in this session.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {tasks.map((t, idx) => (
                  <label
                    key={t.id}
                    className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3"
                  >
                    <input
                      type="checkbox"
                      checked={t.approved}
                      disabled={committed}
                      onChange={(e) =>
                        setTasks((prev) =>
                          prev.map((item, i) => (i === idx ? { ...item, approved: e.target.checked } : item)),
                        )
                      }
                      className="mt-1"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-semibold text-ink">{t.title}</span>
                        <span className="rounded bg-cream-2 px-1.5 py-0.5 text-[12px] text-muted">
                          {who(t.assigneeId)} · {t.stageId ?? "build"}
                        </span>
                      </span>
                      <span className="mt-0.5 block text-[12px] text-muted">{t.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Agent Instructions -> Outbox */}
          <div>
            <h3 className="m-0 mb-2 flex items-center gap-2 text-[13px] font-semibold text-ink">
              <Icon name="outbox" size={18} className="text-accent" />
              Agent Instructions → Outbox ({instructions.filter((i) => i.approved).length}/{instructions.length})
            </h3>
            <div className="flex flex-col gap-2">
              {instructions.map((inst, idx) => (
                <label
                  key={`${inst.agentId}-${idx}`}
                  className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--surface-card)] p-3"
                >
                  <input
                    type="checkbox"
                    checked={inst.approved}
                    disabled={committed}
                    onChange={(e) =>
                      setInstructions((prev) =>
                        prev.map((item, i) => (i === idx ? { ...item, approved: e.target.checked } : item)),
                      )
                    }
                    className="mt-1"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink">To {who(inst.agentId)}</span>
                    <span className="block text-[12px] text-muted">{inst.instruction}</span>
                  </span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-5 py-3">
          <button type="button" className="btn text-[13px]" onClick={onClose}>
            Cancel
          </button>
          {!committed && (
            <button type="button" className="btn btn-primary flex items-center gap-1.5 text-[13px]" onClick={commit}>
              <Icon name="check_circle" size={16} /> Commit to Memory, Board & Outbox
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
