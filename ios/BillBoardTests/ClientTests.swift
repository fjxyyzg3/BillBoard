import Foundation
import Testing
@testable import BillBoard

@MainActor
struct ClientTests {
    private let filename = "billboard-records_2026-01-01_2026-01-02.xlsx"

    @Test func restrictsTheLedgerOrigin() throws {
        let origin = try #require(TrustedOrigin("https://billboard.invalid"))
        #expect(origin.allows(URL(string: "https://billboard.invalid/records/import")))
        #expect(origin.matches(scheme: "https", host: "billboard.invalid", port: 0))
        #expect(!origin.allows(URL(string: "http://billboard.invalid/records")))
        #expect(!origin.allows(URL(string: "https://billboard.invalid:444/records")))
        #expect(!origin.allows(URL(string: "https://billboard.invalid.example/records")))
        #expect(TrustedOrigin("https://billboard.invalid/help") == nil)
    }

    @Test func readsInstalledVersionAndBuildFromTheAppBundle() throws {
        let bundle = Bundle(for: LedgerViewController.self)
        let installed = try #require(InstalledAppVersion(bundle: bundle))
        #expect(installed.version == bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        #expect(installed.build == bundle.object(forInfoDictionaryKey: "CFBundleVersion") as? String)
    }

    @Test func comparesBuildSegmentsNumerically() throws {
        let installed = try #require(InstalledAppVersion(version: "1.68.1", build: "1.9.2"))
        #expect(installed.isOlder(than: "1.10.1"))
        #expect(installed.isOlder(than: "2.0.1"))
        #expect(!installed.isOlder(than: "1.9.2"))
        #expect(!installed.isOlder(than: "1.9.1"))
        #expect(!installed.isOlder(than: "1.09.3"))
        #expect(!installed.isOlder(than: "1.10.0"))
        #expect(!installed.isOlder(than: "1.10"))
    }

    @Test func acceptsOnlyFreshInstallLinksForANewerBuild() throws {
        let installed = try #require(InstalledAppVersion(version: "1.68.1", build: "1.1.1"))
        let origin = try #require(TrustedOrigin("https://billboard.invalid:8443"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let expiry = now.timeIntervalSince1970 * 1_000 + 5_000
        let ticket = String(repeating: "a", count: 64)
        let manifest = "https://billboard.invalid:8443/api/ios/install/manifest/\(ticket)"
        let valid = "itms-services://?action=download-manifest&url=https%3A%2F%2Fbillboard.invalid%3A8443%2Fapi%2Fios%2Finstall%2Fmanifest%2F\(ticket)"
        let handoff = try #require(installed.installURL(valid, targetBuild: "1.1.2", expiresAt: expiry, origin: origin, now: now))
        #expect(URLComponents(url: handoff, resolvingAgainstBaseURL: false)?.queryItems?.last?.value == manifest)
        #expect(installed.installURL(valid, targetBuild: "1.1.1", expiresAt: expiry, origin: origin, now: now) == nil)
        #expect(installed.installURL(valid, targetBuild: "1.1.2", expiresAt: expiry - 5_000, origin: origin, now: now) == nil)
        #expect(installed.installURL(valid, targetBuild: "1.1.2", expiresAt: .infinity, origin: origin, now: now) == nil)

        let rejectedManifests = [
            "https://other.invalid:8443/api/ios/install/manifest/\(ticket)",
            "https://billboard.invalid/api/ios/install/manifest/\(ticket)",
            "http://billboard.invalid:8443/api/ios/install/manifest/\(ticket)",
            "https://user@billboard.invalid:8443/api/ios/install/manifest/\(ticket)",
            "https://billboard.invalid:8443/api/ios/install/package/\(ticket)",
            manifest + "?extra=1",
            manifest + "#fragment",
            manifest + "/extra",
            manifest + "%2Fextra",
        ]
        for value in rejectedManifests {
            let link = try installLink(manifest: value)
            #expect(installed.installURL(link, targetBuild: "1.1.2", expiresAt: expiry, origin: origin, now: now) == nil)
        }

        let rejectedLinks = [
            valid + "&action=download-manifest",
            valid + "&extra=1",
            valid + "#fragment",
            valid.replacingOccurrences(of: "download-manifest", with: "download"),
            valid.replacingOccurrences(of: "itms-services://?", with: "itms-services://other.invalid?"),
            valid.replacingOccurrences(of: "itms-services://?", with: "itms-services:///path?"),
        ]
        for link in rejectedLinks {
            #expect(installed.installURL(link, targetBuild: "1.1.2", expiresAt: expiry, origin: origin, now: now) == nil)
        }
        #expect(origin.iosInstallHelpURL?.absoluteString == "https://billboard.invalid:8443/help#ios-install")
    }

    @Test func boundsTheTransferAndClearsInterruptedFilesAtStartup() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let export = ExportFile(directory: directory)
        #expect(throws: ExportFile.Failure.self) {
            try export.begin(filename: filename, bytes: ExportFile.maximumBytes + 1)
        }
        #expect(throws: ExportFile.Failure.self) { try export.begin(filename: "../statement.xlsx", bytes: 2) }
        let id = try export.begin(filename: filename, bytes: 2)
        #expect(throws: ExportFile.Failure.self) { try export.begin(filename: filename, bytes: 2) }
        #expect(throws: ExportFile.Failure.self) { try export.prepareForSaving(id: id) }
        try export.append(id: id, data: Data([1, 2]))
        let file = try export.prepareForSaving(id: id)
        #expect(try Data(contentsOf: file) == Data([1, 2]))

        let restarted = ExportFile(directory: directory)
        #expect(!FileManager.default.fileExists(atPath: file.path))
        let next = try restarted.begin(filename: filename, bytes: 3)
        try restarted.append(id: next, data: Data([3]))
        try restarted.clean()
        #expect(!FileManager.default.fileExists(atPath: directory.path))
    }

    private func installLink(manifest: String) throws -> String {
        var link = URLComponents()
        link.scheme = "itms-services"
        link.host = ""
        link.queryItems = [URLQueryItem(name: "action", value: "download-manifest"), URLQueryItem(name: "url", value: manifest)]
        return try #require(link.url).absoluteString
    }
}
