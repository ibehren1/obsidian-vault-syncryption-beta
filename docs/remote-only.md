# Remote-only devices

Status: **proposed**. Nothing here is implemented yet. A spike (section 9) decides whether
it goes ahead.

## 1. Goal
A remote-only device keeps no vault plaintext on disk. Note and attachment contents are
stored on the device only as ciphertext, in the same format the server stores, and the
plugin decrypts them in memory when Obsidian reads a file. Removing the device's key from
the vault leaves everything on the device useless: the device can no longer get the keyring,
so it can no longer decrypt its own copy.

The use cases:
- A lost or stolen laptop or phone: remove its key and the data on it stays closed.
- A shared vault: when a member leaves, removing their key cuts them off. They keep no
  readable copy, as long as their client followed the rules while they were a member
  (section 3).

Whether a key is remote-only is decided when it is approved into the vault. The rest of
Obsidian should not notice the difference.

## 2. Why the crypto already almost works
- The plugin never stores the VDK or the decrypted keyring. It keeps them in memory, and
  stores only a pin (`{version, sha256}`) for rollback checks ([crypto.md](crypto.md)
  section 6.4).
- The device's private key, in `SecretStorage`, decrypts only the keyring. The keyring lives
  on the server, which hands it out only to active devices of the vault.
- So a local copy that holds only server-format ciphertext (encrypted meta and chunks,
  [crypto.md](crypto.md) section 5) can't be opened once the server refuses the keyring.
  That happens as soon as the key is removed: removal deletes the device's sessions, and
  every later login returns `403 device_revoked` ([protocol.md](protocol.md) section 6).
- Removal already rotates the epoch ([crypto.md](crypto.md) section 8.4), so the device
  can't read anything written afterwards either.

No extra key from the server is needed. What a remote-only device must add is:
- it never writes plaintext content to disk,
- it never stores the keyring, and
- it stops using the keys it holds in memory when it can't reach the server for too long.

## 3. Threat model
**Protected after the key is removed:**
- A lost or stolen device, including someone reading its disk directly.
- A member who leaves a shared vault, as long as their client was the official plugin and
  it followed the rules below while they were a member.

**Not protected:**
- A member who copies data while still a member. While the vault is open the plaintext is
  on screen and in memory. They can copy and paste or export notes, read the VDK with the
  developer tools, save a keyring response together with the private key from
  `SecretStorage`, or run a modified plugin that ignores this policy. No client-side design
  can prevent that. Remote-only makes data on a device **revocable at rest**. It does not
  stop someone exfiltrating it.
- A device that is taken before its key is removed. Until removal, it can still log in.
- Paths. Remote-only uses stub files (section 6), so file and folder names stay in
  plaintext on the device's disk.

**Enforced by the server:** short sessions (the lease, section 5), and refusing the keyring
and all data to a removed key.

**Enforced only by a well-behaved client:** keeping plaintext off disk, locking when the
lease runs out, and wiping on removal.

### 3.1 Plaintext outside the plugin's control
Obsidian and other plugins keep their own copies of some content. The plugin can check for
some of these and wipe them on removal, but none of this is cryptographic:
- **Obsidian's metadata cache** (IndexedDB) stores headings, links, tags, frontmatter and
  section data in plaintext.
- The **File Recovery** core plugin stores full plaintext snapshots in IndexedDB. A
  remote-only device refuses to start syncing while it is enabled.
- **`workspace*.json`** lists open and recent files.
- **Other plugins** may cache content (for example a full-text search index), or read files
  from the disk directly. Plugins that read the disk see the empty stubs instead of the
  content.
- **The operating system** may write memory to swap or crash dumps.

## 4. The policy
- The policy is a field in the device's entry of the signed keyring plaintext
  ([crypto.md](crypto.md) section 6.1): `"policy": "remote-only"`. If it's absent, the device
  is a full device. The device being approved reads its policy from the keyring it opens.
  The server is untrusted for integrity, so a flag held only on the server could be removed
  by a malicious server, making the device write plaintext.
- The approving device sets it, through a choice in the approval UI ("Approve as
  remote-only").
- Clients check, while they follow the keyring chain ([crypto.md](crypto.md) section 6.4),
  that:
  - only a full device sets, changes or removes a policy, and
  - a keyring update signed by a remote-only device changes no `devices` entry except
    through epoch rotation, and doesn't change the recovery key.
- **A remote-only device can't manage the vault.** It can't approve or remove keys, set or
  replace the recovery key, or replace its own key. A recovery key it set would give it a
  lasting copy of the VDK. The client hides these actions, the server refuses them
  (`403 remote_only`), and other clients reject keyrings that break the rules above.
- The server keeps a copy (`devices.remote_only`) so it can shorten the sessions and refuse
  management calls. Approval takes an optional body `{"remoteOnly": true}`. The field is
  optional, so `PROTOCOL_VERSION` stays 1.

## 5. Lease and grace period
- A remote-only device's sessions last 5 minutes (`SESSION_TTL` is 1 hour for full devices).
  The device logs in again before its session expires, through the long-poll loop that
  already runs. Each successful login renews the lease.
- The long-poll checks the session again when it wakes, so a removed device is cut off at
  once, not at the end of the current 25 s wait.
- **Grace period:** how long the device may go without renewing its lease before it locks.
  The server administrator sets it: the default is 24 hours, and it can be changed per vault
  on `/admin` (`vaults.remote_only_grace`, `NULL` meaning the default). The server sends it
  in the `/auth/verify` response. The value comes from a server that isn't trusted, which is
  acceptable: a server can only lengthen a lock that depends on the client anyway, and it
  still can't decrypt anything.
- **Locking** happens when the grace period passes without a renewal. The device:
  - drops the keyring, the VDK and any decrypted content from memory,
  - closes the open remote-only files, and
  - makes reads fail and shows the vault as locked.

  It unlocks at the next successful login.
- **A cold start offline stays locked.** The keyring is never on disk, so with no server
  there is nothing to decrypt with. This is what makes the data useless after removal.
- **On `403 device_revoked`** the device:
  - wipes its plugin database,
  - deletes the stubs,
  - clears Obsidian's metadata cache, as far as it can, and
  - shows "This device was removed from the vault."

  It does this only when the official plugin is the one running.

## 6. Presenting files to Obsidian: stub files
Obsidian reads `configDir` (`app.json`, `community-plugins.json`, the plugins' `main.js`)
from disk before any plugin loads, so **`configDir` stays as normal files**. Remote-only
covers notes and attachments only. `configDir` syncs as on a full device, in plaintext,
with the usual exclude list.

For every note and attachment:
- A **zero-byte stub** sits at the file's real path. Obsidian's startup scan builds the file
  tree from the stubs.
- The plugin wraps `app.vault.adapter` and serves the real content from its encrypted
  store. It wraps `read`, `readBinary`, `write`, `writeBinary`, `append`, `appendBinary`,
  `process`, `stat` (the real size and times), `copy`, `rename`, `remove`, `trashSystem`,
  `trashLocal` and `getResourcePath`. For images, PDFs, audio and video,
  `getResourcePath` returns a `blob:` URL.
- Writes go only to the store. The stub stays empty.
- Paths in `configDir` go to the real adapter unchanged.
- After the plugin loads, it makes Obsidian index the files again, because the startup
  index saw only empty stubs.
- While locked, reads of remote-only files fail. The stubs stay, so the tree still shows.

The alternative, files that exist only in memory with nothing on disk, would also hide the
paths. But it needs Obsidian's private file-tree internals, on desktop and on mobile, and
those can change in any update. Stubs need only the documented `DataAdapter` methods. The
methods are wrapped, which is still fragile, but it is far less code.

## 7. Local store
The remote-only store goes in the same IndexedDB database as the rest of the plugin's
state ([architecture.md](architecture.md)):
- `blobs`: server-format objects (encrypted meta and chunks), keyed by blob id. They are
  filled on pull and opened on read.
- `files` and `outbox` keyed by `fileId`, not by path. The path is only in the encrypted
  meta, and no plaintext hash is stored.
- A local edit is sealed with the current epoch when it is written, and stored as a pending
  revision. An offline edit therefore never reaches the disk in plaintext.
- Decrypted content may be kept in a small in-memory cache, only while the lease is valid.

The sync engine reads and writes this store through a `VaultFs` of its own, so a sync
doesn't go through the disk.

## 8. Changes by component
**Backend:**
- Migration 7: `devices.remote_only` and `vaults.remote_only_grace`.
- The approve body.
- The short session lifetime, and `graceSeconds` in `/auth/verify`.
- The long-poll checks the session again when it wakes.
- `403 remote_only` on approve, remove, recovery and key replacement.
- The grace setting on `/admin`.

**Plugin:**
- The keyring `policy` field and the chain rules, with test vectors.
- The approval choice.
- `device_revoked` handling. Today the plugin treats a removed key as a generic error and
  keeps retrying. This part is useful for every device.
- The lease manager, locking and the wipe.
- The encrypted store and its `VaultFs`.
- The adapter wrapper and stubs.

## 9. Spike
Before any of this is built, a throwaway spike checks that wrapping the adapter works, on
desktop, iOS and Android:
- the file tree, opening, editing and saving notes,
- rename, move and delete,
- the metadata cache, links, backlinks, tags and search,
- images, PDFs, audio and video through `blob:` URLs,
- Canvas and Bases,
- that Obsidian's own reads and writes all go through the wrapped methods (none read the
  disk directly),
- that the file watcher doesn't treat a stub as a change that overwrites the store,
- start-up with the vault locked.

The results go here, with a go or no-go decision.

### 9.1 Code reading (Obsidian 1.14.4 desktop `app.js`)
These were checked in the app bundle before any testing on a device:
- **`Vault.read`, `readBinary`, `cachedRead`, `modify`, `process` and `copy`** call
  `this.adapter.<method>(path)` on the adapter instance. Replacing the methods on that
  instance catches them. `cachedRead` is served from `Vault`'s own in-memory content cache
  when it can be, and that cache is filled from those reads.
- **The metadata cache** reads notes through `vault.readBinary`, so it gets the decrypted
  content. It reuses a cached entry when the file's `mtime` and `size` match. Those come
  from the disk, which means the stub (size 0). A write through the wrapper gives the stub
  the new `mtime`, so Obsidian sees the change and indexes it again.
- **After a write**, the desktop and mobile adapters both `stat` the file on disk
  (`reconcileInternalFile`) and update `TFile.stat` from that. So `TFile.stat.size` is 0
  for stubs. The wrapped `adapter.stat` returns the real size, but `TFile.stat` doesn't use
  it. The effects are cosmetic, plus a sync scan that hashes these files every time.
- **`getResourcePath` is synchronous.** Electron's `app://` protocol is handled in the main
  process, and Obsidian doesn't register a service worker, so a plugin can't serve
  decrypted bytes behind a URL on demand. The spike returns a `blob:` URL once the file is
  decrypted. On a cache miss it returns the stub's URL (empty), decrypts in the background
  and asks the views to render again. It also decrypts a note's embeds when the note is
  opened.
- **`getFullPath`** (the real path on disk) is used outside the adapter only for "Copy path"
  and opening a file in another app. Those see the stub.

### 9.2 Spike build
- `plugin/src/remote/stub-adapter.ts` holds the wrapper. It has unit tests in
  `tests/stub-adapter.test.ts`.
- `plugin/src/remote/spike.ts` connects it to Obsidian. It covers only the
  `remote-only-spike` folder, and stays off until the "Remote-only spike: enable on this
  device" command is run on that device.
- The key is random and kept in `SecretStorage`, standing in for the keyring.
- The store keys entries by path.
- The spike isn't connected to sync. Notes in the folder still sync through the Vault API,
  which now returns the decrypted content.

### 9.3 Manual checks (desktop, iOS, Android)
1. Run "enable", then put notes, images, a PDF, an audio file, a canvas and a base in
   `remote-only-spike`.
2. Run "convert", then "report". Every file should be empty on disk.
3. Open, edit and save notes. Check links, backlinks, tags, search, embeds, Canvas and
   Bases.
4. Rename, move and delete files and folders, both inside the folder and into and out of
   it. Run "report" after each step.
5. Restart Obsidian. Check that the content and the metadata are still right.
6. Run "lock". Opening a remote-only note should fail, and the rest of the vault should
   still work. Then run "unlock".
7. Run "restore", then "disable".

### 9.4 Results
**Desktop (macOS, 2026-10-07, plugin 0.1.14):**
- Every file in the folder was 0 bytes on disk (`ls -l`).
- "convert" reported no files converted. This is expected for files created or saved in
  Obsidian while the spike is on, because those are written as stubs straight away. The
  notice now also counts the files that already were stubs (0.1.15).
- Opening, closing and editing notes worked.
- After "lock", the files couldn't be read. After "unlock", they could be read again.
- "restore" put the files back as normal files.

**Desktop (macOS, 2026-10-07, plugin 0.1.15):** the rest of 9.3 passed as well:
- rename and move, inside the folder and into and out of it,
- restarting Obsidian,
- links, backlinks, tags and search,
- embedded images, PDFs and audio,
- Canvas and Bases.

**Not checked yet:** iOS and Android. iOS waits for a build BRAT can install. There is no Android device; the Android emulator is an option.
