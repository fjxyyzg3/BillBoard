package com.billboard.app;

import android.app.Activity;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;

import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONObject;

import java.net.URI;
import java.util.Collections;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

/** Fixed RPC surface for the configured main frame, with bounded private-storage work. */
final class HouseholdKeyBridge {
    private final HouseholdKeyStore store;
    private final Gate gate = new Gate(new OriginPolicy(BuildConfig.APP_ORIGIN));
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0L, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(8));
    private WebView web;

    HouseholdKeyBridge(Activity activity) {
        store = new HouseholdKeyStore(activity, BuildConfig.APP_ORIGIN);
    }

    void attach(WebView view) {
        web = view;
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return;
        WebViewCompat.addWebMessageListener(view, "BillBoardHouseholdKeys", Collections.singleton(BuildConfig.APP_ORIGIN),
                (source, message, origin, mainFrame, proxy) -> {
                    boolean activeView = source == web && source.getVisibility() == View.VISIBLE;
                    long token = gate.begin(origin.toString(), mainFrame, activeView, source.getUrl());
                    if (token == 0) return;
                    String raw;
                    try { raw = message.getData(); }
                    catch (IllegalStateException ignored) { return; }
                    String requestId = Request.safeRequestId(raw);
                    if (requestId == null) return;
                    Request request;
                    try { request = Request.parse(raw); }
                    catch (IllegalArgumentException ignored) { reply(source, proxy, token, Request.error(requestId, "invalid")); return; }
                    if (request.operation.equals("clear")) {
                        gate.invalidate();
                        token = gate.begin(origin.toString(), mainFrame, activeView, source.getUrl());
                    }
                    final long accepted = token;
                    try {
                        worker.execute(() -> {
                            // Accepted deletion still finishes when navigation interrupts its reply.
                            if (!request.operation.equals("clear") && !gate.current(accepted)) return;
                            JSONObject response;
                            try { response = request.execute(store); }
                            catch (IllegalArgumentException ignored) { response = Request.error(request.requestId, "invalid"); }
                            catch (Exception ignored) { response = Request.error(request.requestId, "unavailable"); }
                            final JSONObject result = response;
                            main.post(() -> reply(source, proxy, accepted, result));
                        });
                    } catch (RejectedExecutionException ignored) {
                        reply(source, proxy, accepted, Request.error(request.requestId, "unavailable"));
                    }
                });
    }

    private void reply(WebView source, JavaScriptReplyProxy proxy, long token, JSONObject response) {
        if (source == web && source.getVisibility() == View.VISIBLE && gate.allowed(token, source.getUrl())) {
            try {
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) proxy.postMessage(response.toString());
            }
            catch (IllegalStateException ignored) { }
        }
    }

    void pageChanged(String url) { gate.invalidate(); }
    void resume() { gate.resume(); }
    void pause() { gate.pause(); }
    void detachPage() { gate.invalidate(); web = null; }
    void close() { gate.close(); web = null; worker.shutdown(); }

    static final class Gate {
        private final OriginPolicy policy;
        private boolean foreground;
        private boolean closed;
        private long generation = 1;

        Gate(OriginPolicy policy) { this.policy = policy; }
        synchronized void resume() { foreground = true; }
        synchronized void pause() { foreground = false; invalidate(); }
        synchronized void close() { closed = true; invalidate(); }
        synchronized void invalidate() { generation++; }
        synchronized boolean current(long token) { return token != 0 && token == generation && foreground && !closed; }
        synchronized boolean allowed(long token, String currentUrl) {
            return current(token) && policy.isTrusted(currentUrl) && !"/login".equals(URI.create(currentUrl).getPath());
        }
        synchronized long begin(String origin, boolean mainFrame, boolean sameView, String currentUrl) {
            return mainFrame && sameView && policy.isTrusted(origin) && allowed(generation, currentUrl) ? generation : 0;
        }
    }

    static final class Request {
        final String requestId;
        final String operation;
        final HouseholdKeyStore.Identity identity;
        final String code;

        private Request(String requestId, String operation, HouseholdKeyStore.Identity identity, String code) {
            this.requestId = requestId;
            this.operation = operation;
            this.identity = identity;
            this.code = code;
        }

        static String safeRequestId(String raw) {
            try {
                if (raw == null || raw.length() > 8192) return null;
                String id = HouseholdKeyStore.string(new JSONObject(raw), "requestId");
                return id.matches("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}") ? id : null;
            } catch (Exception ignored) { return null; }
        }

        static Request parse(String raw) {
            try {
                String id = safeRequestId(raw);
                if (id == null) throw HouseholdKeyStore.invalid();
                JSONObject input = new JSONObject(raw);
                HouseholdKeyStore.fields(input, "v", "requestId", "operation", "payload");
                if (!(input.get("v") instanceof Number) || input.getInt("v") != 1 || input.getDouble("v") != 1) throw HouseholdKeyStore.invalid();
                String operation = HouseholdKeyStore.string(input, "operation");
                if (!operation.equals("store") && !operation.equals("load") && !operation.equals("clear")) throw HouseholdKeyStore.invalid();
                JSONObject payload = input.getJSONObject("payload");
                if (operation.equals("store")) HouseholdKeyStore.fields(payload, "identity", "code");
                else HouseholdKeyStore.fields(payload, "identity");
                HouseholdKeyStore.Identity identity = HouseholdKeyStore.Identity.parse(payload.getJSONObject("identity"));
                String code = operation.equals("store") ? HouseholdKeyStore.string(payload, "code") : null;
                if (code != null) HouseholdKeyStore.validateCode(identity, code);
                return new Request(id, operation, identity, code);
            } catch (Exception ignored) { throw HouseholdKeyStore.invalid(); }
        }

        JSONObject execute(HouseholdKeyStore store) throws Exception {
            JSONObject payload = new JSONObject();
            switch (operation) {
                case "store": store.store(identity, code); break;
                case "load":
                    String loaded = store.load(identity);
                    payload.put("code", loaded == null ? JSONObject.NULL : loaded);
                    break;
                case "clear": store.clear(identity); break;
                default: throw HouseholdKeyStore.invalid();
            }
            return new JSONObject().put("v", 1).put("requestId", requestId).put("ok", true).put("payload", payload);
        }

        static JSONObject error(String id, String error) {
            try { return new JSONObject().put("v", 1).put("requestId", id).put("ok", false).put("error", error); }
            catch (Exception ignored) { throw new IllegalStateException("Household key response unavailable"); }
        }
    }

    static final class CameraGate {
        static final String VIDEO_CAPTURE = "android.webkit.resource.VIDEO_CAPTURE";
        private final OriginPolicy policy;
        private boolean foreground;
        private long generation;
        private long pending;
        private String page;

        CameraGate(OriginPolicy policy) { this.policy = policy; }
        void resume() { foreground = true; }
        void pause() { foreground = false; invalidate(); }
        void invalidate() { pending = 0; page = null; generation++; }
        long begin(String origin, String currentUrl, String[] resources) {
            invalidate();
            if (!foreground || !policy.isTrusted(origin) || !policy.isTrusted(currentUrl)
                    || resources == null || resources.length != 1 || !VIDEO_CAPTURE.equals(resources[0])) return 0;
            page = currentUrl;
            pending = generation;
            return pending;
        }
        boolean complete(long token, String currentUrl, boolean granted) {
            boolean allowed = token != 0 && token == pending && foreground && granted
                    && policy.isTrusted(currentUrl) && currentUrl.equals(page);
            if (token == pending) { pending = 0; page = null; }
            return allowed;
        }
    }
}
