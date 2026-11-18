package com.billboard.app;

import android.content.Context;
import android.content.pm.PackageInfo;

import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.net.URLConnection;
import java.net.URLStreamHandler;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import javax.net.ssl.HttpsURLConnection;

/** Replaces native HTTPS responses only inside instrumentation; TLS policy is unchanged in the APK. */
final class UpdateNetworkFixture {
    static volatile int status = 200;
    static volatile JSONObject manifest;
    static volatile File apk;
    static volatile CountDownLatch blockCheck;
    static final AtomicInteger checks = new AtomicInteger();
    static final AtomicInteger downloads = new AtomicInteger();
    static volatile String cookie;
    private static boolean installed;

    static synchronized void install() {
        if (installed) return;
        URL.setURLStreamHandlerFactory(protocol -> !protocol.equals("https") ? null : new URLStreamHandler() {
            @Override protected URLConnection openConnection(URL url) throws IOException {
                if (!url.getHost().equals("billboard.example")) throw new IOException("Synthetic host required");
                if (!url.getPath().matches("/api/android/update(?:/[0-9a-f]{64})?")) throw new IOException("Unexpected endpoint");
                return new Response(url);
            }
        });
        installed = true;
    }

    static void select(Context testContext, Context appContext, String asset) throws Exception {
        File selected = new File(appContext.getCacheDir(), asset);
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream input = testContext.getAssets().open(asset); FileOutputStream output = new FileOutputStream(selected)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) { output.write(buffer, 0, count); hash.update(buffer, 0, count); }
        }
        PackageInfo archive = appContext.getPackageManager().getPackageArchiveInfo(selected.getAbsolutePath(), 0);
        manifest = new JSONObject().put("versionName", archive.versionName).put("versionCode", archive.getLongVersionCode())
                .put("size", selected.length()).put("sha256", UpdateTransfer.hex(hash.digest()))
                .put("minSdk", archive.applicationInfo.minSdkVersion)
                .put("notes", new JSONObject().put("zh-CN", "Synthetic release").put("en-US", "Synthetic release"));
        apk = selected;
        status = 200;
        blockCheck = null;
        checks.set(0);
        downloads.set(0);
        cookie = null;
    }

    private static final class Response extends HttpsURLConnection {
        private final boolean checking;
        Response(URL url) { super(url); checking = url.getPath().equals("/api/android/update"); }
        @Override public int getResponseCode() throws IOException {
            if (getInstanceFollowRedirects()) throw new IOException("Redirects must be disabled");
            cookie = getRequestProperty("Cookie");
            if (checking) {
                checks.incrementAndGet();
                CountDownLatch gate = blockCheck;
                if (gate != null) try {
                    if (!gate.await(10, TimeUnit.SECONDS)) throw new IOException("Fixture timeout");
                } catch (InterruptedException exception) { Thread.currentThread().interrupt(); throw new IOException(exception); }
            } else downloads.incrementAndGet();
            return status;
        }
        @Override public long getContentLengthLong() { return checking ? -1 : apk.length(); }
        @Override public InputStream getInputStream() throws IOException {
            return checking ? new ByteArrayInputStream(manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8))
                    : new FileInputStream(apk);
        }
        @Override public void disconnect() {}
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
        @Override public String getCipherSuite() { return "synthetic"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return null; }
    }
}
