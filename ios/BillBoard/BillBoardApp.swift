import SwiftUI
import UIKit
import WebKit

@main
struct BillBoardApp: App {
    var body: some Scene {
        WindowGroup { LedgerHost() }
    }
}

private struct LedgerHost: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> LedgerViewController { LedgerViewController() }
    func updateUIViewController(_ controller: LedgerViewController, context: Context) {}
}

@MainActor
final class LedgerViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private let origin = TrustedOrigin(Bundle.main.object(forInfoDictionaryKey: "BillBoardOrigin") as? String ?? "")
    private var web: WKWebView?
    private var bridge: ExportBridge?
    private let errorView = UIStackView()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        if let origin {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .default()
            let bridge = ExportBridge(origin: origin, presenter: self)
            configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "billboardExport")
            self.bridge = bridge
            let web = WKWebView(frame: .zero, configuration: configuration)
            self.web = web
            web.navigationDelegate = self
            web.uiDelegate = self
            web.allowsBackForwardNavigationGestures = true
            web.translatesAutoresizingMaskIntoConstraints = false
            view.addSubview(web)
            NSLayoutConstraint.activate([
                web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                web.topAnchor.constraint(equalTo: view.topAnchor),
                web.bottomAnchor.constraint(equalTo: view.bottomAnchor)
            ])
        }
        prepareErrorView()
        NotificationCenter.default.addObserver(self, selector: #selector(checkExportExpiry),
                                               name: UIApplication.didBecomeActiveNotification, object: nil)
        openLedger()
    }

    private func prepareErrorView() {
        let message = UILabel()
        message.text = NSLocalizedString("load_failed", comment: "Ledger could not be opened")
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.textAlignment = .center
        message.numberOfLines = 0
        let retry = UIButton(type: .system)
        retry.setTitle(NSLocalizedString("retry", comment: "Try opening the ledger again"), for: .normal)
        retry.addTarget(self, action: #selector(openLedger), for: .touchUpInside)
        errorView.axis = .vertical
        errorView.spacing = 12
        errorView.addArrangedSubview(message)
        errorView.addArrangedSubview(retry)
        errorView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(errorView)
        NSLayoutConstraint.activate([
            errorView.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            errorView.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            errorView.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.86),
            retry.heightAnchor.constraint(greaterThanOrEqualToConstant: 44)
        ])
    }

    @objc private func openLedger() {
        guard let origin, let web else { showLoadFailure(); return }
        errorView.isHidden = true
        web.isHidden = false
        web.load(URLRequest(url: origin.url, timeoutInterval: 30))
    }

    @objc private func checkExportExpiry() { bridge?.checkExpiry() }

    private func showLoadFailure() {
        bridge?.cancel()
        web?.isHidden = true
        errorView.isHidden = false
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard origin?.allows(navigationAction.request.url) == true, navigationAction.targetFrame != nil else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { bridge?.cancel() }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showLoadFailure() }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled { showLoadFailure() }
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { showLoadFailure() }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor source: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let allowed = type == .microphone && frame.isMainFrame && origin?.allows(frame.request.url) == true
            && origin?.matches(scheme: source.protocol, host: source.host, port: source.port) == true
        // WebKit checks the app's system microphone permission before asking this delegate.
        decisionHandler(allowed ? .grant : .deny)
    }
}
