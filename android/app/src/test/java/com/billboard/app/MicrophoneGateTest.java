package com.billboard.app;

import static org.junit.Assert.*;

import org.junit.Test;

public class MicrophoneGateTest {
    private static final String ORIGIN = "https://ledger.example.com";
    private static final String[] AUDIO = {MicrophoneGate.AUDIO_CAPTURE};
    private final MicrophoneGate gate = new MicrophoneGate(new OriginPolicy(ORIGIN));

    @Test public void foregroundTrustedAudioCanBeGrantedOnce() {
        gate.resume();
        long request = gate.begin(ORIGIN, ORIGIN + "/add", AUDIO);
        assertTrue(request != 0);
        assertTrue(gate.complete(request, ORIGIN + "/add", true));
        assertFalse(gate.complete(request, ORIGIN + "/add", true));
    }

    @Test public void pauseAndLateOsPermissionMustNotRestartCapture() {
        gate.resume();
        long request = gate.begin(ORIGIN, ORIGIN + "/add", AUDIO);
        gate.pause();
        gate.resume();
        assertFalse(gate.complete(request, ORIGIN + "/add", true));
    }

    @Test public void cancelledOrSupersededRequestsStayCancelled() {
        gate.resume();
        long first = gate.begin(ORIGIN, ORIGIN + "/add", AUDIO);
        gate.invalidate();
        assertFalse(gate.complete(first, ORIGIN + "/add", true));
        long second = gate.begin(ORIGIN, ORIGIN + "/add", AUDIO);
        long third = gate.begin(ORIGIN, ORIGIN + "/add", AUDIO);
        assertFalse(gate.complete(second, ORIGIN + "/add", true));
        assertTrue(gate.complete(third, ORIGIN + "/add", true));
    }

    @Test public void navigationOrDenialCannotGrantMicrophone() {
        gate.resume();
        long request = gate.begin(ORIGIN, ORIGIN + "/add", AUDIO);
        assertFalse(gate.complete(request, "https://other.example.com/add", true));
        request = gate.begin(ORIGIN, ORIGIN + "/add", AUDIO);
        assertFalse(gate.complete(request, ORIGIN + "/add", false));
    }

    @Test public void requestsRejectUntrustedFramesAndExtraResources() {
        assertEquals(0, gate.begin(ORIGIN, ORIGIN + "/add", AUDIO));
        gate.resume();
        assertEquals(0, gate.begin("https://other.example.com", ORIGIN + "/add", AUDIO));
        assertEquals(0, gate.begin(ORIGIN, "https://other.example.com", AUDIO));
        assertEquals(0, gate.begin(ORIGIN, ORIGIN, new String[] {MicrophoneGate.AUDIO_CAPTURE, "android.webkit.resource.VIDEO_CAPTURE"}));
        assertEquals(0, gate.begin(ORIGIN, ORIGIN, new String[] {"unknown.future.permission"}));
        assertEquals(0, gate.begin(ORIGIN, ORIGIN, new String[0]));
    }
}
