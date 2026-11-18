package com.billboard.app;

import android.graphics.Bitmap;
import android.net.http.SslError;
import android.os.Message;
import android.view.KeyEvent;
import android.webkit.ClientCertRequest;
import android.webkit.HttpAuthHandler;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SafeBrowsingResponse;
import android.webkit.SslErrorHandler;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/** Replaces only the response body for one synthetic HTTPS request, after the real URL policy. */
final class FixtureWebViewClient extends WebViewClient {
    private final WebViewClient delegate;
    private final java.util.Map<String, String> fixtures;

    FixtureWebViewClient(WebViewClient delegate, String fixtureUrl, String html) {
        this(delegate, fixtureUrl, html, Collections.emptyMap());
    }

    FixtureWebViewClient(WebViewClient delegate, String fixtureUrl, String html, java.util.Map<String, String> extra) {
        this.delegate = delegate;
        fixtures = new java.util.HashMap<>(extra);
        fixtures.put(fixtureUrl, html);
    }

    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        WebResourceResponse policyResponse = delegate.shouldInterceptRequest(view, request);
        if (policyResponse != null) return policyResponse;
        String html = fixtures.get(request.getUrl().toString());
        if (html != null) {
            return new WebResourceResponse("text/html", "UTF-8", 200, "OK",
                    Collections.singletonMap("Cache-Control", "no-store"), new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        }
        return null;
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return delegate.shouldOverrideUrlLoading(view, request);
    }

    @SuppressWarnings("deprecation")
    @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
        return delegate.shouldOverrideUrlLoading(view, url);
    }

    @SuppressWarnings("deprecation")
    @Override public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
        return delegate.shouldInterceptRequest(view, url);
    }

    @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
        delegate.onPageStarted(view, url, favicon);
    }

    @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
        delegate.doUpdateVisitedHistory(view, url, isReload);
    }

    @Override public void onPageFinished(WebView view, String url) {
        delegate.onPageFinished(view, url);
    }

    @Override public void onPageCommitVisible(WebView view, String url) {
        delegate.onPageCommitVisible(view, url);
    }

    @Override public void onLoadResource(WebView view, String url) {
        delegate.onLoadResource(view, url);
    }

    @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        delegate.onReceivedError(view, request, error);
    }

    @SuppressWarnings("deprecation")
    @Override public void onReceivedError(WebView view, int code, String description, String url) {
        delegate.onReceivedError(view, code, description, url);
    }

    @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
        delegate.onReceivedHttpError(view, request, errorResponse);
    }

    @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
        delegate.onReceivedSslError(view, handler, error);
    }

    @Override public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
        delegate.onReceivedClientCertRequest(view, request);
    }

    @Override public void onReceivedHttpAuthRequest(WebView view, HttpAuthHandler handler, String host, String realm) {
        delegate.onReceivedHttpAuthRequest(view, handler, host, realm);
    }

    @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
        return delegate.onRenderProcessGone(view, detail);
    }

    @Override public void onSafeBrowsingHit(WebView view, WebResourceRequest request, int threatType, SafeBrowsingResponse callback) {
        delegate.onSafeBrowsingHit(view, request, threatType, callback);
    }

    @Override public void onFormResubmission(WebView view, Message dontResend, Message resend) {
        delegate.onFormResubmission(view, dontResend, resend);
    }

    @Override public boolean shouldOverrideKeyEvent(WebView view, KeyEvent event) {
        return delegate.shouldOverrideKeyEvent(view, event);
    }

    @Override public void onUnhandledKeyEvent(WebView view, KeyEvent event) {
        delegate.onUnhandledKeyEvent(view, event);
    }

    @Override public void onScaleChanged(WebView view, float oldScale, float newScale) {
        delegate.onScaleChanged(view, oldScale, newScale);
    }

    @Override public void onReceivedLoginRequest(WebView view, String realm, String account, String args) {
        delegate.onReceivedLoginRequest(view, realm, account, args);
    }

    @SuppressWarnings("deprecation")
    @Override public void onTooManyRedirects(WebView view, Message cancel, Message proceed) {
        delegate.onTooManyRedirects(view, cancel, proceed);
    }
}
