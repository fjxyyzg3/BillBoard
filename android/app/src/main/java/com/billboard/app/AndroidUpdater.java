package com.billboard.app;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.Collections;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Activity-scoped updater. Only network/file work runs off the UI thread. */
final class AndroidUpdater {
    private final Activity activity;
    private final OriginPolicy policy = new OriginPolicy(BuildConfig.APP_ORIGIN);
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final File directory;
    private String installedVersion;
    private long installedVersionCode;
    private WebView web;
    private JavaScriptReplyProxy reply;
    private boolean foreground;
    private boolean closed;
    private long generation;
    private String status = "idle";
    private String error;
    private int progress;
    private UpdateRelease release;
    private UpdateTransfer transfer;
    private File apk;
    private int sessionId = -1;
    private boolean confirmationLaunched;
    private boolean waitingForPermission;

    AndroidUpdater(Activity activity) {
        this.activity = activity;
        PackageInfo installed = UpdateApkVerifier.installed(activity);
        installedVersion = installed.versionName;
        installedVersionCode = installed.getLongVersionCode();
        directory = new File(activity.getCacheDir(), "apk-update");
        UpdateInstallReceiver.listen(this);
        // Only this updater creates installation sessions for this application.
        worker.execute(() -> {
            for (PackageInstaller.SessionInfo session : activity.getPackageManager().getPackageInstaller().getMySessions()) {
                UpdateInstallReceiver.abandon(activity, session.getSessionId());
            }
            UpdateInstallReceiver.clear(activity);
            File[] files = directory.listFiles();
            if (files != null) for (File file : files) file.delete();
        });
    }

    void attach(WebView view) {
        web = view;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(view, "BillBoardUpdater", Collections.singleton(BuildConfig.APP_ORIGIN),
                (source, message, origin, mainFrame, proxy) -> {
                    if (closed || !mainFrame || source != web || !policy.isTrusted(origin.toString())
                            || !policy.isTrusted(source.getUrl())) return;
                    reply = proxy;
                    try { command(UpdateRelease.command(message.getData())); }
                    catch (JSONException | IllegalStateException exception) { send("invalid"); }
                });
    }

    void pageChanged(String url) {
        reply = null;
        historyChanged(url);
    }

    void historyChanged(String url) {
        if (!policy.isTrusted(url)) reset("cancelled");
        else if ("/login".equals(Uri.parse(url).getPath())) reset("auth");
        else if ("installing".equals(status) && !confirmationLaunched) reset("cancelled");
    }

    void detachPage() { reset("cancelled"); reply = null; web = null; }

    void resume() {
        foreground = true;
        if (waitingForPermission) {
            waitingForPermission = false;
            setState(activity.getPackageManager().canRequestPackageInstalls() ? "ready" : "permission", null);
        }
    }

    void pause() {
        foreground = false;
        if ("installing".equals(status) && !confirmationLaunched) {
            cancelOperation();
            setState(apk != null ? "ready" : "available", "cancelled");
        }
    }

    void close() {
        closed = true;
        reply = null;
        web = null;
        cancelOperation();
        deleteApk();
        UpdateInstallReceiver.detach(this);
        worker.shutdown();
    }

    private boolean mayInteract() {
        return !closed && foreground && web != null && policy.isTrusted(web.getUrl())
                && web.getVisibility() == View.VISIBLE
                && !"/login".equals(Uri.parse(web.getUrl()).getPath());
    }

    private void command(String command) {
        if (command.equals("status")) { send(null); return; }
        if (command.equals("cancel")) { reset("cancelled"); return; }
        if (!mayInteract()) { send("busy"); return; }
        if (status.equals("checking") || status.equals("downloading") || status.equals("installing")) { send("busy"); return; }
        switch (command) {
            case "check": check(); break;
            case "download": download(); break;
            case "install": install(); break;
            default: send("invalid");
        }
    }

    private String cookie() { return CookieManager.getInstance().getCookie(BuildConfig.APP_ORIGIN + "/api/android/update"); }

    private void check() {
        cancelOperation();
        progress = 0;
        long operation = generation;
        UpdateTransfer request = new UpdateTransfer(BuildConfig.APP_ORIGIN);
        transfer = request;
        String cookie = cookie();
        setState("checking", null);
        worker.execute(() -> {
            try {
                UpdateRelease found = request.check(cookie);
                main.post(() -> {
                    if (!current(operation)) return;
                    transfer = null;
                    if (found == null) { deleteApk(); release = null; setState("error", "unavailable"); return; }
                    if (release == null || !release.sha256.equals(found.sha256)) deleteApk();
                    release = found;
                    if (found.versionCode <= installedVersionCode) { deleteApk(); setState("idle", null); return; }
                    if (found.minSdk > Build.VERSION.SDK_INT) { setState("error", "invalid"); return; }
                    setState(apk == null ? "available" : "ready", null);
                });
            } catch (IOException exception) { failure(operation, exception, "offline"); }
        });
    }

    private void download() {
        if (release == null) { send("unavailable"); return; }
        cancelOperation();
        deleteApk();
        progress = 0;
        long operation = generation;
        UpdateRelease selected = release;
        UpdateTransfer request = new UpdateTransfer(BuildConfig.APP_ORIGIN);
        transfer = request;
        String cookie = cookie();
        File target = new File(directory, UUID.randomUUID() + ".apk");
        setState("downloading", null);
        worker.execute(() -> {
            try {
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException();
                request.download(selected, cookie, target, percent -> main.post(() -> {
                    if (current(operation)) { progress = percent; send(null); }
                }));
                UpdateApkVerifier.verify(activity, target, selected);
                request.requireActive();
                main.post(() -> {
                    if (!current(operation)) { target.delete(); return; }
                    transfer = null;
                    apk = target;
                    setState("ready", null);
                });
            } catch (IOException exception) {
                target.delete();
                failure(operation, exception, "download");
            }
        });
    }

    private void install() {
        if (apk == null || release == null) { send("unavailable"); return; }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            waitingForPermission = true;
            setState("permission", null);
            try {
                activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + activity.getPackageName())));
            } catch (ActivityNotFoundException | SecurityException exception) {
                waitingForPermission = false;
                setState("error", "permission");
            }
            return;
        }
        cancelOperation();
        long operation = generation;
        File selectedFile = apk;
        UpdateRelease selected = release;
        UpdateTransfer request = new UpdateTransfer(BuildConfig.APP_ORIGIN);
        transfer = request;
        String cookie = cookie();
        setState("installing", null);
        worker.execute(() -> {
            int created = -1;
            try {
                // Revalidate authentication and publication before using an earlier download.
                UpdateRelease published = request.check(cookie);
                if (published == null || !published.sha256.equals(selected.sha256)) throw new UpdateFailure("unavailable");
                UpdateApkVerifier.verify(activity, selectedFile, selected);
                request.requireActive();
                PackageInstaller installer = activity.getPackageManager().getPackageInstaller();
                PackageInstaller.SessionParams params = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                params.setAppPackageName(activity.getPackageName());
                params.setSize(selected.size);
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
                created = installer.createSession(params);
                try (PackageInstaller.Session session = installer.openSession(created);
                     FileInputStream input = new FileInputStream(selectedFile);
                     OutputStream output = session.openWrite("base.apk", 0, selected.size)) {
                    byte[] buffer = new byte[32768];
                    java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
                    long total = 0;
                    int count;
                    while ((count = input.read(buffer)) != -1) {
                        request.requireActive();
                        total += count;
                        if (total > selected.size) throw new UpdateFailure("invalid");
                        digest.update(buffer, 0, count);
                        output.write(buffer, 0, count);
                    }
                    if (total != selected.size || !UpdateTransfer.hex(digest.digest()).equals(selected.sha256))
                        throw new UpdateFailure("invalid");
                    session.fsync(output);
                }
                request.requireActive();
                final int readySession = created;
                main.post(() -> commit(operation, readySession));
            } catch (IOException | RuntimeException | java.security.NoSuchAlgorithmException exception) {
                UpdateInstallReceiver.abandon(activity, created);
                failure(operation, exception, "install");
            }
        });
    }

    private void commit(long operation, int prepared) {
        if (!current(operation) || !mayInteract()) { UpdateInstallReceiver.abandon(activity, prepared); return; }
        if (!activity.getPackageManager().canRequestPackageInstalls()) {
            UpdateInstallReceiver.abandon(activity, prepared);
            setState("permission", "permission");
            return;
        }
        sessionId = prepared;
        try (PackageInstaller.Session session = activity.getPackageManager().getPackageInstaller().openSession(prepared)) {
            PendingIntent callback = UpdateInstallReceiver.callback(activity, prepared, UUID.randomUUID().toString());
            session.commit(callback.getIntentSender());
        } catch (IOException | RuntimeException exception) {
            cancelOperation();
            setState("error", "install");
        }
    }

    @SuppressWarnings("deprecation")
    void installResult(int session, Intent result) {
        if (closed || session != sessionId || !status.equals("installing")) return;
        int resultCode = result.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
        if (resultCode == PackageInstaller.STATUS_PENDING_USER_ACTION) {
            Intent confirmation = result.getParcelableExtra(Intent.EXTRA_INTENT);
            if (!mayInteract() || confirmation == null || confirmationLaunched) {
                cancelOperation();
                setState("ready", "cancelled");
                return;
            }
            try {
                confirmationLaunched = true;
                activity.startActivity(confirmation);
            } catch (ActivityNotFoundException | SecurityException exception) {
                cancelOperation();
                setState("error", "install");
            }
        } else {
            cancelOperation();
            if (resultCode == PackageInstaller.STATUS_SUCCESS) {
                // Replacement normally restarts the process. Never report success from an intent alone.
                PackageInfo actual = UpdateApkVerifier.installed(activity);
                installedVersion = actual.versionName;
                installedVersionCode = actual.getLongVersionCode();
                boolean replaced = release != null && installedVersionCode >= release.versionCode;
                deleteApk();
                release = null;
                setState(replaced ? "idle" : "error", replaced ? null : "install");
            } else setState("error", resultCode == PackageInstaller.STATUS_FAILURE_ABORTED ? "cancelled" : "install");
        }
    }

    private boolean current(long operation) { return !closed && generation == operation; }

    private void failure(long operation, Exception exception, String fallback) {
        String code = exception instanceof UpdateFailure ? ((UpdateFailure) exception).code : fallback;
        main.post(() -> {
            if (!current(operation)) return;
            transfer = null;
            if (code.equals("auth")) { deleteApk(); release = null; }
            setState("error", code);
        });
    }

    private void cancelOperation() {
        generation++;
        if (transfer != null) { transfer.cancel(); transfer = null; }
        UpdateInstallReceiver.abandon(activity, sessionId);
        sessionId = -1;
        confirmationLaunched = false;
        UpdateInstallReceiver.clear(activity);
    }

    private void reset(String reason) {
        cancelOperation();
        deleteApk();
        if (reason.equals("auth")) release = null;
        progress = 0;
        waitingForPermission = false;
        setState(release != null && release.versionCode > installedVersionCode ? "available" : "idle", reason);
    }

    private void deleteApk() {
        if (apk != null) { apk.delete(); apk = null; }
    }

    private void setState(String value, String code) { status = value; error = code; send(null); }

    private void send(String requestError) {
        if (reply == null || closed) return;
        try {
            String message = new JSONObject().put("status", status).put("installedVersion", installedVersion)
                    .put("installedVersionCode", installedVersionCode).put("progress", progress)
                    .put("release", release == null ? JSONObject.NULL : release.json())
                    .put("error", requestError != null ? requestError : error == null ? JSONObject.NULL : error).toString();
            if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) reply.postMessage(message);
        } catch (JSONException | IllegalStateException ignored) { /* A navigating document cannot receive stale events. */ }
    }
}
