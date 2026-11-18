import Foundation

struct TrustedOrigin {
    let url: URL
    let host: String
    let port: Int

    init?(_ value: String) {
        guard let parts = URLComponents(string: value), let url = parts.url,
              parts.scheme == "https", let host = parts.host, !host.isEmpty,
              parts.user == nil, parts.password == nil, parts.query == nil, parts.fragment == nil,
              parts.path.isEmpty || parts.path == "/" else { return nil }
        self.url = url
        self.host = host.lowercased()
        self.port = parts.port ?? 443
    }

    func allows(_ url: URL?) -> Bool {
        guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil, let host = parts.host else { return false }
        return matches(scheme: parts.scheme ?? "", host: host, port: parts.port ?? 443)
    }

    func matches(scheme: String, host: String, port: Int) -> Bool {
        scheme == "https" && host.lowercased() == self.host && (port == 0 ? 443 : port) == self.port
    }
}
