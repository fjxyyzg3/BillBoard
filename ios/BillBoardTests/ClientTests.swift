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
}
