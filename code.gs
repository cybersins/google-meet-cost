/**
 * Meeting Cost Auto-Reply
 * Monitors Gmail for meeting invites organized by people in specified
 * domains and replies with the estimated cost.
 */

// =====================================================================
// CONFIGURATION  — edit this block
// =====================================================================
const CONFIG = {
  SOURCE_DOMAINS: ['mydomain.com', 'myvendor.com'],
  APPROVED_SENDERS: ['ceo@myvendor.com', 'pm@mydomain.com'], // no need to send auto-reply
  APPROVED_SUBJECTS: [
    'Quarterly Review',
    'regex:^\\[INTERNAL\\].*'
  ],

  UNIT_PRICE_PER_HOUR_USD: 100, // Average Unit Price for an hour of each employee/ attendee (in USD)
  LOOKBACK_MINUTES: 30,

  REPLY_TO_ALL: false, // auto-reply to all in the invite (be careful!)
  DRAFT_ONLY:   false, // DRAFT but do not send

  PROCESSED_LABEL: 'MeetingCost', // a label on Google Mail to track which invites have been replied. Change as per your preference.

  // Logging verbosity: 'debug' | 'info' | 'warn' | 'error'
  LOG_LEVEL: 'info'
};

// =====================================================================
// ENTRY POINT — bind a time-based trigger to this function
// =====================================================================
function processMeetingInvites() {
  const runId = Utilities.getUuid().substring(0, 8);
  const log = makeLogger_(runId);
  const stats = {
    threads: 0, messages: 0, replied: 0, drafted: 0,
    skippedNoIcs: 0, skippedNonRequest: 0, skippedDedupe: 0,
    skippedDomain: 0, skippedApprovedSender: 0, skippedApprovedSubject: 0,
    skippedNoOrganizer: 0, skippedBadDuration: 0, errors: 0
  };

  const startedAt = Date.now();
  log.info('Run started', {
    sourceDomains: CONFIG.SOURCE_DOMAINS,
    approvedSenders: CONFIG.APPROVED_SENDERS.length,
    approvedSubjects: CONFIG.APPROVED_SUBJECTS.length,
    unitPriceUsd: CONFIG.UNIT_PRICE_PER_HOUR_USD,
    replyMode: CONFIG.DRAFT_ONLY ? 'draft' : (CONFIG.REPLY_TO_ALL ? 'replyAll' : 'reply')
  });

  try {
    const props = PropertiesService.getScriptProperties();
    const label = getOrCreateLabel_(CONFIG.PROCESSED_LABEL);

    const lookbackHours = Math.max(1, Math.ceil(CONFIG.LOOKBACK_MINUTES / 60));
    const query = `in:inbox newer_than:${lookbackHours}h has:attachment filename:ics`;
    log.debug('Gmail search query', { query });

    const threads = GmailApp.search(query, 0, 50);
    stats.threads = threads.length;
    log.info('Threads matched', { count: threads.length });

    threads.forEach((thread, ti) => {
      const messages = thread.getMessages();
      log.debug('Thread ' + (ti + 1) + '/' + threads.length, {
        threadId: thread.getId(), messageCount: messages.length
      });

      messages.forEach(message => {
        stats.messages++;
        try {
          handleMessage_(message, props, label, log, stats);
        } catch (err) {
          stats.errors++;
          log.error('Exception while handling message', {
            messageId: message.getId(),
            subject: safeSubject_(message),
            error: err && err.stack ? err.stack : String(err)
          });
        }
      });
    });
  } catch (err) {
    stats.errors++;
    log.error('Run failed', { error: err && err.stack ? err.stack : String(err) });
  } finally {
    log.info('Run finished', Object.assign({ durationMs: Date.now() - startedAt }, stats));
  }
}

// =====================================================================
// PER-MESSAGE PROCESSING
// =====================================================================
function handleMessage_(message, props, label, log, stats) {
  const ctx = {
    messageId: message.getId(),
    subject: safeSubject_(message),
    from: message.getFrom()
  };
  log.debug('Considering message', ctx);

  const ics = getIcsAttachment_(message);
  if (!ics) {
    stats.skippedNoIcs++;
    log.debug('Skip: no ICS attachment', ctx);
    return;
  }

  const event = parseIcs_(ics.getDataAsString());
  if (!event) {
    stats.skippedNoIcs++;
    log.debug('Skip: ICS unparseable or missing UID/start/end', ctx);
    return;
  }

  ctx.uid = event.uid;
  ctx.sequence = event.sequence || '0';
  ctx.method = event.method || '(none)';

  if (event.method && event.method.toUpperCase() !== 'REQUEST') {
    stats.skippedNonRequest++;
    log.debug('Skip: METHOD is not REQUEST', ctx);
    return;
  }

  const dedupeKey = 'PROCESSED::' + event.uid + '::' + (event.sequence || '0');
  if (props.getProperty(dedupeKey)) {
    stats.skippedDedupe++;
    log.debug('Skip: already processed (UID+SEQUENCE)', ctx);
    return;
  }

  const organizerEmail = (event.organizer || extractEmail_(message.getFrom()) || '').toLowerCase();
  if (!organizerEmail) {
    stats.skippedNoOrganizer++;
    log.warn('Skip: cannot determine organizer', ctx);
    return;
  }
  ctx.organizer = organizerEmail;

  const sourceDomains = CONFIG.SOURCE_DOMAINS.map(d => d.toLowerCase());
  const organizerDomain = organizerEmail.split('@')[1] || '';
  ctx.organizerDomain = organizerDomain;

  if (!sourceDomains.includes(organizerDomain)) {
    stats.skippedDomain++;
    log.debug('Skip: organizer domain not in SOURCE_DOMAINS', ctx);
    return;
  }

  const approvedSenders = CONFIG.APPROVED_SENDERS.map(s => s.toLowerCase());
  if (approvedSenders.includes(organizerEmail)) {
    stats.skippedApprovedSender++;
    log.info('Skip: organizer is in APPROVED_SENDERS', ctx);
    markProcessed_(props, dedupeKey, message, label);
    return;
  }

  const subject = message.getSubject() || event.summary || '';
  const subjectMatch = matchedApprovedSubject_(subject);
  if (subjectMatch) {
    stats.skippedApprovedSubject++;
    log.info('Skip: subject matched APPROVED_SUBJECTS', Object.assign({}, ctx, { matchedPattern: subjectMatch }));
    markProcessed_(props, dedupeKey, message, label);
    return;
  }

  // USER_COUNT: organizer plus attendees from SOURCE_DOMAINS, deduped.
  const sourceAttendees = new Set();
  sourceAttendees.add(organizerEmail);
  (event.attendees || []).forEach(a => {
    const d = (a.split('@')[1] || '').toLowerCase();
    if (sourceDomains.includes(d)) sourceAttendees.add(a.toLowerCase());
  });
  const userCount = sourceAttendees.size;

  if (!event.start || !event.end) {
    stats.skippedBadDuration++;
    log.warn('Skip: missing DTSTART or DTEND', ctx);
    return;
  }
  const durationHours = (event.end.getTime() - event.start.getTime()) / 3600000;
  if (durationHours <= 0) {
    stats.skippedBadDuration++;
    log.warn('Skip: non-positive duration', Object.assign({}, ctx, {
      start: event.start.toISOString(), end: event.end.toISOString()
    }));
    return;
  }

  const totalCost = CONFIG.UNIT_PRICE_PER_HOUR_USD * userCount * durationHours;

  log.info('Calculated meeting cost', Object.assign({}, ctx, {
    start: event.start.toISOString(),
    end: event.end.toISOString(),
    durationHours: +durationHours.toFixed(4),
    userCount: userCount,
    sourceAttendees: Array.from(sourceAttendees),
    totalAttendeesInIcs: (event.attendees || []).length,
    unitPriceUsd: CONFIG.UNIT_PRICE_PER_HOUR_USD,
    totalCostUsd: +totalCost.toFixed(2)
  }));

// plain-text body
  const body =
    'Thanks for including me in the email reply. Here are some meeting insights for your consideration. It doesn not include if there are participants from the mailing-group.\n\n' +
    'Total Cost of the meeting is: ' + totalCost.toFixed(2) + ' USD\n\n' +
    'Breakdown:\n' +
    '  • Attendees from monitored domains: ' + userCount + '\n' +
    '  • Meeting duration: ' + durationHours.toFixed(2) + ' hour(s)\n' +
    '  • Hourly rate: ' + CONFIG.UNIT_PRICE_PER_HOUR_USD + ' USD\n\n' +
    'Please consider the meeting costs, and looking forward to speaking to you!';

// html body
const htmlBody =
  '<p>Thanks for including me in the email reply. Here are some meeting insights for your consideration. It does not include if there are participants from the mailing-group.</p>' +
  '<p><strong>Total Cost of the meeting is: ' + totalCost.toFixed(2) + ' USD</strong></p>' +
  '<ul>' +
  '<li>Attendees from monitored domains (excluding mailing-groups): ' + userCount + '</li>' +
  '<li>Meeting duration: ' + durationHours.toFixed(2) + ' hour(s)</li>' +
  '<li>Hourly rate: ' + CONFIG.UNIT_PRICE_PER_HOUR_USD + ' USD</li>' +
  '</ul>';

  if (CONFIG.DRAFT_ONLY) {
    message.createDraftReply(body, { htmlBody: htmlBody }); // plain text fall back if html fails to load
    stats.drafted++;
    log.info('Action: draft reply created', ctx);
  } else if (CONFIG.REPLY_TO_ALL) {
    message.replyAll(body, { htmlBody: htmlBody }); // plain text fall back if html fails to load
    stats.replied++;
    log.info('Action: reply-all sent', ctx);
  } else {
    message.reply(body, { htmlBody: htmlBody }); // plain text fall back if html fails to load
    stats.replied++;
    log.info('Action: reply sent to organizer', ctx);
  }

  markProcessed_(props, dedupeKey, message, label);
  log.debug('Marked processed', Object.assign({}, ctx, { dedupeKey: dedupeKey }));
}

// =====================================================================
// HELPERS
// =====================================================================
function getIcsAttachment_(message) {
  const atts = message.getAttachments({ includeInlineImages: false, includeAttachments: true });
  for (let i = 0; i < atts.length; i++) {
    const name = (atts[i].getName() || '').toLowerCase();
    const type = (atts[i].getContentType() || '').toLowerCase();
    if (name.endsWith('.ics') || type.indexOf('text/calendar') !== -1) return atts[i];
  }
  return null;
}

function parseIcs_(text) {
  const unfolded = text.replace(/\r?\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);

  const event = { attendees: [] };
  let inEvent = false;

  lines.forEach(line => {
    if (line === 'BEGIN:VEVENT') { inEvent = true; return; }
    if (line === 'END:VEVENT')   { inEvent = false; return; }

    if (line.indexOf('METHOD:') === 0) event.method = line.substring(7).trim();
    if (!inEvent) return;

    if (line.indexOf('UID:') === 0)            event.uid      = line.substring(4).trim();
    else if (line.indexOf('SEQUENCE:') === 0)  event.sequence = line.substring(9).trim();
    else if (line.indexOf('SUMMARY:') === 0)   event.summary  = line.substring(8).trim();
    else if (line.indexOf('DTSTART') === 0)    event.start    = parseIcsDate_(line);
    else if (line.indexOf('DTEND') === 0)      event.end      = parseIcsDate_(line);
    else if (line.indexOf('ORGANIZER') === 0) {
      const m = line.match(/mailto:([^;:>\s]+)/i);
      if (m) event.organizer = m[1].toLowerCase();
    } else if (line.indexOf('ATTENDEE') === 0) {
      const m = line.match(/mailto:([^;:>\s]+)/i);
      if (m) event.attendees.push(m[1].toLowerCase());
    }
  });

  return (event.uid && event.start && event.end) ? event : null;
}

function parseIcsDate_(line) {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;
  const value = line.substring(colonIdx + 1).trim();

  let m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (m) {
    const y=+m[1], mo=+m[2]-1, d=+m[3], h=+m[4], mi=+m[5], s=+m[6];
    return m[7] === 'Z' ? new Date(Date.UTC(y, mo, d, h, mi, s)) : new Date(y, mo, d, h, mi, s);
  }
  m = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3]);
  return null;
}

// Returns the matched pattern string, or null if none matched.
function matchedApprovedSubject_(subject) {
  const subj = (subject || '').toLowerCase();
  for (let i = 0; i < CONFIG.APPROVED_SUBJECTS.length; i++) {
    const pattern = CONFIG.APPROVED_SUBJECTS[i];
    if (pattern.toLowerCase().indexOf('regex:') === 0) {
      try {
        if (new RegExp(pattern.substring(6), 'i').test(subject)) return pattern;
      } catch (e) { /* ignore bad regex */ }
    } else if (subj.indexOf(pattern.toLowerCase()) !== -1) {
      return pattern;
    }
  }
  return null;
}

function extractEmail_(fromString) {
  if (!fromString) return null;
  const m = fromString.match(/<([^>]+)>/);
  return (m ? m[1] : fromString).trim().toLowerCase();
}

function getOrCreateLabel_(name) {
  return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name);
}

function markProcessed_(props, dedupeKey, message, label) {
  props.setProperty(dedupeKey, String(Date.now()));
  try { message.getThread().addLabel(label); } catch (e) {}
}

function safeSubject_(message) {
  try { return message.getSubject(); } catch (e) { return '(unavailable)'; }
}

// =====================================================================
// LOGGING
// =====================================================================
function makeLogger_(runId) {
  const levels = { debug: 10, info: 20, warn: 30, error: 40 };
  const threshold = levels[CONFIG.LOG_LEVEL] || levels.info;

  function emit(level, fn, msg, data) {
    if (levels[level] < threshold) return;
    const payload = '[' + runId + '] ' + msg + (data ? ' ' + JSON.stringify(data) : '');
    fn(payload);
  }

  return {
    debug: (msg, data) => emit('debug', console.log,   msg, data),
    info:  (msg, data) => emit('info',  console.info,  msg, data),
    warn:  (msg, data) => emit('warn',  console.warn,  msg, data),
    error: (msg, data) => emit('error', console.error, msg, data)
  };
}

// =====================================================================
// SETUP — Run once for your trigger!
// =====================================================================
function installTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processMeetingInvites')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('processMeetingInvites')
    .timeBased()
    .everyMinutes(5)
    .create();
}

function clearProcessedHistory() {
  PropertiesService.getScriptProperties().deleteAllProperties();
}
