// SPDX-License-Identifier: AGPL-3.0-or-later
// One project's lesson promotion (server/lessons.ts does the work): the switch, a run on the owner's request, the
// Action items it files, and the state Settings → Memory shows. Every open project made from the same template sees
// the same approved lessons.

import type { LessonsState } from "../src/data/types";
import type { ActionItems } from "./actionItems";
import { redactor } from "./credentials/registry";
import type { Hub } from "./hub";
import { hqDb } from "./lib/db";
import { decideLesson, projectWords, promoteLessons, templateIdOf, templateLessons } from "./lessons";
import { extractionSettings, memoryStore } from "./memory";
import { helperRunner } from "./memoryJobs";
import { decideProposal, draftProposal, pendingProposals, repeatedFailures, snoozed } from "./proposals";
import { getTemplate } from "./templates";
import { broadcastLibrary } from "./templateIO";
import { EXTRACT_MODEL } from "./memoryExtract";
import { isScorerId, SCORERS } from "../src/data/scorers";

const open = new Set<LessonPromotion>();

export class LessonPromotion {
  private running = false;
  private last: string | null = null;
  private improving = false;
  private improved: string | null = null;

  constructor(
    private hub: Hub,
    private actions: () => ActionItems | null,
  ) {
    open.add(this);
    this.publish();
  }

  close() {
    open.delete(this);
  }

  /** Off by default for security engagements: a client's network must never reach the next client's brief. */
  enabled() {
    const cfg = this.hub.snap.config;
    return cfg.project.promoteLessons ?? !cfg.rules?.findings;
  }

  state(): LessonsState {
    const templateId = templateIdOf(hqDb(), this.hub.snap.config.project.id);
    const all = templateId ? templateLessons(hqDb(), templateId) : [];
    return {
      templateId,
      enabled: this.enabled(),
      approved: all.filter((l) => l.status === "approved"),
      pending: all.filter((l) => l.status === "pending").length,
      running: this.running,
      last: this.last,
      improvements: { running: this.improving, pending: templateId ? pendingProposals(hqDb(), templateId) : 0, last: this.improved },
    };
  }

  publish() {
    const lessons = this.state();
    this.hub.snap.lessons = lessons;
    this.hub.emit({ type: "lessons.updated", lessons });
  }

  /** The approved list changed: every project on that template hears it. */
  private publishAll() {
    for (const p of open) p.publish();
  }

  setEnabled(on: boolean) {
    this.hub.snap.config.project.promoteLessons = on;
    this.hub.configChanged();
    this.hub.activity("config", null, on ? "Lesson promotion is on for this project: its certified lessons can be offered to its template." : "Lesson promotion is off for this project.");
    this.publish();
  }

  /** The owner asked: rewrite the certified lessons with Haiku and file each survivor for approval. */
  async run(): Promise<void> {
    const { project } = this.hub.snap.config;
    const templateId = templateIdOf(hqDb(), project.id);
    const say = (text: string) => {
      this.last = text;
      this.hub.activity("config", null, text);
    };
    if (this.running) return;
    if (!templateId) return say("This project was made before templates: there's no template to promote lessons to.");
    if (!this.enabled()) return say("Lesson promotion is off for this project. Turn it on in Settings → Memory first.");
    const settings = extractionSettings();
    if (!settings.enabled) return say("Lesson promotion uses Claude Haiku: turn on memory extraction in Settings → Memory first.");
    this.running = true;
    this.publish();
    try {
      const mem = memoryStore();
      const memories = await mem.memories(project.id);
      const r = await promoteLessons(
        hqDb(),
        templateId,
        memories,
        { projectId: project.id, words: projectWords(project), keepOut: mem.keptOut(project.id), redact: (x) => redactor().redact(x) },
        async (req) => (await helperRunner().run({ account: settings.account, model: req.model, system: req.system, prompt: req.prompt, maxTokens: 3000, purpose: "helper", projectId: project.id })).text,
      );
      for (const l of r.offered) this.actions()?.addLesson(l);
      say(
        r.offered.length || r.dropped
          ? `Lessons for the template: ${r.offered.length} waiting for your check (Action items)${r.dropped ? `, ${r.dropped} dropped because the rewrite still named something of this project` : ""}.`
          : r.seen
            ? "No new certified lessons since the last promotion."
            : "No certified Lessons, Decisions or Dead ends yet: certify some in Action items first.",
      );
    } catch (e) {
      say(`Couldn't promote lessons: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.running = false;
      this.publish();
    }
  }

  /**
   * Template changes from repeated failures (docs/factory.md section 5), nightly or on the owner's request: failures
   * from every open project on this template that allows promotion, at the library's current version. One Haiku call
   * per new pattern; a pattern proposed, decided or dropped in the last 30 days is skipped.
   */
  async improve(now = Date.now()): Promise<void> {
    const { project } = this.hub.snap.config;
    const templateId = templateIdOf(hqDb(), project.id);
    const say = (text: string) => {
      this.improved = text;
      this.hub.activity("config", null, text);
    };
    if (this.improving || !templateId) return;
    if (!this.enabled()) return say("Template improvements are off for this project: they use the same switch as lesson promotion (Settings → Memory).");
    const settings = extractionSettings();
    if (!settings.enabled) return say("Template improvements use Claude Haiku: turn on memory extraction in Settings → Memory first.");
    const t = getTemplate(hqDb(), templateId);
    if (!t) return say(`Template "${templateId}" is no longer in the library.`);
    const peers = [...open].filter((p) => p.enabled() && templateIdOf(hqDb(), p.hub.snap.config.project.id) === templateId);
    const mem = memoryStore();
    const src = {
      words: peers.flatMap((p) => projectWords(p.hub.snap.config.project)),
      keepOut: peers.flatMap((p) => mem.keptOut(p.hub.snap.config.project.id)),
    };
    const fresh = repeatedFailures(hqDb(), t, peers.map((p) => p.hub.snap.config.project.id), now, (x) => redactor().redact(x)).filter((f) => !snoozed(hqDb(), t.id, f.pattern, now));
    if (!fresh.length) return say(`No new repeated failures on ${t.name} v${t.version} (3 tasks within 30 days).`);
    this.improving = true;
    this.publishAll();
    let offered = 0;
    const dropped: string[] = [];
    try {
      for (const f of fresh.slice(0, 3)) {
        const r = await draftProposal(hqDb(), t, f, src, async (req) => (await helperRunner().run({ account: settings.account, model: EXTRACT_MODEL, system: req.system, prompt: req.prompt, maxTokens: 800, purpose: "helper", projectId: project.id })).text, now);
        if ("dropped" in r) {
          dropped.push(r.dropped);
          continue;
        }
        const [kind, id] = f.pattern.split(":");
        const label = kind === "scorer" && isScorerId(id) ? `"${SCORERS[id].label}"` : `The ${id} gate`;
        this.actions()?.addProposal({ ...r.proposal, tasks: f.tasks, label, why: r.proposal.why });
        offered++;
      }
      say(
        `Template improvements: ${offered ? `${offered} change${offered === 1 ? "" : "s"} waiting for you in Action items` : "nothing to propose"}${dropped.length ? `; ${dropped.length} dropped (${dropped[0]})` : ""}.`,
      );
    } catch (e) {
      say(`Couldn't draft template improvements: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.improving = false;
      this.publishAll();
    }
  }

  /** The owner's answer on a proposal: approve saves the template under a new version. */
  decideProposal(id: string, approve: boolean) {
    const r = decideProposal(hqDb(), id, approve);
    if (r.error) this.hub.activity("config", null, `Couldn't save the template change: ${r.error}`);
    else if (r.saved) {
      this.hub.activity("config", null, `Template ${r.saved.name} saved as v${r.saved.version}. New projects get it; re-sync a project (Settings → Team) to give it the change.`);
      broadcastLibrary(hqDb());
    } else if (!approve) this.hub.activity("config", null, "Template change rejected: that failure won't be proposed again for 30 days.");
    this.publishAll();
  }

  /** The owner's answer in Action items, or a removal from Settings. */
  decide(id: string, approve: boolean) {
    const l = decideLesson(hqDb(), id, approve);
    if (l) this.hub.activity("config", null, approve ? `Lesson added to the template: new projects from it get it in their briefs.` : `Lesson ${l.status === "rejected" ? "left out of" : "removed from"} the template.`);
    this.publishAll();
  }
}
