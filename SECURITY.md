# Security Policy

## Supported versions

mcp-cassette is pre-1.0. Security fixes land on the latest released minor
version; there are no long-term support branches yet.

| Version | Supported |
|---|---|
| 0.1.x | Yes |
| < 0.1 | No |

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately by email to **ivermin1123@gmail.com**, with `mcp-cassette
security` in the subject line.

Helpful things to include:

- What the issue is and why you think it's a security problem
- The version or commit you tested
- Steps to reproduce, ideally a minimal cassette or server command
- What an attacker could achieve

## What to expect

- **Acknowledgement within 3 business days.** If you don't hear back, please
  send a follow-up. Assume the mail was lost rather than ignored.
- **An initial assessment within 7 days**, saying whether the report is
  accepted, needs more information, or is out of scope, and why.
- **A fix or a documented mitigation for accepted reports**, released as a
  patch version. Timing depends on severity; I'll keep you updated on progress.
- **Credit in the release notes** for the fix, unless you'd rather stay
  anonymous. Just say so.

Please give me a reasonable window to ship a fix before disclosing publicly.

## Scope notes

A few things are worth stating plainly, because they shape what counts as a
vulnerability here:

- **Cassettes are untrusted input.** `replay` parses cassette files that may
  have come from anywhere. Parser crashes, path traversal, or anything that
  escalates a malicious cassette into code execution is in scope.
- **Cassettes may contain secrets.** A recording is a faithful transcript of a
  real session, so it can capture tokens or personal data that were in the
  traffic. Treat cassette files as sensitive and review them before committing.
  Automatic redaction is on the roadmap; its absence today is a known
  limitation, not a vulnerability report.
- **The safety lint is a heuristic tripwire, not a security boundary.** The
  `CAS-L*` rules catch known *shapes* of tool-poisoning attacks. A crafted
  description that evades them is expected and not itself a vulnerability. A
  report showing a common evasion the rules should catch is very welcome
  though, and a good candidate for a public issue.
- **`record` and `check` execute the server command you give them.** That's the
  intended design, the same as any process runner. Passing an untrusted command
  string is a misuse, not a vulnerability.
