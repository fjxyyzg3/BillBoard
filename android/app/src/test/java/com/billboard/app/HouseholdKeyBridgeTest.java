package com.billboard.app;

import static org.junit.Assert.*;

import org.json.JSONObject;
import org.junit.Test;

import java.util.UUID;

public class HouseholdKeyBridgeTest {
    private final HouseholdKeyBridge.Gate gate = new HouseholdKeyBridge.Gate(new OriginPolicy(HouseholdKeyStoreTest.ORIGIN));

    static JSONObject request(String operation) throws Exception {
        return new JSONObject().put("v", 1).put("requestId", UUID.randomUUID().toString()).put("operation", operation)
                .put("payload", new JSONObject().put("identity", new JSONObject().put("accountId", "account-1")
                        .put("householdId", "household-1").put("memberId", "member-1")));
    }

    @Test public void onlyTheTrustedForegroundMainFrameMayAccessTheBridge() {
        String origin = HouseholdKeyStoreTest.ORIGIN;
        assertEquals(0, gate.begin(origin, true, true, origin + "/account"));
        gate.resume();
        assertTrue(gate.begin(origin, true, true, origin + "/account") != 0);
        assertEquals(0, gate.begin("https://untrusted.example", true, true, origin + "/account"));
        assertEquals(0, gate.begin(origin, false, true, origin + "/account"));
        assertEquals(0, gate.begin(origin, true, false, origin + "/account"));
        assertEquals(0, gate.begin(origin, true, true, "https://untrusted.example/account"));
        assertEquals(0, gate.begin(origin, true, true, origin + "/login"));
    }

    @Test public void lateRepliesCannotResurrectKeysAfterNavigationPauseOrDestroy() {
        String url = HouseholdKeyStoreTest.ORIGIN + "/account";
        gate.resume();
        long token = gate.begin(HouseholdKeyStoreTest.ORIGIN, true, true, url);
        gate.invalidate();
        assertFalse(gate.allowed(token, url));
        token = gate.begin(HouseholdKeyStoreTest.ORIGIN, true, true, url);
        gate.pause();
        gate.resume();
        assertFalse(gate.allowed(token, url));
        token = gate.begin(HouseholdKeyStoreTest.ORIGIN, true, true, url);
        gate.close();
        assertFalse(gate.allowed(token, url));
        assertEquals(0, gate.begin(HouseholdKeyStoreTest.ORIGIN, true, true, url));
    }

    @Test public void fixedRpcStoresLoadsAndClearsOnlyTheSuppliedIdentity() throws Exception {
        HouseholdKeyStoreTest.Storage storage = new HouseholdKeyStoreTest.Storage();
        HouseholdKeyStore store = new HouseholdKeyStore(HouseholdKeyStoreTest.ORIGIN, storage, new HouseholdKeyStoreTest.Keys());
        String code = HouseholdKeyStoreTest.code("household-1");
        JSONObject save = request("store");
        save.getJSONObject("payload").put("code", code);
        JSONObject saved = HouseholdKeyBridge.Request.parse(save.toString()).execute(store);
        assertTrue(saved.getBoolean("ok"));
        assertEquals(save.getString("requestId"), saved.getString("requestId"));
        assertEquals(0, saved.getJSONObject("payload").length());
        JSONObject loaded = HouseholdKeyBridge.Request.parse(request("load").toString()).execute(store);
        assertEquals(code, loaded.getJSONObject("payload").getString("code"));
        HouseholdKeyBridge.Request.parse(request("clear").toString()).execute(store);
        assertTrue(HouseholdKeyBridge.Request.parse(request("load").toString()).execute(store).getJSONObject("payload").isNull("code"));
    }

    @Test public void commandsRejectExtraFieldsArbitraryUrlsAndMalformedIdentity() throws Exception {
        for (String operation : new String[] {"fetch", "open", "execute", "clearAll", "loadFile"}) {
            assertThrows(IllegalArgumentException.class, () -> HouseholdKeyBridge.Request.parse(request(operation).toString()));
        }
        JSONObject withUrl = request("load").put("url", "https://untrusted.example");
        JSONObject withCode = request("load");
        withCode.getJSONObject("payload").put("code", HouseholdKeyStoreTest.code("household-1"));
        JSONObject withPath = request("store");
        withPath.getJSONObject("payload").put("file", "/private/data");
        JSONObject wrongIdentity = request("load");
        wrongIdentity.getJSONObject("payload").getJSONObject("identity").put("accountId", 123);
        for (JSONObject invalid : new JSONObject[] {withUrl, withCode, withPath, wrongIdentity, request("load").put("v", 1.5)}) {
            assertThrows(IllegalArgumentException.class, () -> HouseholdKeyBridge.Request.parse(invalid.toString()));
        }
        assertNull(HouseholdKeyBridge.Request.safeRequestId("secret-value"));
        assertNull(HouseholdKeyBridge.Request.safeRequestId(request("load").put("requestId", "secret-value").toString()));
        assertEquals("invalid", HouseholdKeyBridge.Request.error(UUID.randomUUID().toString(), "invalid").getString("error"));
    }
}
