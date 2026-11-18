import UIKit
import WebKit

@MainActor
final class ExportBridge: NSObject, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
    private let origin: TrustedOrigin
    private let file = ExportFile()
    private weak var presenter: UIViewController?
    private weak var picker: UIDocumentPickerViewController?
    private var saveReply: ((Any?, String?) -> Void)?
    private var expiry: Task<Void, Never>?
    private var finishing = false

    init(origin: TrustedOrigin, presenter: UIViewController) {
        self.origin = origin
        self.presenter = presenter
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler reply: @escaping (Any?, String?) -> Void) {
        let source = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.allows(message.frameInfo.request.url),
              origin.matches(scheme: source.protocol, host: source.host, port: source.port),
              let payload = message.body as? [String: Any], let action = payload["action"] as? String, !finishing
        else { reply(nil, "Export is unavailable"); return }

        if file.expired { finish("cancelled") }
        if action == "begin" {
            do {
                guard !finishing, let filename = payload["filename"] as? String, let size = payload["size"] as? Int else {
                    throw ExportFile.Failure.invalidFile
                }
                let id = try file.begin(filename: filename, bytes: size)
                expiry = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(ExportFile.lifetime)) } catch { return }
                    self?.checkExpiry()
                }
                reply(id, nil)
            } catch { reply(nil, "Export could not start") }
            return
        }

        guard let id = payload["id"] as? String, id == file.id, !finishing else { reply(nil, "Export ended"); return }
        do {
            switch action {
            case "append":
                guard let value = payload["bytes"] as? String, value.utf8.count <= 44_000,
                      let data = Data(base64Encoded: value) else { throw ExportFile.Failure.invalidFile }
                try file.append(id: id, data: data)
                reply(true, nil)
            case "save":
                guard let presenter, presenter.presentedViewController == nil, presenter.viewIfLoaded?.window != nil,
                      UIApplication.shared.applicationState == .active, saveReply == nil
                else { throw ExportFile.Failure.unavailable }
                let url = try file.prepareForSaving(id: id)
                let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
                picker.delegate = self
                picker.presentationController?.delegate = self
                self.picker = picker
                saveReply = reply
                presenter.present(picker, animated: true)
            case "cancel":
                finish("cancelled")
                reply(true, nil)
            default:
                reply(nil, "Unknown export action")
            }
        } catch {
            finish("failed")
            reply(nil, "Export could not be saved")
        }
    }

    func checkExpiry() {
        if file.expired { finish("cancelled") }
    }

    func cancel() { finish("cancelled") }

    private func finish(_ result: String) {
        guard !finishing, file.id != nil else { return }
        finishing = true
        expiry?.cancel()
        expiry = nil
        let complete = { [self] in
            try? file.clean()
            finishing = false
            let reply = saveReply
            saveReply = nil
            self.picker = nil
            reply?(result, nil)
        }
        if let picker, picker.presentingViewController != nil {
            picker.dismiss(animated: true, completion: complete)
        } else {
            complete()
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(urls.isEmpty ? "cancelled" : "saved")
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish("cancelled") }
    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish("cancelled") }
}
