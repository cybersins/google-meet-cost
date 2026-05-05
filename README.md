# Google Meeting Cost Auto-Reply
A Google Apps Script that monitors your Gmail inbox for meeting invites organized by people in specified domains, calculates the cost of each meeting based on attendee count and duration, and replies to the organizer with a breakdown.

## What it does
When a meeting invite lands in your inbox from an organizer in a configured **source domain**, the script:

1. Parses the attached `.ics` calendar file
2. Counts attendees who are also from the source domains (organizer included)
3. Computes `Total Cost = Hourly Rate × Attendee Count × Duration in Hours`
4. Replies to the organizer with the figure and a short breakdown

Cancellations (`METHOD:CANCEL`) and meeting responses (`METHOD:REPLY`) are ignored. Updated invites with a new `SEQUENCE` value re-trigger the calculation, so cost gets refreshed when meetings are rescheduled or attendees change.

## Features
- **Domain-scoped trigger** — only invites organized by people in `SOURCE_DOMAINS` are processed
- **Sender allowlist** — exempt specific organizer addresses
- **Subject allowlist** — exempt by substring match or regex (with a `regex:` prefix)
- **HTML reply** with formatted breakdown
- **Deduplication** by `UID + SEQUENCE` so each invite version is replied to exactly once
- **Structured logging** with per-run IDs for end-to-end traceability
- **Draft mode** for safe testing before going live

## Example reply
```
Thanks for including me in the email reply. Here are some meeting insights
for your consideration. It does not include if there are participants from
the mailing-group.

Total Cost of the meeting is: 1200.00 USD

  • Attendees from monitored domains: 4
  • Meeting duration: 2.00 hour(s)
  • Hourly rate: 150 USD
```

## Prerequisites
- A Google Workspace or personal Gmail account
- Permission to authorize an Apps Script project against your Gmail
- The script runs as **your user**, so all replies come from your address

## Setup
1. Go to <https://script.google.com> and create a new project
2. Paste the contents of `MeetingCostAutoReply.gs` into the editor
3. Edit the `CONFIG` block at the top of the file (see below)
4. Save the project
5. Run `installTrigger` once — Google will prompt for Gmail and Trigger authorization
6. *(Recommended for first day)* Set `DRAFT_ONLY: true` in `CONFIG` to verify outputs before live replies start going out

## Configuration

| Field | Type | Description |
|---|---|---|
| `SOURCE_DOMAINS` | `string[]` | Domains whose meeting invites should trigger the script |
| `APPROVED_SENDERS` | `string[]` | Organizer emails that are exempt from auto-reply |
| `APPROVED_SUBJECTS` | `string[]` | Exempt subject patterns (see below) |
| `UNIT_PRICE_PER_HOUR_USD` | `number` | Hourly rate per attendee from a source domain |
| `LOOKBACK_MINUTES` | `number` | How far back the scheduled scan looks; should be ≥ trigger interval |
| `REPLY_TO_ALL` | `boolean` | If `true`, reply-all instead of just the organizer |
| `DRAFT_ONLY` | `boolean` | If `true`, create drafts instead of sending |
| `PROCESSED_LABEL` | `string` | Gmail label applied to handled threads |
| `LOG_LEVEL` | `string` | `'debug'`, `'info'`, `'warn'`, or `'error'` |

### Subject pattern format
Each entry in `APPROVED_SUBJECTS` is one of:

- A plain string — matched as a **case-insensitive substring** of the subject
- A string prefixed with `regex:` — the rest is compiled as a **case-insensitive regex**

Examples:

```javascript
APPROVED_SUBJECTS: [
  'Quarterly Review',           // matches "Q3 Quarterly Review", "quarterly review prep", etc.
  'regex:^\\[INTERNAL\\].*',    // matches subjects starting with [INTERNAL]
  'regex:1:1|1-on-1'            // matches either "1:1" or "1-on-1"
]
```

## How it works
The script runs on a **5-minute time-based trigger** (configurable in `installTrigger`). On each run it:

1. Searches Gmail for recent inbox messages with `.ics` attachments
2. For each message, parses the ICS file: `UID`, `SEQUENCE`, `METHOD`, `DTSTART`, `DTEND`, `ORGANIZER`, `ATTENDEE`
3. Skips the message if `METHOD ≠ REQUEST`, if already processed (`UID + SEQUENCE` seen before), or if any approval filter matches
4. Counts unique source-domain attendees, computes duration, calculates total cost
5. Sends or drafts the reply (HTML body)
6. Records the dedupe key in `PropertiesService` and applies the processed label to the thread

## Logging
Every run emits a `Run started` and `Run finished` log entry with a counter summary. Each log line is prefixed with an 8-character run ID so you can grep one execution out of a noisy day.

**Where to view logs:**
- Apps Script editor → **Executions** tab — per-run view, click any row to expand
- For cross-run searches and structured queries: **Project Settings → "View Cloud logs in Google Cloud Platform"**

**Counter fields in the run summary:**

| Field | Meaning |
|---|---|
| `threads`, `messages` | Totals scanned this run |
| `replied`, `drafted` | Actions taken |
| `skippedNoIcs` | Message had no `.ics` or it was unparseable |
| `skippedNonRequest` | `METHOD` was not `REQUEST` (e.g. cancellation) |
| `skippedDedupe` | Already processed this `UID + SEQUENCE` |
| `skippedDomain` | Organizer not in `SOURCE_DOMAINS` |
| `skippedApprovedSender` | Organizer in `APPROVED_SENDERS` |
| `skippedApprovedSubject` | Subject matched `APPROVED_SUBJECTS` |
| `skippedNoOrganizer` | Could not determine organizer email |
| `skippedBadDuration` | Missing or non-positive duration |
| `errors` | Exceptions caught during the run |

Set `LOG_LEVEL: 'debug'` to also log every message considered, including ones with no ICS. `'info'` is the right default once it's running steady.

## Limitations
- **Distribution lists and Google Groups count as one attendee.** Expanding group membership requires the Admin SDK Directory API, which only works for groups within your own Workspace domain. External groups cannot be expanded by a regular user. The reply note ("does not include participants from the mailing-group") flags this to the organizer.
- The script runs as **your user account**. Replies come from your address. Shared mailboxes or service-account deployments need a different model.
- Apps Script has no native push trigger for incoming email; the 5-minute scheduled scan is the standard pattern. Worst-case latency is roughly the trigger interval.
- All-day events (`DTSTART`/`DTEND` with no time component) are parsed as midnight-to-midnight in local time.

## Maintenance
| Function | Purpose |
|---|---|
| `installTrigger()` | Install or reinstall the 5-minute scheduled trigger (run once after editing config) |
| `clearProcessedHistory()` | Wipe the dedupe cache; previously-replied meetings will be replied to again on the next matching message |

## File structure
```
.
├── MeetingCostAutoReply.gs    Main script (paste into Apps Script editor)
└── README.md                  This file
```

## License
MIT 
