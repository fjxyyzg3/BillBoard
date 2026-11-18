import Foundation

@MainActor
final class ExportFile {
    static let maximumBytes = 32 * 1024 * 1024
    static let maximumChunkBytes = 32 * 1024
    static let lifetime: TimeInterval = 10 * 60

    enum Failure: Error {
        case unavailable, invalidFile, expired
    }

    private struct Transfer {
        let id: String
        let url: URL
        let size: Int
        let expiry: Date
        var handle: FileHandle?
        var written = 0
    }

    private let directory: URL
    private var transfer: Transfer?

    init(directory: URL = FileManager.default.temporaryDirectory.appendingPathComponent("BillBoardExports", isDirectory: true)) {
        self.directory = directory
        try? clean()
    }

    var id: String? { transfer?.id }
    var expired: Bool { transfer.map { $0.expiry <= Date() } ?? false }

    func begin(filename: String, bytes: Int) throws -> String {
        guard transfer == nil else { throw Failure.unavailable }
        guard bytes > 0, bytes <= Self.maximumBytes,
              filename.utf8.count == "billboard-records_2000-01-01_2000-01-01.xlsx".utf8.count,
              filename.range(of: #"^billboard-records_[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}-[0-9]{2}-[0-9]{2}\.xlsx$"#,
                             options: .regularExpression) != nil else { throw Failure.invalidFile }
        try clean()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
        let url = directory.appendingPathComponent(filename)
        guard FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.protectionKey: FileProtectionType.complete])
        else { throw Failure.unavailable }
        let id = UUID().uuidString
        transfer = Transfer(id: id, url: url, size: bytes, expiry: Date().addingTimeInterval(Self.lifetime),
                            handle: try FileHandle(forWritingTo: url))
        return id
    }

    func append(id: String, data: Data) throws {
        guard var active = transfer, active.id == id, let handle = active.handle else { throw Failure.invalidFile }
        guard !expired else { throw Failure.expired }
        guard !data.isEmpty, data.count <= Self.maximumChunkBytes, data.count <= active.size - active.written else {
            throw Failure.invalidFile
        }
        try handle.write(contentsOf: data)
        active.written += data.count
        transfer = active
    }

    func prepareForSaving(id: String) throws -> URL {
        guard var active = transfer, active.id == id, let handle = active.handle,
              active.written == active.size else { throw Failure.invalidFile }
        guard !expired else { throw Failure.expired }
        try handle.close()
        active.handle = nil
        transfer = active
        return active.url
    }

    func clean() throws {
        try? transfer?.handle?.close()
        transfer = nil
        do { try FileManager.default.removeItem(at: directory) }
        catch let error as CocoaError where error.code == .fileNoSuchFile { return }
    }
}
