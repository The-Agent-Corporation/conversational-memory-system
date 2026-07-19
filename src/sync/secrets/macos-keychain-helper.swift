import Foundation
import Security

// macOS Keychain helper for `MacosKeychainSecretStore`.
//
// Protocol: the parent process spawns this helper with argv == ["serve"]
// and no other arguments. Four extra inherited file descriptors carry a
// bounded private-pipe protocol:
//
//   fd 3 (read here)  control-in:   one length-prefixed JSON request per op
//   fd 4 (write here) control-out:  one length-prefixed JSON result per op
//   fd 5 (read here)  secret-in:    length-prefixed raw secret bytes,
//                                   present only when the request declares
//                                   `hasSecretInput`
//   fd 6 (write here) secret-out:   length-prefixed raw secret bytes,
//                                   present only when the request declares
//                                   `wantsSecretOutput` and the result is ok
//
// Every frame is `uint32be(length) || bytes`, bounded to 16 MiB. stdin and
// stdout are never used by the protocol. stderr carries at most one short
// content-free status line per fatal failure and never secret bytes,
// account labels beyond what the request itself already supplied, or
// stack traces containing decrypted data.
//
// Keychain items are created as non-synchronizable generic-password items
// scoped to this device: `kSecAttrSynchronizable = false` and
// `kSecAttrAccessible = kSecAttrAccessibleWhenUnlockedThisDeviceOnly`.
// There is no plaintext file or SQLite fallback anywhere in this helper:
// every operation either succeeds against the Keychain or returns a
// controlled error frame.

let lengthPrefixBytes = 4
let maxFrameBytes = 16 * 1024 * 1024

enum HelperError: Error {
    case frameTooLarge
    case truncatedFrame
    case malformedRequest
}

struct KeychainHelperRequest: Decodable {
    let requestId: String
    let operation: String
    let service: String
    let account: String
    let expectedVersion: Int?
    let newVersion: Int?
    let hasSecretInput: Bool
    let wantsSecretOutput: Bool
}

struct KeychainHelperResult: Encodable {
    let requestId: String
    let status: String
    let code: String?
    let version: Int?
    let byteLength: Int?
}

final class FileHandlePipe {
    let readHandle: FileHandle?
    let writeHandle: FileHandle?

    init(readFd: Int32?, writeFd: Int32?) {
        self.readHandle = readFd.map { FileHandle(fileDescriptor: $0, closeOnDealloc: false) }
        self.writeHandle = writeFd.map { FileHandle(fileDescriptor: $0, closeOnDealloc: false) }
    }

    func readFrame() throws -> Data {
        guard let handle = readHandle else { throw HelperError.malformedRequest }
        let prefix = try readExact(handle: handle, count: lengthPrefixBytes)
        let length = prefix.withUnsafeBytes { pointer -> UInt32 in
            pointer.load(as: UInt32.self).bigEndian
        }
        if length > UInt32(maxFrameBytes) { throw HelperError.frameTooLarge }
        return try readExact(handle: handle, count: Int(length))
    }

    func writeFrame(_ payload: Data) throws {
        guard let handle = writeHandle else { throw HelperError.malformedRequest }
        var length = UInt32(payload.count).bigEndian
        let prefix = Data(bytes: &length, count: lengthPrefixBytes)
        handle.write(prefix)
        if !payload.isEmpty {
            handle.write(payload)
        }
    }

    private func readExact(handle: FileHandle, count: Int) throws -> Data {
        if count == 0 { return Data() }
        var collected = Data()
        while collected.count < count {
            let chunk = handle.readData(ofLength: count - collected.count)
            if chunk.isEmpty { throw HelperError.truncatedFrame }
            collected.append(chunk)
        }
        return collected
    }
}

func versionedAccount(account: String, version: Int) -> String {
    // Every historical version is retained as its own non-synchronizable
    // item so rotation never overwrites the bytes a prior control-plane
    // decision may still depend on; only the pointer item's `version`
    // attribute advances atomically.
    return "\(account)#v\(version)"
}

func keychainQuery(service: String, account: String) -> [String: Any] {
    return [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false
    ]
}

func readCurrentVersion(service: String, account: String) -> Int? {
    var query = keychainQuery(service: service, account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data,
        let text = String(data: data, encoding: .utf8), let version = Int(text)
    else {
        return nil
    }
    return version
}

func writePointerItem(service: String, account: String, version: Int, create: Bool) -> OSStatus {
    let payload = Data(String(version).utf8)
    if create {
        var attributes = keychainQuery(service: service, account: account)
        attributes[kSecValueData as String] = payload
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        return SecItemAdd(attributes as CFDictionary, nil)
    }
    let query = keychainQuery(service: service, account: account)
    let update: [String: Any] = [kSecValueData as String: payload]
    return SecItemUpdate(query as CFDictionary, update as CFDictionary)
}

func writeSecretItem(service: String, account: String, version: Int, bytes: Data) -> OSStatus {
    var attributes = keychainQuery(service: service, account: versionedAccount(account: account, version: version))
    attributes[kSecValueData as String] = bytes
    attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(attributes as CFDictionary, nil)
}

func readSecretItem(service: String, account: String, version: Int) -> Data? {
    var query = keychainQuery(service: service, account: versionedAccount(account: account, version: version))
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess else { return nil }
    return item as? Data
}

func deleteAllVersions(service: String, account: String, throughVersion: Int) {
    var version = 1
    while version <= throughVersion {
        let query = keychainQuery(service: service, account: versionedAccount(account: account, version: version))
        SecItemDelete(query as CFDictionary)
        version += 1
    }
    SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
}

func handle(request: KeychainHelperRequest, pipe: FileHandlePipe) -> KeychainHelperResult {
    switch request.operation {
    case "create":
        if readCurrentVersion(service: request.service, account: request.account) != nil {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_ALREADY_EXISTS", version: nil, byteLength: nil)
        }
        guard let bytes = try? pipe.readFrame() else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE", version: nil, byteLength: nil)
        }
        let secretStatus = writeSecretItem(service: request.service, account: request.account, version: 1, bytes: bytes)
        guard secretStatus == errSecSuccess else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE", version: nil, byteLength: nil)
        }
        let pointerStatus = writePointerItem(service: request.service, account: request.account, version: 1, create: true)
        guard pointerStatus == errSecSuccess else {
            deleteAllVersions(service: request.service, account: request.account, throughVersion: 1)
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE", version: nil, byteLength: nil)
        }
        return KeychainHelperResult(requestId: request.requestId, status: "ok", code: nil, version: 1, byteLength: bytes.count)

    case "current_version":
        guard let version = readCurrentVersion(service: request.service, account: request.account) else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND", version: nil, byteLength: nil)
        }
        return KeychainHelperResult(requestId: request.requestId, status: "ok", code: nil, version: version, byteLength: nil)

    case "read":
        guard let currentVersion = readCurrentVersion(service: request.service, account: request.account) else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND", version: nil, byteLength: nil)
        }
        let version = request.expectedVersion ?? currentVersion
        guard let bytes = readSecretItem(service: request.service, account: request.account, version: version) else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_VERSION_NOT_FOUND", version: nil, byteLength: nil)
        }
        try? pipe.writeFrame(bytes)
        return KeychainHelperResult(requestId: request.requestId, status: "ok", code: nil, version: version, byteLength: bytes.count)

    case "rotate":
        guard let currentVersion = readCurrentVersion(service: request.service, account: request.account) else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND", version: nil, byteLength: nil)
        }
        guard let expectedVersion = request.expectedVersion, expectedVersion == currentVersion,
            let nextVersion = request.newVersion, nextVersion == currentVersion + 1
        else {
            // Expected-version mismatch: the item already on the Keychain
            // remains fully authoritative and untouched.
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_VERSION_STALE", version: nil, byteLength: nil)
        }
        guard let bytes = try? pipe.readFrame() else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE", version: nil, byteLength: nil)
        }
        let secretStatus = writeSecretItem(service: request.service, account: request.account, version: nextVersion, bytes: bytes)
        guard secretStatus == errSecSuccess else {
            // Only the new version's item write failed; the previously
            // current pointer and version item are never modified before
            // this point, so the prior version stays authoritative.
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE", version: nil, byteLength: nil)
        }
        let pointerStatus = writePointerItem(service: request.service, account: request.account, version: nextVersion, create: false)
        guard pointerStatus == errSecSuccess else {
            let query = keychainQuery(service: request.service, account: versionedAccount(account: request.account, version: nextVersion))
            SecItemDelete(query as CFDictionary)
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE", version: nil, byteLength: nil)
        }
        return KeychainHelperResult(requestId: request.requestId, status: "ok", code: nil, version: nextVersion, byteLength: bytes.count)

    case "delete":
        guard let currentVersion = readCurrentVersion(service: request.service, account: request.account) else {
            return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_NOT_FOUND", version: nil, byteLength: nil)
        }
        deleteAllVersions(service: request.service, account: request.account, throughVersion: currentVersion)
        return KeychainHelperResult(requestId: request.requestId, status: "ok", code: nil, version: nil, byteLength: nil)

    default:
        return KeychainHelperResult(requestId: request.requestId, status: "error", code: "SECRET_HELPER_FAILURE", version: nil, byteLength: nil)
    }
}

func serve() {
    let controlPipe = FileHandlePipe(readFd: 3, writeFd: 4)
    let secretPipe = FileHandlePipe(readFd: 5, writeFd: 6)

    guard let requestData = try? controlPipe.readFrame() else {
        FileHandle.standardError.write(Data("helper: malformed control frame\n".utf8))
        exit(1)
    }
    let decoder = JSONDecoder()
    guard let request = try? decoder.decode(KeychainHelperRequest.self, from: requestData) else {
        FileHandle.standardError.write(Data("helper: malformed request\n".utf8))
        exit(1)
    }

    let pipeForSecrets = request.hasSecretInput || request.wantsSecretOutput ? secretPipe : controlPipe
    let result = handle(request: request, pipe: pipeForSecrets)

    let encoder = JSONEncoder()
    guard let resultData = try? encoder.encode(result) else {
        FileHandle.standardError.write(Data("helper: result encode failure\n".utf8))
        exit(1)
    }
    try? controlPipe.writeFrame(resultData)
}

let arguments = CommandLine.arguments
if arguments.count == 2 && arguments[1] == "serve" {
    serve()
} else {
    FileHandle.standardError.write(Data("usage: macos-keychain-helper serve\n".utf8))
    exit(1)
}
