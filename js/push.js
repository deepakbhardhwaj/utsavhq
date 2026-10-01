/* ============================================================================
   🔔 BACKGROUND PUSH (Web Push / VAPID)
   ----------------------------------------------------------------------------
   Subscribes this device so reminders arrive EVEN WHEN THE APP IS CLOSED.

   How it works:
     1. The browser gives us a push subscription (endpoint + keys).
     2. We save it in Firestore -> collection "push_subscriptions".
     3. A scheduled job (see push/send-reminders.js + the GitHub Action)
        reads the workspaces, works out today's reminders, and pushes them.
     4. The service worker (sw.js) shows the notification and opens the app
        when it is tapped.

   The VAPID public key below is safe to ship in the app. Its private partner
   lives ONLY as a GitHub secret and is never part of this repo.
   ========================================================================== */
(function () {
    'use strict';

    var VAPID_PUBLIC = 'BBv2EwIbSzys7G3eppCkiQDSDAyoCDWeHo6Qwkkutvi-PNaUdTKLFmK6Ny4AuxG3aEcQjRgVpX50NjJKAXK_THg';

    function b64ToBytes(b64) {
        var pad = '='.repeat((4 - (b64.length % 4)) % 4);
        var s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
        var raw = atob(s), out = new Uint8Array(raw.length);
        for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
        return out;
    }
    function supported() {
        return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
    }
    // stable, Firestore-safe document id for a subscription
    function docId(endpoint) {
        var h = 5381;
        for (var i = 0; i < endpoint.length; i++) h = ((h << 5) + h + endpoint.charCodeAt(i)) | 0;
        return 'sub_' + Math.abs(h).toString(36) + '_' + endpoint.length;
    }
    function currentEmail() {
        try { return (typeof loggedInEmail !== 'undefined' && loggedInEmail) ? loggedInEmail : ''; } catch (e) { return ''; }
    }
    function currentWs() {
        try { return (typeof currentWorkspaceId !== 'undefined' && currentWorkspaceId) ? currentWorkspaceId : ''; } catch (e) { return ''; }
    }

    function saveSubscription(sub) {
        var j = (sub && sub.toJSON) ? sub.toJSON() : sub;
        if (!j || !j.endpoint) return Promise.resolve(false);
        var rec = {
            endpoint: j.endpoint,
            keys: j.keys || {},
            email: currentEmail(),
            workspace: currentWs(),
            ua: String(navigator.userAgent || '').slice(0, 200),
            platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '',
            updatedAt: new Date().toISOString()
        };
        if (!window.db) return Promise.resolve(false);
        return window.db.collection('push_subscriptions').doc(docId(j.endpoint))
            .set(rec, { merge: true })
            .then(function () { return true; })
            .catch(function (e) {
                console.warn('Push subscription could not be saved:', e && e.message);
                return false;
            });
    }

    // Public entry point — also wired to the app's own "Enable notifications".
    window.utsavEnablePush = function (silent) {
        if (!supported()) {
            if (!silent && window.showToast) showToast('This browser does not support background reminders.', 'info');
            return Promise.resolve(false);
        }
        var ask = (Notification.permission === 'granted') ? Promise.resolve('granted') : Notification.requestPermission();
        return ask.then(function (perm) {
            if (perm !== 'granted') {
                if (!silent && window.showToast) showToast('Notifications are blocked — allow them in your browser settings.', 'error');
                return false;
            }
            return navigator.serviceWorker.ready.then(function (reg) {
                return reg.pushManager.getSubscription().then(function (existing) {
                    if (existing) return existing;
                    return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(VAPID_PUBLIC) });
                }).then(function (sub) {
                    return saveSubscription(sub).then(function (ok) {
                        if (!silent && window.showToast) {
                            showToast(ok ? 'Reminders will now arrive even when the app is closed.' : 'Could not save the subscription — check your connection.',
                                ok ? 'success' : 'error');
                        }
                        return ok;
                    });
                });
            });
        }).catch(function (e) {
            console.warn('Background push could not be enabled:', e && e.message);
            if (!silent && window.showToast) showToast('Could not enable background reminders on this device.', 'error');
            return false;
        });
    };

    // The service worker re-subscribes when the browser rotates the endpoint.
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', function (event) {
            var d = event.data || {};
            if (d.type === 'push-subscription-changed' && d.subscription) saveSubscription(d.subscription);
        });
    }

    // Wrap the app's existing "Enable notifications" button so it also subscribes.
    function hook() {
        if (typeof window.enableLocalNotifications === 'function' && !window.enableLocalNotifications.__pushWrapped) {
            var orig = window.enableLocalNotifications;
            var wrapped = function () {
                try { orig.apply(this, arguments); } catch (e) {}
                return window.utsavEnablePush();
            };
            wrapped.__pushWrapped = true;
            window.enableLocalNotifications = wrapped;
        }
    }

    // Returning devices that already granted permission: subscribe quietly.
    function autoSubscribe() {
        try {
            if (!supported() || Notification.permission !== 'granted') return;
            if (!currentEmail()) return;
            window.utsavEnablePush(true);
        } catch (e) {}
    }

    window.addEventListener('load', function () {
        hook();
        var tries = 0;
        var t = setInterval(function () {
            tries++; hook();
            if (tries > 30) clearInterval(t);
        }, 1000);
        setTimeout(autoSubscribe, 7000);
        setTimeout(autoSubscribe, 20000);
    });
})();
