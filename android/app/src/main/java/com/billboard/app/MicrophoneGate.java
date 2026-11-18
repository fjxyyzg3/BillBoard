package com.billboard.app;

final class MicrophoneGate {
    static final String AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE";
    private final OriginPolicy policy;
    private boolean foreground;
    private long generation;
    private long pending;

    MicrophoneGate(OriginPolicy policy) {
        this.policy = policy;
    }

    void resume() {
        foreground = true;
    }

    void pause() {
        foreground = false;
        invalidate();
    }

    void invalidate() {
        pending = 0;
        generation++;
    }

    long begin(String requestingOrigin, String currentUrl, String[] resources) {
        invalidate();
        if (!foreground || !policy.isTrusted(requestingOrigin) || !policy.isTrusted(currentUrl)
                || resources == null || resources.length != 1 || !AUDIO_CAPTURE.equals(resources[0])) return 0;
        pending = generation;
        return pending;
    }

    boolean complete(long token, String currentUrl, boolean osPermissionGranted) {
        boolean allowed = token != 0 && token == pending && foreground
                && osPermissionGranted && policy.isTrusted(currentUrl);
        if (token == pending) pending = 0;
        return allowed;
    }
}
