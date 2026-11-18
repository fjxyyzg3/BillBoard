package com.billboard.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

import javax.net.ssl.HttpsURLConnection;

/** One cancellable operation. Connections never follow redirects or accept a caller-supplied URL. */
final class UpdateTransfer {
    interface Connections { HttpsURLConnection open(URL url) throws IOException; }
    interface Progress { void changed(int percent); }
    private final String origin;
    private final Connections connections;
    private volatile boolean cancelled;
    private volatile HttpsURLConnection active;

    UpdateTransfer(String origin) {
        this(origin, url -> (HttpsURLConnection) url.openConnection());
    }

    UpdateTransfer(String origin, Connections connections) {
        new OriginPolicy(origin);
        this.origin = origin.endsWith("/") ? origin.substring(0, origin.length() - 1) : origin;
        this.connections = connections;
    }

    void cancel() {
        cancelled = true;
        HttpsURLConnection connection = active;
        if (connection != null) connection.disconnect();
    }

    void requireActive() throws UpdateFailure {
        if (cancelled || Thread.currentThread().isInterrupted()) throw new UpdateFailure("cancelled");
    }

    UpdateRelease check(String cookie) throws IOException {
        HttpsURLConnection connection = connect("/api/android/update", cookie);
        try {
            int status = connection.getResponseCode();
            if (status == 404) return null;
            requireStatus(status);
            if (connection.getContentLengthLong() > UpdateRelease.MAX_MANIFEST_BYTES) throw new UpdateFailure("invalid");
            ByteArrayOutputStream bytes = new ByteArrayOutputStream();
            try (InputStream input = connection.getInputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    requireActive();
                    if (bytes.size() + count > UpdateRelease.MAX_MANIFEST_BYTES) throw new UpdateFailure("invalid");
                    bytes.write(buffer, 0, count);
                }
            }
            requireActive();
            try { return UpdateRelease.parse(bytes.toString(StandardCharsets.UTF_8.name())); }
            catch (org.json.JSONException exception) { throw new UpdateFailure("invalid"); }
        } finally { connection.disconnect(); active = null; }
    }

    void download(UpdateRelease release, String cookie, File destination, Progress progress) throws IOException {
        HttpsURLConnection connection = connect("/api/android/update/" + release.sha256, cookie);
        boolean complete = false;
        try {
            requireStatus(connection.getResponseCode());
            long declared = connection.getContentLengthLong();
            if (declared != -1 && declared != release.size) throw new UpdateFailure("invalid");
            MessageDigest digest = digest();
            long total = 0;
            int previous = -1;
            try (InputStream input = connection.getInputStream(); FileOutputStream output = new FileOutputStream(destination)) {
                byte[] buffer = new byte[32768];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    requireActive();
                    total += count;
                    if (total > release.size || total > UpdateRelease.MAX_APK_BYTES) throw new UpdateFailure("invalid");
                    digest.update(buffer, 0, count);
                    output.write(buffer, 0, count);
                    int percent = (int) (total * 100 / release.size);
                    if (percent != previous) { previous = percent; progress.changed(percent); }
                }
                output.getFD().sync();
            }
            requireActive();
            if (total != release.size || !hex(digest.digest()).equals(release.sha256)) throw new UpdateFailure("invalid");
            complete = true;
        } finally {
            connection.disconnect(); active = null;
            if (!complete) destination.delete();
        }
    }

    private HttpsURLConnection connect(String path, String cookie) throws IOException {
        requireActive();
        HttpsURLConnection connection = connections.open(new URL(origin + path));
        active = connection;
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(30000);
        connection.setUseCaches(false);
        connection.setRequestProperty("Accept-Encoding", "identity");
        connection.setRequestProperty("Cache-Control", "no-store");
        if (cookie != null && !cookie.isEmpty()) connection.setRequestProperty("Cookie", cookie);
        requireActive();
        return connection;
    }

    private static void requireStatus(int status) throws UpdateFailure {
        if (status == 401) throw new UpdateFailure("auth");
        if (status != 200) throw new UpdateFailure("unavailable");
    }

    static void verifyBytes(File file, UpdateRelease release) throws IOException {
        if (!file.isFile() || file.length() != release.size) throw new UpdateFailure("invalid");
        MessageDigest digest = digest();
        try (InputStream input = new FileInputStream(file)) {
            byte[] buffer = new byte[32768];
            int count;
            while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count);
        }
        if (!hex(digest.digest()).equals(release.sha256)) throw new UpdateFailure("invalid");
    }

    private static MessageDigest digest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException exception) { throw new IllegalStateException(exception); }
    }

    static String hex(byte[] bytes) {
        StringBuilder value = new StringBuilder(bytes.length * 2);
        for (byte element : bytes) value.append(String.format(java.util.Locale.ROOT, "%02x", element & 255));
        return value.toString();
    }
}
