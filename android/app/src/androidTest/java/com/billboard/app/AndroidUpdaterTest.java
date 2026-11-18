package com.billboard.app;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.os.SystemClock;
import android.provider.Settings;
import android.view.accessibility.AccessibilityNodeInfo;
import android.webkit.CookieManager;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONObject;
import org.junit.Before;
import org.junit.BeforeClass;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;

import static com.billboard.app.MainActivityTest.*;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public class AndroidUpdaterTest {
    private static final String PAGE = "<script>window.events=[]; BillBoardUpdater.onmessage=e=>{window.update=JSON.parse(e.data);events.push(update);};"
            + "BillBoardUpdater.postMessage(JSON.stringify({command:'status'}));</script>";

    @BeforeClass public static void installNetworkBoundary() {
        assertEquals("https://billboard.example", BuildConfig.APP_ORIGIN);
        UpdateNetworkFixture.install();
    }

    @Before public void prepareFixture() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        UpdateNetworkFixture.select(instrumentation.getContext(), instrumentation.getTargetContext(), "valid-update.apk");
    }

    @Test public void bridgeRejectsSubframesOpaqueOriginsAndAdditionalParameters() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, PAGE, java.util.Collections.singletonMap("https://foreign.example/frame",
                    "<script>parent.postMessage('foreign-'+typeof BillBoardUpdater,'*');</script>"));
            awaitValue(scenario, "window.update?.status", "\"idle\"");
            evaluate(scenario, "BillBoardUpdater.postMessage(JSON.stringify({command:'check',url:'https://foreign.example/apk'}))");
            awaitValue(scenario, "window.update?.error", "\"invalid\"");
            assertEquals(0, UpdateNetworkFixture.checks.get());
            evaluate(scenario, "(()=>{let f=document.createElement('iframe');f.srcdoc=\"<script>parent.postMessage('same-'+typeof BillBoardUpdater,'*');BillBoardUpdater.postMessage('{\\\"command\\\":\\\"check\\\"}');<\\/script>\";window.addEventListener('message',e=>window.frameMessage=e.data);document.body.append(f);})()");
            awaitValue(scenario, "window.frameMessage", "\"same-object\"");
            assertEquals(0, UpdateNetworkFixture.checks.get());
            evaluate(scenario, "(()=>{let f=document.createElement('iframe');f.sandbox='allow-scripts';f.srcdoc=\"<script>parent.postMessage('opaque-'+typeof BillBoardUpdater,'*');<\\/script>\";document.body.append(f);})()");
            awaitValue(scenario, "window.frameMessage", "\"opaque-undefined\"");
            evaluate(scenario, "(()=>{let f=document.createElement('iframe');f.src='https://foreign.example/frame';document.body.append(f);})()");
            awaitValue(scenario, "window.frameMessage", "\"foreign-undefined\"");
            command(scenario, "check");
            awaitValue(scenario, "window.update.status", "\"available\"");
            assertEquals(1, UpdateNetworkFixture.checks.get());
        }
    }

    @Test public void knownReleaseSurvivesCancelAndNetworkFailureButNotUnauthorizedSession() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, PAGE);
            command(scenario, "check");
            awaitValue(scenario, "window.update.status", "\"available\"");
            command(scenario, "cancel");
            awaitValue(scenario, "window.update.error", "\"cancelled\"");
            assertEquals("true", evaluate(scenario, "!!window.update.release"));
            UpdateNetworkFixture.status = 503;
            command(scenario, "check");
            awaitValue(scenario, "window.update.error", "\"unavailable\"");
            assertEquals("true", evaluate(scenario, "!!window.update.release"));
            UpdateNetworkFixture.status = 401;
            command(scenario, "check");
            awaitValue(scenario, "window.update.error", "\"auth\"");
            assertEquals("null", evaluate(scenario, "window.update.release"));
        }
    }

    @Test public void currentVersionKeepsManifestAndUnpublishedDoesNotClaimLatest() throws Exception {
        UpdateNetworkFixture.manifest.put("versionCode", BuildConfig.VERSION_CODE);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, PAGE);
            command(scenario, "check");
            awaitValue(scenario, "window.update.status==='idle' && !!window.update.release", "true");
            UpdateNetworkFixture.status = 404;
            command(scenario, "check");
            awaitValue(scenario, "window.update.error", "\"unavailable\"");
            assertEquals("null", evaluate(scenario, "window.update.release"));
        }
    }

    @Test public void rejectsCorrectlyHashedApkWithUntrustedSigningKey() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        UpdateNetworkFixture.select(instrumentation.getContext(), instrumentation.getTargetContext(), "wrong-signer.apk");
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, PAGE);
            command(scenario, "check");
            awaitValue(scenario, "window.update.status", "\"available\"");
            command(scenario, "download");
            awaitValue(scenario, "window.update.error", "\"invalid\"");
            assertEquals("\"error\"", evaluate(scenario, "window.update.status"));
            assertTrue(instrumentation.getTargetContext().getPackageManager().getPackageInstaller().getMySessions().isEmpty());
        }
    }

    @Test public void verifierRejectsDowngradePackageMismatchAndModifiedSignedContent() throws Exception {
        android.content.Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        UpdateRelease valid = UpdateRelease.parse(UpdateNetworkFixture.manifest.toString());
        UpdateApkVerifier.verify(context, UpdateNetworkFixture.apk, valid);
        JSONObject wrongMinimum = new JSONObject(UpdateNetworkFixture.manifest.toString()).put("minSdk", 30);
        assertThrows(UpdateFailure.class, () -> UpdateApkVerifier.verify(context, UpdateNetworkFixture.apk, UpdateRelease.parse(wrongMinimum.toString())));
        java.io.File current = new java.io.File(context.getApplicationInfo().sourceDir);
        JSONObject older = description(context, current).put("versionCode", BuildConfig.VERSION_CODE);
        assertThrows(UpdateFailure.class, () -> UpdateApkVerifier.verify(context, current, UpdateRelease.parse(older.toString())));
        java.io.File otherPackage = new java.io.File(InstrumentationRegistry.getInstrumentation().getContext().getApplicationInfo().sourceDir);
        JSONObject other = description(context, otherPackage);
        assertThrows(UpdateFailure.class, () -> UpdateApkVerifier.verify(context, otherPackage, UpdateRelease.parse(other.toString())));
        try (java.io.RandomAccessFile file = new java.io.RandomAccessFile(UpdateNetworkFixture.apk, "rw")) {
            file.seek(10); int original = file.read(); file.seek(10); file.write(original ^ 1);
        }
        JSONObject modified = description(context, UpdateNetworkFixture.apk);
        assertThrows(UpdateFailure.class, () -> UpdateApkVerifier.verify(context, UpdateNetworkFixture.apk, UpdateRelease.parse(modified.toString())));
    }

    private static JSONObject description(android.content.Context context, java.io.File file) throws Exception {
        android.content.pm.PackageInfo archive = context.getPackageManager().getPackageArchiveInfo(file.getAbsolutePath(), 0);
        java.security.MessageDigest hash = java.security.MessageDigest.getInstance("SHA-256");
        try (java.io.InputStream input = new java.io.FileInputStream(file)) {
            byte[] buffer = new byte[32768]; int count;
            while ((count = input.read(buffer)) != -1) hash.update(buffer, 0, count);
        }
        return new JSONObject(UpdateNetworkFixture.manifest.toString())
                .put("versionName", archive.versionName == null ? "1.0.0" : archive.versionName)
                .put("versionCode", archive.getLongVersionCode() <= 0 ? 1 : archive.getLongVersionCode())
                .put("minSdk", archive.applicationInfo.minSdkVersion).put("size", file.length())
                .put("sha256", UpdateTransfer.hex(hash.digest()));
    }

    @Test public void downloadUsesWebViewCookieAndNeverStartsInstallationItself() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> CookieManager.getInstance().setCookie(BuildConfig.APP_ORIGIN,
                    "__Host-update-test=synthetic; Secure; HttpOnly; Path=/"));
            ready(scenario);
            assertTrue(UpdateNetworkFixture.cookie.contains("__Host-update-test=synthetic"));
            assertEquals(1, UpdateNetworkFixture.downloads.get());
            assertEquals("100", evaluate(scenario, "window.update.progress"));
            assertTrue(InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageManager().getPackageInstaller().getMySessions().isEmpty());
            command(scenario, "cancel");
            awaitValue(scenario, "window.update.status", "\"available\"");
            scenario.onActivity(activity -> CookieManager.getInstance().setCookie(BuildConfig.APP_ORIGIN,
                    "__Host-update-test=; Secure; HttpOnly; Path=/; Max-Age=0"));
        }
    }

    @Test public void returningFromUnknownSourcesPermissionRequiresAnotherExplicitInstall() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        String packageName = instrumentation.getTargetContext().getPackageName();
        assumeTrue(!instrumentation.getTargetContext().getPackageManager().canRequestPackageInstalls());
        AtomicReference<Intent> settings = new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (!Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES.equals(intent.getAction())) return null;
                settings.set(intent);
                return new Instrumentation.ActivityResult(Activity.RESULT_CANCELED, null);
            }
        };
        instrumentation.addMonitor(monitor);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            ready(scenario);
            command(scenario, "install");
            awaitValue(scenario, "window.update.status", "\"permission\"");
            assertEquals("package:" + packageName, settings.get().getDataString());
            scenario.moveToState(Lifecycle.State.CREATED);
            scenario.moveToState(Lifecycle.State.RESUMED);
            awaitValue(scenario, "window.update.status", "\"permission\"");
            assertTrue(instrumentation.getTargetContext().getPackageManager().getPackageInstaller().getMySessions().isEmpty());
        } finally { instrumentation.removeMonitor(monitor); }
    }

    @Test public void backgroundDuringRevalidationCancelsInstallationWithoutLatePrompt() throws Exception {
        assumeTrue(InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageManager().canRequestPackageInstalls());
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            ready(scenario);
            CountDownLatch gate = new CountDownLatch(1);
            UpdateNetworkFixture.blockCheck = gate;
            command(scenario, "install");
            awaitValue(scenario, "window.update.status", "\"installing\"");
            scenario.moveToState(Lifecycle.State.CREATED);
            gate.countDown();
            awaitValue(scenario, "window.update.status", "\"ready\"");
            scenario.moveToState(Lifecycle.State.RESUMED);
            awaitValue(scenario, "window.update.error", "\"cancelled\"");
            assertTrue(InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageManager().getPackageInstaller().getMySessions().isEmpty());
        }
    }

    @Test public void installationRequiresRealSystemConfirmationAndReportsUserCancellation() throws Exception {
        assumeTrue(InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageManager().canRequestPackageInstalls());
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            ready(scenario);
            command(scenario, "install");
            clickSystemButton("Cancel");
            awaitValue(scenario, "window.update.error", "\"cancelled\"");
            assertEquals("true", evaluate(scenario, "!!window.update.release"));
            assertEquals(BuildConfig.VERSION_CODE, UpdateApkVerifier.installed(InstrumentationRegistry.getInstrumentation().getTargetContext()).getLongVersionCode());
        }
    }

    @Test public void confirmedReplacementWhenExplicitlyRequested() throws Exception {
        // Replacing the instrumentation target kills this runner. The external verifier must check the new package afterward.
        assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("performUpdate")));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> CookieManager.getInstance().setCookie(BuildConfig.APP_ORIGIN,
                    "__Host-update-survival=synthetic; Secure; HttpOnly; Path=/; Max-Age=3600"));
            ready(scenario);
            command(scenario, "install");
            clickSystemButton("Update");
            SystemClock.sleep(20000);
            fail("The confirmed replacement should stop this instrumentation process");
        }
    }

    @Test public void verifiesVersionAndCookieAfterReplacementWhenExplicitlyRequested() throws Exception {
        assumeTrue("true".equals(InstrumentationRegistry.getArguments().getString("afterUpdate")));
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, PAGE);
            awaitValue(scenario, "window.update.installedVersionCode", String.valueOf(BuildConfig.VERSION_CODE + 1));
            assertEquals("\"idle\"", evaluate(scenario, "window.update.status"));
            scenario.onActivity(activity -> {
                String cookie = CookieManager.getInstance().getCookie(BuildConfig.APP_ORIGIN);
                assertTrue("The synthetic persistent cookie survived the actual self-update",
                        cookie != null && cookie.contains("__Host-update-survival=synthetic"));
                CookieManager.getInstance().setCookie(BuildConfig.APP_ORIGIN,
                        "__Host-update-survival=; Secure; HttpOnly; Path=/; Max-Age=0");
                CookieManager.getInstance().flush();
            });
        }
    }

    private static void ready(ActivityScenario<MainActivity> scenario) throws Exception {
        loadFixture(scenario, PAGE);
        command(scenario, "check");
        awaitValue(scenario, "window.update.status", "\"available\"");
        command(scenario, "download");
        awaitValue(scenario, "window.update.status", "\"ready\"");
    }

    private static void command(ActivityScenario<MainActivity> scenario, String command) throws Exception {
        evaluate(scenario, "BillBoardUpdater.postMessage(JSON.stringify({command:" + JSONObject.quote(command) + "}))");
    }

    private static void clickSystemButton(String label) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 15000;
        do {
            AccessibilityNodeInfo root = InstrumentationRegistry.getInstrumentation().getUiAutomation().getRootInActiveWindow();
            if (root != null && root.getPackageName() != null && root.getPackageName().toString().contains("packageinstaller")) {
                for (AccessibilityNodeInfo node : root.findAccessibilityNodeInfosByText(label)) {
                    if (node.isClickable() && node.getText() != null && node.getText().toString().equalsIgnoreCase(label)
                            && node.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return;
                }
            }
            SystemClock.sleep(100);
        } while (SystemClock.uptimeMillis() < deadline);
        fail("The real package installer did not show the expected confirmation button");
    }
}
