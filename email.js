// ============================================================
// RMA Manager - Gmail API Email Reader
// ============================================================

const Email = (() => {
  const GMAIL           = 'https://gmail.googleapis.com/gmail/v1/users/me';
  const SUBJECT_PATTERN = /^RMA\s+#(\d+)\s+from\s+(.+?)\s+about\s+(.+)$/i;

  // Same brand list as pdf-parser.js — used to guess brand from subject line
  const SUBJECT_BRANDS = [
    ['Dan Clark Audio', 'Dan Clark', 'DCA'],
    ['64 Audio',        '64audio'],
    ['Campfire Audio',  'Campfire'],
    ['HiFiMAN',         'Hifiman'],
    ['Meze',            'MEZE'],
    ['Questyle'], ['LAiV'], ['HEDD'], ['Shanling'],
    ['Violectric'], ['D&A'], ['Final'], ['Palma'],
    ['DDHifi'], ['Lotoo'], ['Repeat'],
  ];

  function guessBrandFromAbout(text) {
    if (!text) return '';
    const lower = text.toLowerCase();
    const candidates = [];
    for (const [canonical, ...aliases] of SUBJECT_BRANDS) {
      for (const alias of [canonical, ...aliases]) {
        candidates.push({ canonical, alias, len: alias.length });
      }
    }
    candidates.sort((a, b) => b.len - a.len);
    for (const { canonical, alias } of candidates) {
      if (lower.includes(alias.toLowerCase())) return canonical;
    }
    return '';
  }

  // ---- Authenticated Gmail API fetch ----
  async function gmailFetch(path) {
    const token    = await Auth.getAccessToken();
    const response = await fetch(`${GMAIL}${path}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Gmail API ${response.status}: ${text.substring(0, 300)}`);
    }
    return response.json();
  }

  // ---- Parse "RMA #1140 from Audiofenzy about Final Wil Smeets" ----
  // Strips any leading Re:/Fw:/Fwd: prefixes (stacked) before matching.
  function parseSubject(subject) {
    const prefix = /^(Re|Fw|Fwd):\s*/i;
    let s = (subject || '').trim();
    while (prefix.test(s)) s = s.replace(prefix, '').trim();
    const m = s.match(SUBJECT_PATTERN);
    if (!m) return null;
    const about = m[3].trim();
    return {
      rmaNumber:  m[1].trim(),
      dealer:     m[2].trim(),
      customer:   about,
      brandGuess: guessBrandFromAbout(about)   // best-effort from subject
    };
  }

  // ---- Get a named header from a Gmail message headers array ----
  function getHeader(headers, name) {
    const h = (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase());
    return h ? h.value : '';
  }

  // ---- Decode a base64url-encoded body string to UTF-8 text ----
  function decodeBodyPart(data) {
    if (!data) return '';
    try {
      const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
      const binary  = atob(base64);
      const bytes   = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    } catch (_) { return ''; }
  }

  // ---- Recursively extract the first text/plain body from MIME parts ----
  function extractBodyText(payload) {
    if (!payload) return '';
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      return decodeBodyPart(payload.body.data);
    }
    if (payload.parts) {
      for (const part of payload.parts) {
        const text = extractBodyText(part);
        if (text) return text;
      }
    }
    return '';
  }

  // ---- Extract the original date from a forwarded-message body ----
  // Gmail wraps forwarded content in a header block:
  //   ---------- Forwarded message ---------
  //   From: Sender <sender@example.com>
  //   Date: Tue, 21 Jan 2025 at 10:15 AM
  //   Subject: RMA #1234 from ...
  //   To: you@domain.com
  // Outlook uses "Sent:" instead of "Date:".
  function extractForwardedDate(bodyText) {
    if (!bodyText) return '';
    // Gmail forwarded block
    const fwdMatch = bodyText.match(/[-]{3,}\s*Forwarded message\s*[-]{3,}([\s\S]{0,800})/i);
    if (fwdMatch) {
      const block     = fwdMatch[1];
      const dateMatch = block.match(/^Date:\s*(.+)$/im);
      if (dateMatch) {
        try {
          const d = new Date(dateMatch[1].trim());
          if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
        } catch (_) {}
      }
    }
    // Outlook / other clients: "Sent: Tuesday, January 21, 2025 10:15 AM"
    const sentMatch = bodyText.match(/^Sent:\s*(.+)$/im);
    if (sentMatch) {
      try {
        const d = new Date(sentMatch[1].trim());
        if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
      } catch (_) {}
    }
    return '';
  }

  // ---- Recursively find PDF attachments in the MIME part tree ----
  function findPDFParts(parts, found = []) {
    if (!parts) return found;
    for (const part of parts) {
      if (part.filename && part.body?.attachmentId) {
        const mime = (part.mimeType || '').toLowerCase();
        const name = (part.filename || '').toLowerCase();
        if (mime.includes('pdf') || name.endsWith('.pdf')) {
          found.push({ id: part.body.attachmentId, name: part.filename });
        }
      }
      if (part.parts) findPDFParts(part.parts, found);
    }
    return found;
  }

  // ---- Fetch all RMA emails from Gmail ----
  async function fetchRMAEmails(onProgress) {
    const results   = [];
    let   pageToken = null;
    let   page      = 0;
    let   scanned   = 0;
    let   skipped   = 0;

    do {
      if (onProgress) onProgress(`Scanning inbox (page ${++page})...`);

      // Use broad "subject:RMA" search — the regex does precise matching.
      // Avoid searching for "#" which Gmail's index may not handle reliably.
      const q       = encodeURIComponent('subject:RMA');
      const pgParam = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : '';
      const list    = await gmailFetch(`/messages?q=${q}&maxResults=50${pgParam}`);

      console.log(`[Email] Page ${page}: Gmail returned`, list.messages?.length ?? 0, 'messages');
      if (!list.messages?.length) break;

      for (const msg of list.messages) {
        try {
          // Fetch the full message (headers + body parts) in one call
          const full    = await gmailFetch(`/messages/${msg.id}?format=full`);
          const subject = getHeader(full.payload.headers, 'Subject');
          scanned++;
          const parsed  = parseSubject(subject);
          if (!parsed) {
            skipped++;
            console.log('[Email] No match (skipped):', subject);
            continue;
          }

          // Parse the date — priority order:
          //   1. Date line inside the "Forwarded message" block in the body
          //      (survives any number of forwards; written by the original sender)
          //   2. internalDate (set by Google when the forwarded email arrived)
          //   3. Date header (least reliable — rewritten by the forwarding client)
          let dateStr = '';
          try {
            const bodyText = extractBodyText(full.payload);
            const fwdDate  = extractForwardedDate(bodyText);
            if (fwdDate) {
              dateStr = fwdDate;
              console.log(`[Email] Forwarded-message date used: ${fwdDate}`);
            } else if (full.internalDate) {
              dateStr = new Date(parseInt(full.internalDate, 10)).toISOString().split('T')[0];
            } else {
              dateStr = new Date(getHeader(full.payload.headers, 'Date')).toISOString().split('T')[0];
            }
          } catch (_) {}

          const attachments = findPDFParts(full.payload.parts);

          results.push({
            messageId:        msg.id,
            subject,
            receivedDateTime: dateStr,
            hasAttachments:   attachments.length > 0,
            attachments,         // already extracted — no extra API call needed
            parsed
          });
        } catch (err) {
          console.warn('[Email] Skipping message:', err.message);
        }
      }

      pageToken = list.nextPageToken || null;
    } while (pageToken);

    console.log(`[Email] Scan complete: ${scanned} subjects examined, ${skipped} skipped (no pattern match), ${results.length} RMA emails found`);
    return results;
  }

  // ---- Download one attachment — returns { buffer: ArrayBuffer, filename } ----
  async function downloadAttachment(messageId, attachmentId, filename) {
    const data = await gmailFetch(`/messages/${messageId}/attachments/${attachmentId}`);
    if (!data.data) throw new Error('Empty attachment data');

    // Gmail uses base64url (- and _ instead of + and /)
    const base64 = data.data.replace(/-/g, '+').replace(/_/g, '/');
    const binary  = atob(base64);
    const bytes   = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    return { buffer: bytes.buffer, filename: filename || 'attachment.pdf' };
  }

  return { fetchRMAEmails, downloadAttachment, parseSubject };
})();
