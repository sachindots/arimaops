# Security

ArimaOps runs AI agents with access to your code, your shell and, if you add them, your API keys. Security reports are welcome and taken seriously.

## Report a vulnerability

Please **don't open a public issue**. Use GitHub's private reporting instead: on the repository, open **Security → Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You'll get a reply within 7 days. Once a fix ships, the advisory credits you unless you'd rather stay anonymous.

## Supported versions

Only the latest release gets security fixes. Update with `npx arimaops@latest`.

## In scope

- Getting past sign-in, roles or the authenticator step-up.
- Reading another project's or another agent's data, or an API key, without permission.
- An agent escaping its folder, container or sandbox through ArimaOps.
- Keys or tokens showing up unmasked in the UI, logs or files.
- A web page in your browser driving ArimaOps (origin checks).

## Check a release

Each GitHub release has a `SHA256SUMS` file and a build-provenance attestation:

```bash
sha256sum -c SHA256SUMS
gh attestation verify arimaops-<version>.tgz --repo sachindots/arimaops
```

How the security boundaries work: [docs/architecture.md](docs/architecture.md#2-security-boundaries-today).
