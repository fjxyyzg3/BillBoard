package com.billboard.app;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerController;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import java.io.ByteArrayInputStream;
import java.util.Locale;

public final class MainActivity extends ComponentActivity {
    private static final int SURFACE = Color.rgb(255, 253, 248);
    private static final String INTERRUPT_CAPTURE = "window.dispatchEvent(new Event('blur'));";
    private final OriginPolicy originPolicy = new OriginPolicy(BuildConfig.APP_ORIGIN);
    private final MicrophoneGate microphoneGate = new MicrophoneGate(originPolicy);
    private final HouseholdKeyBridge.CameraGate cameraGate = new HouseholdKeyBridge.CameraGate(originPolicy);
    private FrameLayout root;
    private WebView webView;
    private AndroidUpdater updater;
    private HouseholdKeyBridge householdKeys;
    private LinearLayout errorPanel;
    private TextView errorTitle;
    private TextView errorMessage;
    private Button retryButton;
    private ProgressBar progress;
    private boolean foreground;
    private boolean loadFailed;
    private boolean tlsFailure;
    private boolean permissionInFlight;
    private boolean pickerInFlight;
    private String retryUrl = BuildConfig.APP_ORIGIN + "/home";
    private PermissionRequest microphoneRequest;
    private long microphoneToken;
    private PermissionRequest cameraRequest;
    private long cameraToken;
    private ValueCallback<Uri[]> fileCallback;
    private String filePage;

    private final ActivityResultLauncher<String> microphonePermission = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                permissionInFlight = false;
                PermissionRequest request = microphoneRequest;
                microphoneRequest = null;
                if (request != null && webView != null
                        && microphoneGate.complete(microphoneToken, webView.getUrl(), granted)) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else {
                    if (request != null) request.deny();
                    if (foreground) notice(granted ? R.string.microphone_ready : R.string.microphone_denied);
                }
            });

    private final ActivityResultLauncher<String> cameraPermission = registerForActivityResult(
            new ActivityResultContracts.RequestPermission(), granted -> {
                permissionInFlight = false;
                PermissionRequest request = cameraRequest;
                cameraRequest = null;
                if (request != null && webView != null
                        && cameraGate.complete(cameraToken, webView.getUrl(), granted)) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                } else if (request != null) request.deny();
            });

    private final ActivityResultLauncher<Intent> filePicker = registerForActivityResult(
            new ActivityResultContracts.StartActivityForResult(), result -> {
                pickerInFlight = false;
                ValueCallback<Uri[]> callback = fileCallback;
                fileCallback = null;
                if (callback == null) return;
                Uri selected = result.getResultCode() == RESULT_OK && result.getData() != null
                        ? result.getData().getData() : null;
                boolean valid = webView != null && originPolicy.isTrusted(webView.getUrl())
                        && webView.getUrl().equals(filePage) && selected != null
                        && OriginPolicy.isSelectedContentUri(selected.toString());
                callback.onReceiveValue(valid ? new Uri[] {selected} : null);
                filePage = null;
            });

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) setRecentsScreenshotEnabled(false);
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        root = new FrameLayout(this);
        root.setBackgroundColor(SURFACE);
        if (Build.VERSION.SDK_INT >= 30) {
            root.setImportantForContentCapture(View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS);
        }
        setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view, insets) -> {
            Insets safe = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
            return WindowInsetsCompat.CONSUMED;
        });
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), root);
        bars.setAppearanceLightStatusBars(true);
        bars.setAppearanceLightNavigationBars(true);
        createErrorPanel();
        updater = new AndroidUpdater(this);
        householdKeys = new HouseholdKeyBridge(this);
        createWebView();
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override public void handleOnBackPressed() {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(root);
                if (insets != null && insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    WindowCompat.getInsetsController(getWindow(), root).hide(WindowInsetsCompat.Type.ime());
                    return;
                }
                interruptCapture();
                if (webView != null && !originPolicy.isRootPage(webView.getUrl()) && webView.canGoBack()) webView.goBack();
                else moveTaskToBack(true);
            }
        });
        loadLedger();
    }

    private void createErrorPanel() {
        errorPanel = new LinearLayout(this);
        errorPanel.setId(R.id.connection_error);
        errorPanel.setOrientation(LinearLayout.VERTICAL);
        errorPanel.setGravity(Gravity.CENTER);
        errorPanel.setPadding(dp(28), dp(28), dp(28), dp(28));
        errorPanel.setBackgroundColor(SURFACE);
        errorTitle = new TextView(this);
        errorTitle.setTextSize(22);
        errorTitle.setTextColor(Color.rgb(44, 35, 31));
        errorTitle.setGravity(Gravity.CENTER);
        errorMessage = new TextView(this);
        errorMessage.setTextSize(16);
        errorMessage.setTextColor(Color.rgb(92, 82, 75));
        errorMessage.setGravity(Gravity.CENTER);
        errorMessage.setPadding(0, dp(16), 0, dp(20));
        retryButton = new Button(this);
        retryButton.setOnClickListener(view -> loadLedger());
        errorPanel.addView(errorTitle);
        errorPanel.addView(errorMessage);
        errorPanel.addView(retryButton);
        errorPanel.setVisibility(View.GONE);
        root.addView(errorPanel, new FrameLayout.LayoutParams(-1, -1));
        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        FrameLayout.LayoutParams progressLayout = new FrameLayout.LayoutParams(-1, dp(3), Gravity.TOP);
        root.addView(progress, progressLayout);
    }

    private void createWebView() {
        webView = new WebView(this);
        webView.setId(R.id.ledger_webview);
        webView.setSaveEnabled(false);
        webView.setBackgroundColor(SURFACE);
        if (Build.VERSION.SDK_INT >= 30) {
            webView.setImportantForContentCapture(View.IMPORTANT_FOR_CONTENT_CAPTURE_NO_EXCLUDE_DESCENDANTS);
        }
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        settings.setGeolocationEnabled(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMediaPlaybackRequiresUserGesture(true);
        settings.setSafeBrowsingEnabled(true);
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setCacheMode(WebSettings.LOAD_NO_CACHE);
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setAllowFileAccess(false);
        ServiceWorkerController.getInstance().getServiceWorkerWebSettings().setAllowContentAccess(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.clearCache(true);
        webView.setWebViewClient(new LedgerClient());
        webView.setWebChromeClient(new LedgerChromeClient());
        updater.attach(webView);
        householdKeys.attach(webView);
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> notice(R.string.download_unavailable));
        root.addView(webView, 0, new FrameLayout.LayoutParams(-1, -1));
    }

    private void loadLedger() {
        if (webView == null) createWebView();
        loadFailed = false;
        errorPanel.setVisibility(View.GONE);
        webView.setVisibility(foreground ? View.VISIBLE : View.INVISIBLE);
        progress.setContentDescription(label(R.string.loading));
        progress.setVisibility(View.VISIBLE);
        webView.loadUrl(originPolicy.isTrusted(retryUrl) ? retryUrl : BuildConfig.APP_ORIGIN + "/home");
    }

    private void showFailure(boolean tls) {
        updater.pageChanged(null);
        householdKeys.pageChanged(null);
        loadFailed = true;
        tlsFailure = tls;
        interruptCapture();
        cancelFileSelection();
        if (webView != null) {
            webView.stopLoading();
            webView.setVisibility(View.INVISIBLE);
        }
        progress.setVisibility(View.GONE);
        updateErrorLabels();
        errorPanel.setVisibility(View.VISIBLE);
    }

    private void updateErrorLabels() {
        errorTitle.setText(label(tlsFailure ? R.string.tls_title : R.string.connection_title));
        errorMessage.setText(label(tlsFailure ? R.string.tls_message : R.string.connection_message));
        retryButton.setText(label(R.string.retry));
    }

    private String label(int resource) {
        String cookies = CookieManager.getInstance().getCookie(BuildConfig.APP_ORIGIN);
        boolean english = false;
        if (cookies != null) {
            for (String cookie : cookies.split(";")) {
                if (cookie.trim().equals("billboard-locale=en-US")) english = true;
            }
        }
        Configuration configuration = new Configuration(getResources().getConfiguration());
        configuration.setLocale(english ? Locale.US : Locale.SIMPLIFIED_CHINESE);
        Context localized = createConfigurationContext(configuration);
        return localized.getString(resource);
    }

    private void notice(int resource) {
        Toast.makeText(this, label(resource), Toast.LENGTH_LONG).show();
    }

    private void cancelMicrophoneRequest() {
        microphoneGate.invalidate();
        if (microphoneRequest != null) {
            microphoneRequest.deny();
            microphoneRequest = null;
        }
    }

    private void cancelCameraRequest() {
        cameraGate.invalidate();
        if (cameraRequest != null) {
            cameraRequest.deny();
            cameraRequest = null;
        }
    }

    private void interruptCapture() {
        cancelMicrophoneRequest();
        cancelCameraRequest();
        if (webView != null && originPolicy.isTrusted(webView.getUrl())) {
            // The existing recorder cancels on blur, including late getUserMedia results.
            webView.evaluateJavascript(INTERRUPT_CAPTURE, null);
        }
    }

    private void cancelFileSelection() {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = null;
        filePage = null;
    }

    private void openExternal(String url) {
        if (!foreground || !originPolicy.isExternalHttps(url)) return;
        interruptCapture();
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            startActivity(intent);
        } catch (ActivityNotFoundException | SecurityException exception) {
            notice(R.string.external_link_unavailable);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        if (updater != null) updater.resume();
        if (householdKeys != null) householdKeys.resume();
        microphoneGate.resume();
        cameraGate.resume();
        if (webView != null) {
            webView.onResume();
            if (!loadFailed) webView.setVisibility(View.VISIBLE);
        }
        if (loadFailed) updateErrorLabels();
    }

    @Override protected void onPause() {
        foreground = false;
        if (updater != null) updater.pause();
        if (householdKeys != null) householdKeys.pause();
        microphoneGate.pause();
        cameraGate.pause();
        interruptCapture();
        if (webView != null) {
            webView.setVisibility(View.INVISIBLE);
            webView.onPause();
        }
        CookieManager.getInstance().flush();
        super.onPause();
    }

    @Override protected void onStop() {
        if (webView != null) webView.clearCache(true);
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (updater != null) updater.close();
        if (householdKeys != null) householdKeys.close();
        cancelMicrophoneRequest();
        cancelCameraRequest();
        cancelFileSelection();
        if (webView != null) {
            root.removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private final class LedgerClient extends WebViewClient {
        @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            String url = request.getUrl().toString();
            if (originPolicy.isTrusted(url)) return false;
            if (request.isForMainFrame() && request.hasGesture()) openExternal(url);
            return true;
        }

        @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            // This also blocks untrusted main-frame POSTs, which skip shouldOverrideUrlLoading.
            if (request.isForMainFrame() && !originPolicy.isTrusted(request.getUrl().toString())) {
                return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", null,
                        new ByteArrayInputStream(new byte[0]));
            }
            return null;
        }

        @Override public void onPageStarted(WebView view, String url, Bitmap favicon) {
            updater.pageChanged(url);
            householdKeys.pageChanged(url);
            cancelMicrophoneRequest();
            cancelCameraRequest();
            cancelFileSelection();
            if (!originPolicy.isTrusted(url)) {
                showFailure(false);
                return;
            }
            retryUrl = url;
            loadFailed = false;
            errorPanel.setVisibility(View.GONE);
            if (foreground) webView.setVisibility(View.VISIBLE);
            progress.setVisibility(View.VISIBLE);
        }

        @Override public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            updater.historyChanged(url);
            householdKeys.pageChanged(url);
            cancelMicrophoneRequest();
            cancelCameraRequest();
            cancelFileSelection();
        }

        @Override public void onPageFinished(WebView view, String url) {
            if (url.equals(retryUrl)) progress.setVisibility(View.GONE);
            CookieManager.getInstance().flush();
        }

        @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame() && request.getUrl().toString().equals(retryUrl)) {
                showFailure(error.getErrorCode() == ERROR_FAILED_SSL_HANDSHAKE);
            }
        }

        @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
            if (request.isForMainFrame() && request.getUrl().toString().equals(retryUrl)
                    && errorResponse.getStatusCode() >= 400) showFailure(false);
        }

        @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            handler.cancel();
            if (error.getUrl().equals(retryUrl)) showFailure(true);
        }

        @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            updater.detachPage();
            householdKeys.detachPage();
            cancelMicrophoneRequest();
            cancelCameraRequest();
            cancelFileSelection();
            root.removeView(view);
            view.destroy();
            webView = null;
            showFailure(false);
            return true;
        }
    }

    private final class LedgerChromeClient extends WebChromeClient {
        @Override public void onProgressChanged(WebView view, int value) {
            progress.setProgress(value);
            if (value == 100) progress.setVisibility(View.GONE);
        }

        @Override public boolean onConsoleMessage(ConsoleMessage message) {
            return true;
        }

        @Override public void onPermissionRequest(PermissionRequest request) {
            cancelMicrophoneRequest();
            cancelCameraRequest();
            String[] resources = request.getResources();
            if (resources.length == 1 && PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resources[0])) {
                long token = cameraGate.begin(request.getOrigin().toString(), webView.getUrl(), resources);
                if (token == 0 || permissionInFlight) {
                    request.deny();
                    return;
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    if (cameraGate.complete(token, webView.getUrl(), true)) {
                        request.grant(new String[] {PermissionRequest.RESOURCE_VIDEO_CAPTURE});
                    } else request.deny();
                    return;
                }
                cameraRequest = request;
                cameraToken = token;
                permissionInFlight = true;
                cameraPermission.launch(Manifest.permission.CAMERA);
                return;
            }
            long token = microphoneGate.begin(request.getOrigin().toString(), webView.getUrl(), request.getResources());
            if (token == 0 || permissionInFlight) {
                request.deny();
                return;
            }
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                if (microphoneGate.complete(token, webView.getUrl(), true)) {
                    request.grant(new String[] {PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                } else request.deny();
                return;
            }
            microphoneRequest = request;
            microphoneToken = token;
            permissionInFlight = true;
            microphonePermission.launch(Manifest.permission.RECORD_AUDIO);
        }

        @Override public void onPermissionRequestCanceled(PermissionRequest request) {
            if (request == microphoneRequest) {
                microphoneRequest = null;
                microphoneGate.invalidate();
            }
            if (request == cameraRequest) {
                cameraRequest = null;
                cameraGate.invalidate();
            }
        }

        @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (!foreground || !originPolicy.isTrusted(view.getUrl()) || pickerInFlight) {
                callback.onReceiveValue(null);
                return true;
            }
            cancelFileSelection();
            interruptCapture();
            fileCallback = callback;
            filePage = view.getUrl();
            Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] {
                    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                    "text/csv", "text/plain", "text/comma-separated-values", "application/csv", "application/pdf",
                    "application/zip", "application/x-zip-compressed", "application/octet-stream"});
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            try {
                pickerInFlight = true;
                filePicker.launch(intent);
            } catch (ActivityNotFoundException | SecurityException exception) {
                pickerInFlight = false;
                cancelFileSelection();
                notice(R.string.file_picker_unavailable);
            }
            return true;
        }
    }
}
