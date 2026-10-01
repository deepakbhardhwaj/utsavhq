/* ============================================================================
   🔔 UTSAVhq PUSH REMINDERS — sender
   ----------------------------------------------------------------------------
   Runs on a schedule (see .github/workflows/push-reminders.yml). It reads every
   workspace from Firestore, works out what is due today/tomorrow in IST, and
   pushes a notification to every subscribed device — the app does NOT need to
   be open.

   Secrets it needs (GitHub repo -> Settings -> Secrets and variables -> Actions):
     FIREBASE_SERVICE_ACCOUNT  the service-account JSON (one line / raw JSON)
     VAPID_PUBLIC_KEY          from the VAPID key pair
     VAPID_PRIVATE_KEY         from the VAPID key pair  (NEVER commit this)
     VAPID_SUBJECT             mailto:utsavhq@gmail.com

   Nothing here is destructive: it only reads workspaces and sends notifications.
   ========================================================================== */

'use strict';

/* ------------------------------------------------------------------ helpers */
// Current date in India (UTC+5:30) as YYYY-MM-DD
function istDate(offsetDays) {
    const now = Date.now() + (5.5 * 60 * 60 * 1000) + ((offsetDays || 0) * 24 * 60 * 60 * 1000);
    return new Date(now).toISOString().slice(0, 10);
}

function isPending(task) {
    const s = String((task && task.status) || 'Pending').toLowerCase().trim();
    if (!s) return true;                                                    // no status = still open
    if (s.indexOf('done') !== -1 || s.indexOf('complete') !== -1) return false;
    return s.indexOf('pending') !== -1 || s === 'todo' || s === 'open';
}

/* ------------------------------------------------- work out what to remind about
   Pure function — no network, so it is unit-tested in the sandbox.
   wsData = the object stored at Firestore -> workspace_data/{id}
   today / tomorrow = 'YYYY-MM-DD' in IST
   Returns [{ title, body, tag }]
--------------------------------------------------------------------------- */
function computeReminders(wsData, today, tomorrow) {
    const out = [];
    const data = wsData || {};

    /* ---- events happening tomorrow ---- */
    const events = [];
    Object.values(data.leads || {}).forEach((l) => {
        if (!l) return;
        const dates = (l.dates && l.dates.length) ? l.dates : (l.events || []);
        dates.forEach((d) => {
            if (d && d.date === tomorrow) {
                events.push({
                    client: l.name || 'Client',
                    func: d.name || l.func || 'Event',
                    venue: d.venue || '',
                    time: d.time || ''
                });
            }
        });
    });
    if (events.length === 1) {
        const e = events[0];
        out.push({
            tag: 'event-tomorrow',
            title: '📅 Event tomorrow: ' + e.client,
            body: [e.func, e.time, e.venue].filter(Boolean).join(' · ')
        });
    } else if (events.length > 1) {
        out.push({
            tag: 'event-tomorrow',
            title: '📅 ' + events.length + ' events tomorrow',
            body: events.slice(0, 3).map((e) => e.client).join(', ') + (events.length > 3 ? ' +' + (events.length - 3) + ' more' : '')
        });
    }

    /* ---- tasks due today or already overdue ---- */
    const due = Object.values(data.globalTasks || {}).filter((t) =>
        t && isPending(t) && t.due && String(t.due).slice(0, 10) <= today
    );
    if (due.length === 1) {
        out.push({ tag: 'task-due', title: '✅ Task due: ' + (due[0].title || 'Task'), body: 'Due ' + String(due[0].due).slice(0, 10) });
    } else if (due.length > 1) {
        out.push({
            tag: 'task-due',
            title: '✅ ' + due.length + ' tasks due',
            body: due.slice(0, 3).map((t) => t.title || 'Task').join(', ') + (due.length > 3 ? ' +' + (due.length - 3) + ' more' : '')
        });
    }

    /* ---- money still to collect ---- */
    const unpaid = Object.values(data.sales || {}).filter((s) => s && s.type === 'Invoice' && Number(s.balanceDue) > 0);
    if (unpaid.length) {
        const total = unpaid.reduce((sum, s) => sum + Number(s.balanceDue || 0), 0);
        out.push({
            tag: 'dues',
            title: '💰 ₹' + Math.round(total).toLocaleString('en-IN') + ' still to collect',
            body: unpaid.length + (unpaid.length === 1 ? ' invoice pending' : ' invoices pending')
        });
    }

    return out;
}

/* ---------------------------------------------------------------- the sender */
async function main() {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:utsavhq@gmail.com';

    if (!raw || !publicKey || !privateKey) {
        console.error('Missing FIREBASE_SERVICE_ACCOUNT / VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY.');
        process.exit(1);
    }

    const webpush = require('web-push');
    const admin = require('firebase-admin');

    webpush.setVapidDetails(subject, publicKey, privateKey);
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
    const db = admin.firestore();

    const today = istDate(0);
    const tomorrow = istDate(1);
    console.log('Reminders for IST date', today, '(events tomorrow =', tomorrow + ')');

    const [wsSnap, subSnap] = await Promise.all([
        db.collection('workspace_data').get(),
        db.collection('push_subscriptions').get()
    ]);

    // workspace id -> subscriptions
    const byWorkspace = {};
    subSnap.forEach((doc) => {
        const s = doc.data() || {};
        const ws = s.workspace || '';
        if (!s.endpoint || !s.keys) return;
        (byWorkspace[ws] = byWorkspace[ws] || []).push({ id: doc.id, endpoint: s.endpoint, keys: s.keys });
    });

    let sent = 0, failed = 0, removed = 0;

    for (const wsDoc of wsSnap.docs) {
        const reminders = computeReminders(wsDoc.data(), today, tomorrow);
        if (!reminders.length) continue;
        const subs = byWorkspace[wsDoc.id] || [];
        if (!subs.length) continue;

        for (const r of reminders) {
            const payload = JSON.stringify({ title: r.title, body: r.body, tag: r.tag });
            for (const sub of subs) {
                try {
                    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, { TTL: 12 * 60 * 60 });
                    sent++;
                } catch (err) {
                    failed++;
                    // 404/410 -> the device is gone, clean the record up
                    if (err && (err.statusCode === 404 || err.statusCode === 410)) {
                        try { await db.collection('push_subscriptions').doc(sub.id).delete(); removed++; } catch (e) {}
                    } else {
                        console.warn('push failed for', sub.id, err && err.statusCode, err && err.body);
                    }
                }
            }
        }
    }

    console.log('Done. sent=' + sent + ' failed=' + failed + ' stale-removed=' + removed);
}

if (require.main === module) {
    main().catch((e) => { console.error('Reminder run failed:', e); process.exit(1); });
}

module.exports = { computeReminders, istDate };
