import AppKit
import ApplicationServices
import Foundation

struct Result: Encodable {
    let ok: Bool
    var text: String? = nil
    var error: String? = nil

    static func success(_ text: String) -> Result { Result(ok: true, text: text) }
    static func failure(_ error: String) -> Result { Result(ok: false, error: error) }
}

func respond(_ result: Result) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(result) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    } else {
        FileHandle.standardOutput.write(Data("{\"ok\":false,\"error\":\"unavailable\"}\n".utf8))
    }
    exit(0)
}

func readSelection() -> Never {
    guard AXIsProcessTrusted() else { respond(.failure("permission-required")) }
    guard let frontmost = NSWorkspace.shared.frontmostApplication,
          let bundleId = frontmost.bundleIdentifier,
          !bundleId.localizedCaseInsensitiveContains("fremkit") else {
        respond(.failure("no-selection"))
    }

    let application = AXUIElementCreateApplication(frontmost.processIdentifier)
    AXUIElementSetMessagingTimeout(application, 1.0)
    var focusedValue: CFTypeRef?
    let focusedError = AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focusedValue)
    guard focusedError == .success,
          let focusedValue,
          CFGetTypeID(focusedValue) == AXUIElementGetTypeID() else {
        respond(.failure(focusedError == .apiDisabled ? "permission-required" : "no-selection"))
    }

    let focused = focusedValue as! AXUIElement
    var subroleValue: CFTypeRef?
    if AXUIElementCopyAttributeValue(focused, kAXSubroleAttribute as CFString, &subroleValue) == .success,
       let subrole = subroleValue as? String,
       subrole == (kAXSecureTextFieldSubrole as String) {
        respond(.failure("secure-field"))
    }

    var selectionValue: CFTypeRef?
    let selectionError = AXUIElementCopyAttributeValue(focused, kAXSelectedTextAttribute as CFString, &selectionValue)
    guard selectionError == .success, let text = selectionValue as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        respond(.failure(selectionError == .apiDisabled ? "permission-required" : "no-selection"))
    }
    respond(.success(text))
}

guard CommandLine.arguments.dropFirst().first == "read" else { respond(.failure("unavailable")) }
readSelection()
