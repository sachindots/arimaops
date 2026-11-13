// SPDX-License-Identifier: AGPL-3.0-or-later
// "Drafts only" (rules.outbound, docs/templates.md section 6): agents in Marketing and Sales projects write messages,
// the owner sends them. Enforced, not only asked: these mail, CRM and social hosts are denied in the sandbox rules
// and the container proxy (on every port, so SMTP too), and MCP servers whose name or URL is one of them aren't attached.

/** Hosts that send mail, post to social networks or write to a CRM. "*.x" covers subdomains, not x itself. */
export const OUTBOUND_HOSTS = [
  // mail
  "gmail.googleapis.com", "mail.google.com", "smtp.gmail.com", "outlook.office.com", "outlook.office365.com", "smtp.office365.com", "graph.microsoft.com",
  "api.sendgrid.com", "api.mailgun.net", "api.eu.mailgun.net", "api.postmarkapp.com", "api.resend.com", "*.api.mailchimp.com", "mandrillapp.com",
  "api.brevo.com", "api.sendinblue.com", "email.us-east-1.amazonaws.com", "*.sparkpostmail.com", "api.smtp2go.com", "send.api.mailtrap.io",
  // social
  "api.twitter.com", "api.x.com", "upload.twitter.com", "graph.facebook.com", "graph.instagram.com", "graph.threads.net", "api.linkedin.com",
  "oauth.reddit.com", "open.tiktokapis.com", "bsky.social", "*.bsky.network", "api.buffer.com", "api.hootsuite.com", "*.mastodon.social",
  // chat
  "slack.com", "*.slack.com", "discord.com", "*.discord.com", "api.telegram.org", "graph.whatsapp.com",
  // CRM and sales outreach
  "api.hubapi.com", "api.hubspot.com", "*.salesforce.com", "*.force.com", "api.pipedrive.com", "*.pipedrive.com", "*.zoho.com", "api.attio.com",
  "api.close.com", "api.apollo.io", "api.instantly.ai", "api.lemlist.com", "api.outreach.io", "api.salesloft.com", "api.intercom.io",
];

/** Mail servers by their usual names: smtp., mail., imap., pop., mx. on any domain. */
const MAIL_PREFIX = /^(smtp|smtps|mail|imap|pop|pop3|mx)\d*\./;

/** True when host is one of the outbound hosts (any port). */
export function isOutboundHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (MAIL_PREFIX.test(h)) return true;
  return OUTBOUND_HOSTS.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) : h === p));
}

/** Words in an MCP server's name that mean it sends mail, posts or writes to a CRM. */
const MCP_WORDS = /(^|[-_])(e?mail|gmail|outlook|smtp|sendgrid|mailgun|postmark|resend|mailchimp|brevo|sparkpost|twitter|x|linkedin|facebook|instagram|threads|bluesky|bsky|reddit|tiktok|mastodon|buffer|hootsuite|slack|discord|telegram|whatsapp|hubspot|salesforce|pipedrive|zoho|attio|close|apollo|instantly|lemlist|outreach|salesloft|intercom|crm|social)($|[-_\d])/i;

/** Why an MCP server can't be attached in a drafts-only project, or null when it can. */
export function outboundMcpProblem(name: string, url?: string): string | null {
  if (MCP_WORDS.test(name)) return `"${name}" looks like a mail, social or CRM server, and this project is drafts only: agents write, you send.`;
  if (url) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      /* not a URL: the name decides */
    }
    if (host && isOutboundHost(host)) return `${host} sends mail, posts or writes to a CRM, and this project is drafts only: agents write, you send.`;
  }
  return null;
}
