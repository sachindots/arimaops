// SPDX-License-Identifier: AGPL-3.0-or-later
// When the owner was last seen (docs/agent-engine.md section 4): a command from any of the owner's devices or a
// page or app connecting. Operators don't count. One owner per HQ, so this is machine-wide.
// HQ starting counts as seen: after a restart the owner is never assumed away.

export const AWAY_MS = 2 * 60 * 60_000;

let seenAt = Date.now();

export function ownerSeen(at = Date.now()) {
  seenAt = Math.max(seenAt, at);
}

export const ownerSeenAt = () => seenAt;

export const ownerAway = (now = Date.now()) => now - seenAt >= AWAY_MS;
