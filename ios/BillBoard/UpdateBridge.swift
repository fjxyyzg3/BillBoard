import UIKit
import WebKit

struct InstalledAppVersion {
    let version: String
    let build: String
    private let buildSegments: [Int]

    init?(bundle: Bundle) {
        self.init(version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
                  build: bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
    }

    init?(version: String?, build: String?) {
        guard let version, version.utf8.count <= 14,
              version.range(of: #"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}\z"#, options: .regularExpression) != nil,
              let build, let buildSegments = Self.segments(build) else { return nil }
        self.version = version
        self.build = build
        self.buildSegments = buildSegments
    }

    func isOlder(than target: String) -> Bool {
        guard let targetSegments = Self.segments(target) else { return false }
        return buildSegments.lexicographicallyPrecedes(targetSegments)
    }

    private static func segments(_ value: String) -> [Int]? {
        guard value.utf8.count <= 10,
              value.range(of: #"^[1-9][0-9]{0,3}\.(?:0|[1-9][0-9]?)\.[1-9][0-9]?\z"#, options: .regularExpression) != nil
        else { return nil }
        return value.split(separator: ".").compactMap { Int($0) }
    }

    func installURL(_ value: String, targetBuild: String, expiresAt: Double, origin: TrustedOrigin, now: Date = .now) -> URL? {
        let action = URLQueryItem(name: "action", value: "download-manifest")
        let pathPrefix = "/api/ios/install/manifest/"
        guard isOlder(than: targetBuild), expiresAt.isFinite, expiresAt > now.timeIntervalSince1970 * 1_000,
              value.utf8.count <= 2_048, value.hasPrefix("itms-services://?"),
              let outer = URLComponents(string: value), outer.fragment == nil,
              let query = outer.queryItems, query.count == 2, query.contains(action),
              let inner = query.first(where: { $0.name == "url" })?.value,
              let manifest = URLComponents(string: inner), origin.allows(manifest.url),
              (manifest.port ?? 443) == origin.port, manifest.query == nil, manifest.fragment == nil,
              manifest.percentEncodedPath.hasPrefix(pathPrefix) else { return nil }
        let ticket = String(manifest.percentEncodedPath.dropFirst(pathPrefix.count))
        guard ticket.range(of: #"^[A-Za-z0-9_-]{39,1024}\z"#, options: .regularExpression) != nil,
              let trustedManifest = URL(string: pathPrefix + ticket, relativeTo: origin.url)?.absoluteURL
        else { return nil }
        var link = URLComponents()
        link.scheme = "itms-services"
        link.host = ""
        link.queryItems = [action, URLQueryItem(name: "url", value: trustedManifest.absoluteString)]
        return link.url
    }
}

extension TrustedOrigin {
    var iosInstallHelpURL: URL? {
        URL(string: "/help#ios-install", relativeTo: url)?.absoluteURL
    }
}

@MainActor
final class UpdateBridge: NSObject, WKScriptMessageHandlerWithReply {
    private let origin: TrustedOrigin
    private let installed: InstalledAppVersion
    private var opening = false

    init(origin: TrustedOrigin, installed: InstalledAppVersion) {
        self.origin = origin
        self.installed = installed
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler reply: @escaping (Any?, String?) -> Void) {
        let source = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.allows(message.frameInfo.request.url),
              origin.matches(scheme: source.protocol, host: source.host, port: source.port),
              let payload = message.body as? [String: Any], let command = payload["command"] as? String
        else { reply(nil, "Update is unavailable"); return }

        switch command {
        case "version" where payload.count == 1:
            reply(["version": installed.version, "build": installed.build], nil)
        case "install" where payload.count == 4:
            guard let value = payload["url"] as? String, let build = payload["build"] as? String,
                  let expiry = payload["expiresAt"] as? Double else { reply(false, nil); return }
            open(installed.installURL(value, targetBuild: build, expiresAt: expiry, origin: origin), reply: reply)
        case "safari" where payload.count == 1:
            open(origin.iosInstallHelpURL, reply: reply)
        default:
            reply(nil, "Unknown update command")
        }
    }

    private func open(_ url: URL?, reply: @escaping (Any?, String?) -> Void) {
        guard let url, !opening, UIApplication.shared.applicationState == .active else { reply(false, nil); return }
        opening = true
        UIApplication.shared.open(url, options: [:]) { [weak self] opened in
            self?.opening = false
            reply(opened, nil)
        }
    }
}
