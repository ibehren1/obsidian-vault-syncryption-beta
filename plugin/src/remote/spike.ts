/**
 * SPIKE (docs/remote-only.md section 9): the Obsidian wiring for `StubAdapter`. Off until the
 * "enable" command is run on a device; it then covers only the `remote-only-spike` folder. The
 * key is a random one in `SecretStorage`, standing in for the keyring the design would use.
 */
import { getLinkpath, MarkdownView, Notice, TFile, type Plugin } from "obsidian";

import { fromHex, hex } from "../crypto/bytes";
import { StubAdapter, type EntryStore, type SealedEntry } from "./stub-adapter";
import { randomBytes } from "@noble/ciphers/utils.js";

export const SPIKE_FOLDER = "remote-only-spike";
const ENABLED = "syncryption-spike-enabled";
const KEY_ID = "syncryption-spike-key";
const DB_STORE = "entries";

function done<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
	});
}

class IndexedDbEntryStore implements EntryStore {
	private constructor(private readonly db: IDBDatabase) {}

	static async open(name: string): Promise<IndexedDbEntryStore> {
		const request = indexedDB.open(name, 1);
		request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
		return new IndexedDbEntryStore(await done(request));
	}

	private store(mode: IDBTransactionMode): IDBObjectStore {
		return this.db.transaction(DB_STORE, mode).objectStore(DB_STORE);
	}

	async get(path: string) {
		return (await done(this.store("readonly").get(path))) as SealedEntry | undefined;
	}
	async put(path: string, entry: SealedEntry) {
		await done(this.store("readwrite").put(entry, path));
	}
	async delete(path: string) {
		await done(this.store("readwrite").delete(path));
	}
	async paths() {
		return (await done(this.store("readonly").getAllKeys())).map(String);
	}
	close(): void {
		this.db.close();
	}
}

/** Undocumented: re-reads one file into the metadata cache. */
interface MetadataInternals {
	computeFileMetadataAsync?: (file: TFile) => Promise<void> | void;
}

export class RemoteOnlySpike {
	private stub: StubAdapter | null = null;
	private store: IndexedDbEntryStore | null = null;

	constructor(private readonly plugin: Plugin) {}

	private get app() {
		return this.plugin.app;
	}

	private get enabled(): boolean {
		return this.app.loadLocalStorage(ENABLED) === true;
	}

	/** Called first thing in `onload`, so Obsidian's reads go through the wrapper as early as possible. */
	async load(): Promise<void> {
		this.addCommands();
		if (this.enabled) await this.start();
	}

	private async start(): Promise<void> {
		if (this.stub) return;
		const store = await IndexedDbEntryStore.open(`syncryption-spike-${this.app.vault.getName()}`);
		const stub = new StubAdapter({ folder: SPIKE_FOLDER, store, onResource: (path) => this.rerender(path) });
		const uninstall = stub.install(this.app.vault.adapter);
		this.store = store;
		this.stub = stub;
		this.plugin.register(() => {
			uninstall();
			store.close();
			this.stub = null;
			this.store = null;
		});
		this.plugin.registerEvent(this.app.workspace.on("file-open", (file) => void this.warmEmbeds(file)));
		this.unlock();
		this.app.workspace.onLayoutReady(() => void this.reindex());
	}

	private unlock(): void {
		let key = this.app.secretStorage.getSecret(KEY_ID);
		if (!key) {
			key = hex(randomBytes(32));
			this.app.secretStorage.setSecret(KEY_ID, key);
		}
		this.stub?.unlock(fromHex(key));
	}

	private files(): TFile[] {
		return this.app.vault.getFiles().filter((f) => f.path.startsWith(`${SPIKE_FOLDER}/`));
	}

	private addCommands(): void {
		const when = (id: string, name: string, active: boolean, run: () => unknown) =>
			this.plugin.addCommand({
				id: `spike-${id}`,
				name: `Remote-only spike: ${name}`,
				checkCallback: (checking) => {
					if ((this.stub !== null) !== active) return false;
					if (!checking) void Promise.resolve(run()).catch((e) => new Notice(`Spike: ${String(e)}`));
					return true;
				},
			});
		when("enable", "enable on this device", false, async () => {
			this.app.saveLocalStorage(ENABLED, true);
			if (!(await this.app.vault.adapter.exists(SPIKE_FOLDER))) await this.app.vault.createFolder(SPIKE_FOLDER);
			await this.start();
			new Notice(`Spike on. Put test files in "${SPIKE_FOLDER}", then run "convert".`);
		});
		when("disable", "disable on this device (restore first)", true, () => {
			this.app.saveLocalStorage(ENABLED, null);
			new Notice("Spike off after the next restart. Run restore first, or the files stay stubs.");
		});
		when("convert", "convert the folder to stubs", true, () => this.convert());
		when("restore", "restore the folder to plain files", true, () => this.restore());
		when("lock", "lock", true, () => {
			this.stub?.lock();
			new Notice("Spike locked: remote-only reads now fail.");
		});
		when("unlock", "unlock", true, async () => {
			this.unlock();
			await this.reindex();
			new Notice("Spike unlocked.");
		});
		when("report", "report", true, () => this.report());
	}

	private async convert(): Promise<void> {
		const files = this.files();
		let n = 0;
		for (const file of files) if (await this.stub!.convert(file.path)) n++;
		// Files created or saved in Obsidian while the spike is on are already stubs.
		new Notice(`Spike: ${n} files converted to stubs, ${files.length - n} already were.`);
	}

	private async restore(): Promise<void> {
		let n = 0;
		for (const path of await this.store!.paths()) if (await this.stub!.restore(path)) n++;
		new Notice(`Spike: ${n} files restored.`);
	}

	private async report(): Promise<void> {
		const paths = await this.store!.paths();
		let plain = 0;
		for (const file of this.files()) if (((await this.stub!.diskSize(file.path)) ?? 0) > 0) plain++;
		const msg =
			`Spike: ${paths.length} files in the store, ${this.files().length} in the folder, ` +
			`${plain} non-empty on disk, ${this.stub!.locked ? "locked" : "unlocked"}.`;
		console.debug(msg);
		new Notice(msg);
	}

	/** Notes whose metadata came from an empty stub are read again through the wrapper. */
	private async reindex(): Promise<void> {
		const cache = this.app.metadataCache as typeof this.app.metadataCache & MetadataInternals;
		for (const file of this.files()) {
			if (file.extension !== "md" || !(await this.store?.get(file.path))) continue;
			const meta = cache.getFileCache(file);
			if (meta?.sections?.length) continue;
			await cache.computeFileMetadataAsync?.(file);
		}
	}

	/** Decrypts the opened note's embeds before they render. */
	private async warmEmbeds(file: TFile | null): Promise<void> {
		if (!file || !this.stub) return;
		for (const embed of this.app.metadataCache.getFileCache(file)?.embeds ?? []) {
			const target = this.app.metadataCache.getFirstLinkpathDest(getLinkpath(embed.link), file.path);
			if (target && this.stub.isRemote(target.path)) await this.stub.warm(target.path);
		}
	}

	/** A resource was decrypted after it was first asked for: render the views showing it again. */
	private rerender(path: string): void {
		const file = this.app.vault.getFileByPath(path);
		if (file) this.app.vault.trigger("modify", file);
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.view instanceof MarkdownView && leaf.view.getMode() === "preview") leaf.view.previewMode.rerender(true);
		});
	}
}
