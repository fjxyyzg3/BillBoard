package com.billboard.app;

import static org.junit.Assert.*;

import android.Manifest;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.webkit.CookieManager;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

@RunWith(AndroidJUnit4.class)
public class MainActivityTest {
    @Before public void requireSyntheticOrigin() {
        assertTrue("Instrumentation requires the synthetic HTTPS origin.",
                "https://billboard.example".equals(BuildConfig.APP_ORIGIN));
    }

    @Test public void webViewDisablesLocalAccessAndUntrustedPersistence() {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            scenario.onActivity(activity -> {
                WebView web = activity.findViewById(R.id.ledger_webview);
                WebSettings settings = web.getSettings();
                assertFalse(settings.getAllowFileAccess());
                assertFalse(settings.getAllowContentAccess());
                assertFalse(settings.getJavaScriptCanOpenWindowsAutomatically());
                assertFalse(CookieManager.getInstance().acceptThirdPartyCookies(web));
                assertEquals(WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.getMixedContentMode());
                assertEquals(WebSettings.LOAD_NO_CACHE, settings.getCacheMode());
                assertTrue(settings.getDomStorageEnabled());
                assertFalse(web.isSaveEnabled());
            });
        }
    }

    @Test public void backgroundCancelsPageCaptureWithoutDiscardingSessionDraft() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, "<script>sessionStorage.setItem('draft', 'pending');"
                    + "window.captureActive = true; window.addEventListener('blur', () => window.captureActive = false);</script>");
            assertEquals("\"pending\"", evaluate(scenario, "sessionStorage.getItem('draft')"));
            scenario.moveToState(Lifecycle.State.CREATED);
            awaitValue(scenario, "window.captureActive", "false");
            assertEquals("\"pending\"", evaluate(scenario, "sessionStorage.getItem('draft')"));
            scenario.moveToState(Lifecycle.State.RESUMED);
            assertEquals("\"pending\"", evaluate(scenario, "sessionStorage.getItem('draft')"));
        }
    }

    @Test public void grantedMicrophoneTracksEndWhenTheAppGoesToBackground() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        instrumentation.getUiAutomation().grantRuntimePermission(
                instrumentation.getTargetContext().getPackageName(), Manifest.permission.RECORD_AUDIO);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, "<script>sessionStorage.setItem('draft', 'pending');"
                    + "window.microphoneResult = 'requesting';"
                    + "navigator.mediaDevices.getUserMedia({audio: true, video: false}).then(stream => {"
                    + "window.micTrack = stream.getAudioTracks()[0]; window.microphoneResult = window.micTrack.readyState;"
                    + "window.addEventListener('blur', () => stream.getTracks().forEach(track => track.stop()));"
                    + "}).catch(error => {window.microphoneResult = error.name;});</script>");
            awaitValue(scenario, "window.microphoneResult", "\"live\"");
            scenario.moveToState(Lifecycle.State.CREATED);
            awaitValue(scenario, "window.micTrack.readyState", "\"ended\"");
            assertEquals("\"pending\"", evaluate(scenario, "sessionStorage.getItem('draft')"));
            scenario.moveToState(Lifecycle.State.RESUMED);
            assertEquals("\"pending\"", evaluate(scenario, "sessionStorage.getItem('draft')"));
        }
    }

    @Test public void navigationCannotOpenLocalUrls() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, "<p id='original'>Ledger fixture</p>");
            evaluate(scenario, "location.href = 'file:///sdcard/private.csv'; true");
            assertEquals("true", evaluate(scenario, "!!document.getElementById('original')"));
            evaluate(scenario, "location.href = 'content://com.billboard.fixture/fixture.csv'; true");
            assertEquals("true", evaluate(scenario, "!!document.getElementById('original')"));
        }
    }

    @Test public void systemSelectedContentUriCanBeReadByTheRealFileInput() throws Exception {
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        AtomicReference<Intent> pickerIntent = new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (!Intent.ACTION_OPEN_DOCUMENT.equals(intent.getAction())) return null;
                pickerIntent.set(intent);
                Intent response = new Intent().setData(Uri.parse("content://com.billboard.fixture/fixture.csv"));
                response.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                return new Instrumentation.ActivityResult(Activity.RESULT_OK, response);
            }
        };
        instrumentation.addMonitor(monitor);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadFixture(scenario, "<input id='bill' type='file' accept='.csv' style='width:280px;height:80px'>"
                    + "<script>document.getElementById('bill').onchange = async (event) => {"
                    + "window.fileText = await event.target.files[0].text(); };</script>");
            tapElement(scenario, "bill");
            awaitValue(scenario, "window.fileText", JSONObject.quote(BillFixtureProvider.CONTENT));
            assertNotNull(pickerIntent.get());
            assertTrue(pickerIntent.get().hasCategory(Intent.CATEGORY_OPENABLE));
            assertFalse(pickerIntent.get().getBooleanExtra(Intent.EXTRA_ALLOW_MULTIPLE, false));
        } finally {
            instrumentation.removeMonitor(monitor);
        }
    }

    static void loadFixture(ActivityScenario<MainActivity> scenario, String body) throws Exception {
        loadFixture(scenario, body, java.util.Collections.emptyMap());
    }

    static void loadFixture(ActivityScenario<MainActivity> scenario, String body, java.util.Map<String, String> extra) throws Exception {
        scenario.onActivity(activity -> {
            WebView web = activity.findViewById(R.id.ledger_webview);
            web.stopLoading();
            String fixtureUrl = BuildConfig.APP_ORIGIN + "/home?fixture=1";
            String html = "<!doctype html><meta name='viewport' content='width=device-width'>"
                    + body + "<script>window.fixtureReady = true;</script>";
            web.setWebViewClient(new FixtureWebViewClient(web.getWebViewClient(), fixtureUrl, html, extra));
            web.loadUrl(fixtureUrl);
        });
        awaitValue(scenario, "window.fixtureReady", "true");
    }

    static String evaluate(ActivityScenario<MainActivity> scenario, String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>();
        CountDownLatch latch = new CountDownLatch(1);
        scenario.onActivity(activity -> {
            WebView web = activity.findViewById(R.id.ledger_webview);
            web.evaluateJavascript(script, result -> { value.set(result); latch.countDown(); });
        });
        assertTrue("WebView script completed", latch.await(5, TimeUnit.SECONDS));
        return value.get();
    }

    static void awaitValue(ActivityScenario<MainActivity> scenario, String script, String expected) throws Exception {
        long deadline = SystemClock.uptimeMillis() + 10000;
        String actual;
        do {
            actual = evaluate(scenario, script);
            if (expected.equals(actual)) return;
            SystemClock.sleep(50);
        } while (SystemClock.uptimeMillis() < deadline);
        AtomicReference<String> diagnostic = new AtomicReference<>();
        scenario.onActivity(activity -> {
            WebView web = activity.findViewById(R.id.ledger_webview);
            diagnostic.set("nativeUrl=" + web.getUrl() + ",originalUrl=" + web.getOriginalUrl()
                    + ",visibility=" + web.getVisibility() + ",error="
                    + activity.findViewById(R.id.connection_error).getVisibility());
        });
        String documentState = evaluate(scenario, "JSON.stringify({url:document.URL,state:document.readyState,body:document.body?.innerText?.slice(0,200)})");
        assertEquals(diagnostic.get() + ";document=" + documentState, expected, actual);
    }

    private static void tapElement(ActivityScenario<MainActivity> scenario, String id) throws Exception {
        JSONArray bounds = new JSONArray(evaluate(scenario, "(() => {const r = document.getElementById('" + id
                + "').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2, devicePixelRatio];})()"));
        int[] location = new int[2];
        scenario.onActivity(activity -> activity.findViewById(R.id.ledger_webview).getLocationOnScreen(location));
        float x = location[0] + (float) (bounds.getDouble(0) * bounds.getDouble(2));
        float y = location[1] + (float) (bounds.getDouble(1) * bounds.getDouble(2));
        long down = SystemClock.uptimeMillis();
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        MotionEvent press = MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0);
        MotionEvent release = MotionEvent.obtain(down, down + 100, MotionEvent.ACTION_UP, x, y, 0);
        instrumentation.sendPointerSync(press);
        instrumentation.sendPointerSync(release);
        press.recycle();
        release.recycle();
    }
}
