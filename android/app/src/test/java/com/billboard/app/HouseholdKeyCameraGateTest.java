package com.billboard.app;

import static org.junit.Assert.*;

import org.junit.Test;

public class HouseholdKeyCameraGateTest {
    private final HouseholdKeyBridge.CameraGate gate = new HouseholdKeyBridge.CameraGate(new OriginPolicy(HouseholdKeyStoreTest.ORIGIN));
    private static final String[] VIDEO = {HouseholdKeyBridge.CameraGate.VIDEO_CAPTURE};

    @Test public void trustedForegroundQrCameraIsGrantedOnlyOnce() {
        gate.resume();
        long token = gate.begin(HouseholdKeyStoreTest.ORIGIN, HouseholdKeyStoreTest.ORIGIN + "/account", VIDEO);
        assertTrue(token != 0);
        assertTrue(gate.complete(token, HouseholdKeyStoreTest.ORIGIN + "/account", true));
        assertFalse(gate.complete(token, HouseholdKeyStoreTest.ORIGIN + "/account", true));
    }

    @Test public void permissionDenialNavigationAndBackgroundCancelCapture() {
        gate.resume();
        long token = gate.begin(HouseholdKeyStoreTest.ORIGIN, HouseholdKeyStoreTest.ORIGIN + "/account", VIDEO);
        assertFalse(gate.complete(token, HouseholdKeyStoreTest.ORIGIN + "/account", false));
        token = gate.begin(HouseholdKeyStoreTest.ORIGIN, HouseholdKeyStoreTest.ORIGIN + "/account", VIDEO);
        assertFalse(gate.complete(token, HouseholdKeyStoreTest.ORIGIN + "/home", true));
        token = gate.begin(HouseholdKeyStoreTest.ORIGIN, HouseholdKeyStoreTest.ORIGIN + "/account", VIDEO);
        gate.pause();
        gate.resume();
        assertFalse(gate.complete(token, HouseholdKeyStoreTest.ORIGIN + "/account", true));
    }

    @Test public void untrustedOrCombinedPermissionsFailClosed() {
        assertEquals(0, gate.begin(HouseholdKeyStoreTest.ORIGIN, HouseholdKeyStoreTest.ORIGIN, VIDEO));
        gate.resume();
        assertEquals(0, gate.begin("https://other.example", HouseholdKeyStoreTest.ORIGIN, VIDEO));
        assertEquals(0, gate.begin(HouseholdKeyStoreTest.ORIGIN, "https://other.example", VIDEO));
        assertEquals(0, gate.begin(HouseholdKeyStoreTest.ORIGIN, HouseholdKeyStoreTest.ORIGIN,
                new String[] {HouseholdKeyBridge.CameraGate.VIDEO_CAPTURE, MicrophoneGate.AUDIO_CAPTURE}));
        assertEquals(0, gate.begin(HouseholdKeyStoreTest.ORIGIN, HouseholdKeyStoreTest.ORIGIN, new String[] {"unknown.permission"}));
    }
}
