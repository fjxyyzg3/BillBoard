package com.billboard.app;

import static org.junit.Assert.*;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.security.keystore.KeyInfo;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;

/** Real device checks restricted to the debug APK, synthetic pages and owned random identities. */
@RunWith(AndroidJUnit4.class)
public class HouseholdKeyDeviceTest {
    private static final String ORIGIN = "https://billboard.example";
    private static final String PREFIX = "household-key-test-";
    private static final String FOREIGN_FRAME = "https://foreign.example/household-key-frame";
    private static final String PAGE = "<p>Household key device fixture</p><script>"
            + "window.keyResponses={};window.keyFrames={};"
            + "BillBoardHouseholdKeys.onmessage=e=>{const r=JSON.parse(e.data);window.keyResponses[r.requestId]=r;};"
            + "window.addEventListener('message',e=>{if(e.data&&e.data.householdKeyFrame)"
            + "window.keyFrames[e.data.householdKeyFrame]=e.data.bridge;});</script>";
    private Context context;
    private final List<HouseholdKeyStore.Identity> owned = new ArrayList<>();

    @Before public void requireDebugSyntheticBuild() {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        assertEquals("Only the isolated debug application may run these checks", "com.billboard.app.debug", target.getPackageName());
        assertTrue("The target APK must be debuggable", BuildConfig.DEBUG
                && (target.getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0);
        assertEquals("The APK must use the synthetic HTTPS origin", ORIGIN, BuildConfig.APP_ORIGIN);
        context = target;
    }

    @After public void removeOnlyOwnedSyntheticCodes() throws Exception {
        if (context == null || owned.isEmpty()) return;
        HouseholdKeyStore store = new HouseholdKeyStore(context, ORIGIN);
        for (HouseholdKeyStore.Identity identity : owned) {
            assertTrue(identity.accountId.startsWith(PREFIX) && identity.householdId.startsWith(PREFIX)
                    && identity.memberId.startsWith(PREFIX));
            store.clear(identity);
        }
    }

    @Test public void verifiesDebugPackageAndSyntheticOrigin() {
        assertNotNull("The preflight must complete before any device data is touched", context);
    }

    @Test public void realKeystoreAndPrivateCiphertextSurviveStoreRecreation() throws Exception {
        HouseholdKeyStore.Identity identity = identity();
        String code = code(identity.householdId);
        new HouseholdKeyStore(context, ORIGIN).store(identity, code);
        String slot = slot(identity);
        String sealed = preferences().getString(slot, null);
        assertNotNull("A private ciphertext package must be persisted", sealed);
        assertTrue(sealed.startsWith("v1."));
        assertFalse("The private package must not contain the synthetic plaintext code", sealed.contains(code));
        assertTrue("A fresh store instance must recover the same synthetic code",
                code.equals(new HouseholdKeyStore(context, ORIGIN).load(identity)));
        SecretKey key = (SecretKey) deviceKeys().getKey(alias(identity), null);
        assertNotNull(key);
        assertNull("The Android Keystore key must not be exportable", key.getEncoded());
        KeyInfo info = (KeyInfo) SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore").getKeySpec(key, KeyInfo.class);
        assertEquals(256, info.getKeySize());
    }

    @Test public void realIdentityIsolationAndClearInvalidateOnlyTheSelectedCode() throws Exception {
        HouseholdKeyStore.Identity original = identity();
        HouseholdKeyStore.Identity partner = own(original.accountId + "-other", original.householdId, original.memberId + "-other");
        String originalCode = code(original.householdId), partnerCode = code(partner.householdId);
        HouseholdKeyStore store = new HouseholdKeyStore(context, ORIGIN);
        store.store(original, originalCode);
        store.store(partner, partnerCode);
        assertNull(store.load(new HouseholdKeyStore.Identity(original.accountId + "-other", original.householdId, original.memberId)));
        assertNull(store.load(new HouseholdKeyStore.Identity(original.accountId, original.householdId + "-other", original.memberId)));
        assertNull(store.load(new HouseholdKeyStore.Identity(original.accountId, original.householdId, original.memberId + "-other")));
        String staleCiphertext = preferences().getString(slot(original), null);
        assertNotNull(staleCiphertext);
        store.clear(original);
        assertNull(new HouseholdKeyStore(context, ORIGIN).load(original));
        assertFalse(deviceKeys().containsAlias(alias(original)));
        assertNull(preferences().getString(slot(original), null));
        assertTrue(partnerCode.equals(new HouseholdKeyStore(context, ORIGIN).load(partner)));
        // A stale package cannot revive the deleted per-identity Android Keystore key.
        assertTrue(preferences().edit().putString(slot(original), staleCiphertext).commit());
        assertThrows(GeneralSecurityException.class, () -> new HouseholdKeyStore(context, ORIGIN).load(original));
        assertFalse(deviceKeys().containsAlias(alias(original)));
    }

    @Test public void realMainFrameRpcSurvivesActivityRecreationAndReopenThenClears() throws Exception {
        HouseholdKeyStore.Identity identity = identity();
        String code = code(identity.householdId);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadPage(scenario, Collections.emptyMap());
            request(scenario, "store", identity, code);
            assertTrue(code.equals(new HouseholdKeyStore(context, ORIGIN).load(identity)));
            scenario.recreate();
            loadPage(scenario, Collections.emptyMap());
            assertLoaded(scenario, identity, code);
        }
        try (ActivityScenario<MainActivity> reopened = ActivityScenario.launch(MainActivity.class)) {
            loadPage(reopened, Collections.emptyMap());
            assertLoaded(reopened, identity, code);
            request(reopened, "clear", identity, null);
            String response = request(reopened, "load", identity, null);
            assertEquals("true", MainActivityTest.evaluate(reopened, response + ".payload.code===null"));
            assertNull(new HouseholdKeyStore(context, ORIGIN).load(identity));
        }
    }

    @Test public void realBridgeRejectsSubframesOpaqueAndForeignOrigins() throws Exception {
        HouseholdKeyStore.Identity identity = identity();
        String code = code(identity.householdId);
        new HouseholdKeyStore(context, ORIGIN).store(identity, code);
        String foreign = frame("foreign", identity);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            loadPage(scenario, Collections.singletonMap(FOREIGN_FRAME, foreign));
            appendFrame(scenario, frame("same", identity), false);
            MainActivityTest.awaitValue(scenario, "window.keyFrames.same", "\"object\"");
            assertLoaded(scenario, identity, code);
            appendFrame(scenario, frame("opaque", identity), true);
            MainActivityTest.awaitValue(scenario, "window.keyFrames.opaque", "\"undefined\"");
            assertLoaded(scenario, identity, code);
            MainActivityTest.evaluate(scenario, "(()=>{const f=document.createElement('iframe');f.src="
                    + JSONObject.quote(FOREIGN_FRAME) + ";document.body.append(f);return true;})()");
            MainActivityTest.awaitValue(scenario, "window.keyFrames.foreign", "\"undefined\"");
            assertLoaded(scenario, identity, code);
            assertTrue("Rejected frame requests must preserve the original private code",
                    code.equals(new HouseholdKeyStore(context, ORIGIN).load(identity)));
        }
    }

    private HouseholdKeyStore.Identity identity() {
        String suffix = UUID.randomUUID().toString();
        return own(PREFIX + "account-" + suffix, PREFIX + "family-" + suffix, PREFIX + "member-" + suffix);
    }

    private HouseholdKeyStore.Identity own(String accountId, String householdId, String memberId) {
        HouseholdKeyStore.Identity identity = new HouseholdKeyStore.Identity(accountId, householdId, memberId);
        owned.add(identity);
        return identity;
    }

    private SharedPreferences preferences() { return context.getSharedPreferences("household-codes-v1", Context.MODE_PRIVATE); }

    private static KeyStore deviceKeys() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private static String alias(HouseholdKeyStore.Identity identity) throws Exception { return "billboard.household-code.v1." + slot(identity); }

    private static String slot(HouseholdKeyStore.Identity identity) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(identity.binding(ORIGIN).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(64);
        for (byte value : digest) hex.append(String.format(Locale.ROOT, "%02x", value & 255));
        return hex.toString();
    }

    private static String code(String householdId) {
        byte[] secret = new byte[32];
        new SecureRandom().nextBytes(secret);
        try {
            String encoded = Base64.getUrlEncoder().withoutPadding().encodeToString(secret);
            String json = "{\"generation\":\"device-fixture\",\"householdId\":" + JSONObject.quote(householdId)
                    + ",\"keyVersion\":1,\"secret\":" + JSONObject.quote(encoded) + ",\"v\":1}";
            return "BBK1." + Base64.getUrlEncoder().withoutPadding().encodeToString(json.getBytes(StandardCharsets.UTF_8));
        } finally { Arrays.fill(secret, (byte) 0); }
    }

    private static void loadPage(ActivityScenario<MainActivity> scenario, Map<String, String> extra) throws Exception {
        scenario.onActivity(activity -> assertTrue("The installed device WebView must support the real message listener",
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)));
        MainActivityTest.loadFixture(scenario, PAGE, extra);
        MainActivityTest.awaitValue(scenario, "typeof BillBoardHouseholdKeys", "\"object\"");
    }

    private static JSONObject message(String operation, HouseholdKeyStore.Identity identity, String code) throws Exception {
        JSONObject payload = new JSONObject().put("identity", new JSONObject().put("accountId", identity.accountId)
                .put("householdId", identity.householdId).put("memberId", identity.memberId));
        if (code != null) payload.put("code", code);
        return new JSONObject().put("v", 1).put("requestId", UUID.randomUUID().toString()).put("operation", operation).put("payload", payload);
    }

    private static String request(ActivityScenario<MainActivity> scenario, String operation, HouseholdKeyStore.Identity identity, String code) throws Exception {
        JSONObject message = message(operation, identity, code);
        String response = "window.keyResponses[" + JSONObject.quote(message.getString("requestId")) + "]";
        MainActivityTest.evaluate(scenario, "BillBoardHouseholdKeys.postMessage(" + JSONObject.quote(message.toString()) + ");true");
        MainActivityTest.awaitValue(scenario, response + "?.ok", "true");
        return response;
    }

    private static void assertLoaded(ActivityScenario<MainActivity> scenario, HouseholdKeyStore.Identity identity, String code) throws Exception {
        String response = request(scenario, "load", identity, null);
        assertEquals("true", MainActivityTest.evaluate(scenario, response + ".payload.code===" + JSONObject.quote(code)));
    }

    private static String frame(String name, HouseholdKeyStore.Identity identity) throws Exception {
        return "<script>const bridge=typeof BillBoardHouseholdKeys;if(bridge==='object')"
                + "BillBoardHouseholdKeys.postMessage(" + JSONObject.quote(message("clear", identity, null).toString()) + ");"
                + "parent.postMessage({householdKeyFrame:" + JSONObject.quote(name) + ",bridge},'*');</script>";
    }

    private static void appendFrame(ActivityScenario<MainActivity> scenario, String html, boolean opaque) throws Exception {
        MainActivityTest.evaluate(scenario, "(()=>{const f=document.createElement('iframe');"
                + (opaque ? "f.sandbox='allow-scripts';" : "") + "f.srcdoc=" + JSONObject.quote(html)
                + ";document.body.append(f);return true;})()");
    }
}
