/**
 * Pokédex sign-up list – Google Apps Script web app.
 *
 * Setup (once):
 *  1. Create a new Google Sheet (https://sheets.new) and name it e.g. "הפוקדקס – נרשמים".
 *  2. Extensions → Apps Script. Delete the sample code and paste this whole file. Save.
 *  3. Deploy → New deployment → type "Web app".
 *       Execute as: Me    ·    Who has access: Anyone
 *     Deploy, approve the permissions, and copy the Web app URL (ends with /exec).
 *  4. Put that URL in SIGNUP_ENDPOINT in pokemon/index.html.
 *
 * Every sign-up (or profile edit) adds or updates one row, keyed by the user's random id.
 */
const SHEET_NAME = 'נרשמים';
const HEADERS = ['מזהה', 'שם', 'טלפון', 'אישור (כולל הורה)', 'נרשם בתאריך', 'עודכן לאחרונה', 'מכשיר'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const d = JSON.parse(e.postData.contents);
    const clean = (v, max) => {
      const s = String(v == null ? '' : v).slice(0, max).trim();
      return /^[=+\-@]/.test(s) ? "'" + s : s; // never let user text become a spreadsheet formula
    };
    const id = clean(d.id, 40);
    const name = clean(d.name, 60);
    const phone = String(d.phone || '').replace(/[^\d+]/g, '').slice(0, 16);
    if (!id || name.length < 2 || phone.length < 8) return json({ ok: false, error: 'invalid' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sh.getLastRow() === 0) {
      sh.appendRow(HEADERS);
      sh.setFrozenRows(1);
      sh.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
      sh.setRightToLeft(true);
    }
    const registered = Number(d.registeredAt) ? new Date(Number(d.registeredAt)) : new Date();
    const row = [id, name, "'" + phone, d.consent ? 'כן' : 'לא', registered, new Date(), clean(d.device, 20)];

    const n = sh.getLastRow() - 1;
    const ids = n > 0 ? sh.getRange(2, 1, n, 1).getValues().map(r => String(r[0])) : [];
    const i = ids.indexOf(id);
    if (i >= 0) sh.getRange(i + 2, 1, 1, row.length).setValues([row]);
    else sh.appendRow(row);
    return json({ ok: true });
  } finally {
    lock.releaseLock();
  }
}

function json(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
