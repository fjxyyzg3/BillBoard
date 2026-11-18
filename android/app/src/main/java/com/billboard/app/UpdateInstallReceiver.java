package com.billboard.app;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;

import java.lang.ref.WeakReference;

/** Explicit, non-exported receiver. A per-session data URI binds the mutable callback. */
public final class UpdateInstallReceiver extends BroadcastReceiver {
    private static WeakReference<AndroidUpdater> listener = new WeakReference<>(null);
    private static final String PREFERENCES = "apk_install_session";

    static void listen(AndroidUpdater updater) { listener = new WeakReference<>(updater); }
    static void detach(AndroidUpdater updater) {
        if (listener.get() == updater) listener.clear();
    }

    @android.annotation.SuppressLint("ApplySharedPref")
    static PendingIntent callback(Context context, int sessionId, String nonce) {
        // This binding must reach disk before the system can deliver a callback to a new process.
        if (!preferences(context).edit().putInt("session", sessionId).putString("nonce", nonce).commit())
            throw new IllegalStateException("Installation callback could not be bound");
        return PendingIntent.getBroadcast(context, sessionId, intent(context, nonce),
                PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0));
    }

    static void clear(Context context) {
        SharedPreferences preferences = preferences(context);
        int id = preferences.getInt("session", -1);
        String nonce = preferences.getString("nonce", null);
        preferences.edit().clear().apply();
        if (nonce != null) {
            PendingIntent pending = PendingIntent.getBroadcast(context, id, intent(context, nonce),
                    PendingIntent.FLAG_NO_CREATE | (Build.VERSION.SDK_INT >= 31 ? PendingIntent.FLAG_MUTABLE : 0));
            if (pending != null) pending.cancel();
        }
    }

    static void abandon(Context context, int id) {
        if (id < 0) return;
        try { context.getPackageManager().getPackageInstaller().abandonSession(id); }
        catch (IllegalArgumentException | SecurityException ignored) { /* Already completed or removed. */ }
    }

    private static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE);
    }

    private static Intent intent(Context context, String nonce) {
        return new Intent(context, UpdateInstallReceiver.class)
                .setAction(context.getPackageName() + ".UPDATE_RESULT")
                .setData(Uri.parse("billboard-update://result/" + nonce));
    }

    @Override public void onReceive(Context context, Intent intent) {
        SharedPreferences preferences = preferences(context);
        String nonce = preferences.getString("nonce", null);
        int expected = preferences.getInt("session", -1);
        if (nonce == null || expected < 0 || intent == null
                || !intent(context, nonce).getData().equals(intent.getData())
                || !(context.getPackageName() + ".UPDATE_RESULT").equals(intent.getAction())
                || intent.getIntExtra(PackageInstaller.EXTRA_SESSION_ID, -1) != expected) return;
        AndroidUpdater updater = listener.get();
        if (updater != null) updater.installResult(expected, intent);
        else {
            // Process death never grants permission to open an installation screen later.
            abandon(context, expected);
            clear(context);
        }
    }
}
