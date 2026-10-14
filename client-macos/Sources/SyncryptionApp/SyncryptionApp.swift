import AppKit
import UserNotifications
import SwiftUI
import SyncryptionAPI
import SyncryptionAppCore

/// The menu bar app. It has no Dock icon (`LSUIElement`); its windows open from the menu.
@main
struct SyncryptionApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        MenuBarExtra {
            MenuView(model: delegate.model)
        } label: {
            Image(systemName: delegate.model.hasProblem ? "exclamationmark.lock" : "lock.rotation")
        }
        .menuBarExtraStyle(.window)

        Window("Sync Status", id: "status") {
            StatusWindow(model: delegate.model)
        }
        .defaultSize(width: 920, height: 720)

        Window("Add Folder", id: "add") {
            AddFolderView(model: delegate.model)
        }
        .windowResizability(.contentSize)

        Window("Vault Syncryption Settings", id: "settings") {
            SettingsView(model: delegate.model)
        }
        .defaultSize(width: 860, height: 620)
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    #if DEBUG
    let model = Snapshot.demoModel() ?? AppModel()
    #else
    let model = AppModel()
    #endif

    func applicationDidFinishLaunching(_ notification: Notification) {
        FolderIcon.logo = NSImage(named: "Logo")
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        model.onPendingApproval = { folder, devices in
            let content = UNMutableNotificationContent()
            content.title = "Approve a device for \(folder.config.vaultName)?"
            content.body = devices.count == 1 ? "\(devices[0].name) is waiting. Compare its pairing code \(devices[0].code) before approving."
                : "\(devices.count) devices are waiting for approval."
            UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        }
        model.startAll()
        #if DEBUG
        Snapshot.runIfAsked(model)
        #endif
    }

    func applicationWillTerminate(_ notification: Notification) {
        model.stopAll()
    }
}

/// Bring the app forward so a window it opens gets the focus (a menu bar app isn't active).
@MainActor
func activate() {
    NSApp.activate()
}
