package com.billboard.app;

import org.json.JSONObject;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.cert.Certificate;
import java.util.ArrayList;
import java.util.List;

import javax.net.ssl.HttpsURLConnection;

import static org.junit.Assert.*;

public class UpdateTransferTest {
    @Rule public TemporaryFolder directory = new TemporaryFolder();

    @Test public void usesOnlyFixedHttpsEndpointsAndNeverForwardsRedirects() throws Exception {
        Response response = new Response(302, "redirect");
        UpdateTransfer transfer = transfer(response);
        UpdateFailure failure = assertThrows(UpdateFailure.class, () -> transfer.check("session=synthetic"));
        assertEquals("unavailable", failure.code);
        assertEquals("https://billboard.example/api/android/update", response.getURL().toString());
        assertFalse(response.getInstanceFollowRedirects());
        assertFalse(response.getUseCaches());
        assertEquals("session=synthetic", response.getRequestProperty("Cookie"));
        assertFalse(response.bodyRead);
        assertTrue(response.disconnected);
    }

    @Test public void distinguishesAuthenticationFromUnpublishedAndBoundsManifest() throws Exception {
        assertEquals("auth", assertThrows(UpdateFailure.class, () -> transfer(new Response(401, "")).check(null)).code);
        assertNull(transfer(new Response(404, "")).check(null));
        Response oversized = new Response(200, "x".repeat(UpdateRelease.MAX_MANIFEST_BYTES + 1));
        assertEquals("invalid", assertThrows(UpdateFailure.class, () -> transfer(oversized).check(null)).code);
        Response chunked = new Response(200, "x".repeat(UpdateRelease.MAX_MANIFEST_BYTES + 1));
        chunked.declared = -1;
        assertEquals("invalid", assertThrows(UpdateFailure.class, () -> transfer(chunked).check(null)).code);
    }

    @Test public void downloadsExactBytesAndRechecksLaterMutation() throws Exception {
        byte[] content = "synthetic APK payload".getBytes(StandardCharsets.UTF_8);
        UpdateRelease release = release(content);
        Response response = new Response(200, content);
        File file = new File(directory.getRoot(), "update.apk");
        List<Integer> progress = new ArrayList<>();
        transfer(response).download(release, "session=synthetic", file, progress::add);
        assertArrayEquals(content, Files.readAllBytes(file.toPath()));
        assertEquals(Integer.valueOf(100), progress.get(progress.size() - 1));
        assertEquals("/api/android/update/" + release.sha256, response.getURL().getPath());
        UpdateTransfer.verifyBytes(file, release);
        content[0] ^= 1;
        Files.write(file.toPath(), content);
        assertEquals("invalid", assertThrows(UpdateFailure.class, () -> UpdateTransfer.verifyBytes(file, release)).code);
    }

    @Test public void deletesPartialFilesForTruncationOversizeDigestAndAuthorizationFailures() throws Exception {
        byte[] content = "expected APK payload".getBytes(StandardCharsets.UTF_8);
        UpdateRelease release = release(content);
        for (Response response : new Response[] {new Response(200, "short"), new Response(200, "much longer than expected APK payload"),
                new Response(200, "corruptd APK payload"), new Response(401, ""), new Response(307, "")}) {
            response.declared = -1;
            File file = new File(directory.getRoot(), "update.apk");
            assertThrows(UpdateFailure.class, () -> transfer(response).download(release, null, file, percent -> {}));
            assertFalse(file.exists());
        }
    }

    @Test public void cancellationStopsReadsAndDeletesPartialFile() throws Exception {
        byte[] content = new byte[100000];
        UpdateRelease release = release(content);
        Response response = new Response(200, content);
        UpdateTransfer transfer = transfer(response);
        File file = new File(directory.getRoot(), "update.apk");
        UpdateFailure failure = assertThrows(UpdateFailure.class,
                () -> transfer.download(release, null, file, percent -> transfer.cancel()));
        assertEquals("cancelled", failure.code);
        assertFalse(file.exists());
        assertTrue(response.disconnected);
    }

    private static UpdateRelease release(byte[] bytes) throws Exception {
        JSONObject manifest = UpdateReleaseTest.manifest().put("size", bytes.length)
                .put("sha256", UpdateTransfer.hex(MessageDigest.getInstance("SHA-256").digest(bytes)));
        return UpdateRelease.parse(manifest.toString());
    }

    private static UpdateTransfer transfer(Response response) {
        return new UpdateTransfer("https://billboard.example", url -> { response.requestUrl = url; return response; });
    }

    private static final class Response extends HttpsURLConnection {
        final int status;
        final byte[] content;
        long declared;
        URL requestUrl;
        boolean disconnected;
        boolean bodyRead;
        Response(int status, String content) throws Exception { this(status, content.getBytes(StandardCharsets.UTF_8)); }
        Response(int status, byte[] content) throws Exception {
            super(new URL("https://billboard.example"));
            this.status = status; this.content = content; declared = content.length;
        }
        @Override public URL getURL() { return requestUrl; }
        @Override public int getResponseCode() { return status; }
        @Override public long getContentLengthLong() { return declared; }
        @Override public InputStream getInputStream() throws IOException { bodyRead = true; return new ByteArrayInputStream(content); }
        @Override public void disconnect() { disconnected = true; }
        @Override public boolean usingProxy() { return false; }
        @Override public void connect() {}
        @Override public String getCipherSuite() { return "synthetic"; }
        @Override public Certificate[] getLocalCertificates() { return null; }
        @Override public Certificate[] getServerCertificates() { return null; }
    }
}
