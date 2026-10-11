import { describe, expect, it } from "vitest";

import { LockedError, MemoryEntryStore, StubAdapter, type WrappedAdapter } from "../src/remote/stub-adapter";

const enc = new TextEncoder();
const dec = new TextDecoder();
const KEY = new Uint8Array(32).fill(7);

/** A disk like `DataAdapter` sees it, with only the methods the wrapper replaces. */
class FakeDisk implements WrappedAdapter {
	readonly files = new Map<string, { data: Uint8Array; mtime: number; ctime: number }>();
	readonly folders = new Set<string>();

	put(path: string, text: string, mtime = 1000): void {
		this.files.set(path, { data: enc.encode(text), mtime, ctime: mtime });
	}
	text(path: string): string | undefined {
		const f = this.files.get(path);
		return f && dec.decode(f.data);
	}

	async read(path: string) {
		return dec.decode(new Uint8Array(await this.readBinary(path)));
	}
	async readBinary(path: string) {
		const f = this.files.get(path);
		if (!f) throw new Error(`ENOENT ${path}`);
		return f.data.slice().buffer;
	}
	async write(path: string, data: string, options?: { mtime?: number; ctime?: number }) {
		await this.writeBinary(path, enc.encode(data).buffer, options);
	}
	async writeBinary(path: string, data: ArrayBuffer, options?: { mtime?: number; ctime?: number }) {
		const mtime = options?.mtime ?? 5000;
		this.files.set(path, { data: new Uint8Array(data.slice(0)), mtime, ctime: options?.ctime ?? mtime });
	}
	async append(path: string, data: string) {
		await this.write(path, (this.text(path) ?? "") + data);
	}
	async appendBinary(path: string, data: ArrayBuffer) {
		await this.append(path, dec.decode(data));
	}
	async process(path: string, fn: (data: string) => string) {
		const out = fn(this.text(path) ?? "");
		await this.write(path, out);
		return out;
	}
	async stat(path: string) {
		const f = this.files.get(path);
		if (f) return { type: "file" as const, mtime: f.mtime, ctime: f.ctime, size: f.data.length };
		return this.folders.has(path) ? { type: "folder" as const, mtime: 0, ctime: 0, size: 0 } : null;
	}
	async copy(from: string, to: string) {
		this.files.set(to, { ...this.files.get(from)! });
	}
	async rename(from: string, to: string) {
		for (const [p, f] of [...this.files]) {
			if (p === from || p.startsWith(`${from}/`)) {
				this.files.delete(p);
				this.files.set(to + p.slice(from.length), f);
			}
		}
		if (this.folders.delete(from)) this.folders.add(to);
	}
	async remove(path: string) {
		this.files.delete(path);
	}
	async rmdir(path: string) {
		for (const p of [...this.files.keys()]) if (p.startsWith(`${path}/`)) this.files.delete(p);
		this.folders.delete(path);
	}
	async trashSystem(path: string) {
		await this.rmdir(path);
		this.files.delete(path);
		return true;
	}
	async trashLocal(path: string) {
		await this.trashSystem(path);
	}
	getResourcePath(path: string) {
		return `app://disk/${path}`;
	}
}

function setup() {
	const disk = new FakeDisk();
	const store = new MemoryEntryStore();
	const created: string[] = [];
	const revoked: string[] = [];
	const ready: string[] = [];
	const stub = new StubAdapter({
		folder: "R",
		store,
		onResource: (p) => ready.push(p),
		urls: {
			create: () => {
				created.push(`blob:${created.length}`);
				return created[created.length - 1]!;
			},
			revoke: (u) => revoked.push(u),
		},
	});
	const adapter = disk as WrappedAdapter;
	const uninstall = stub.install(adapter);
	stub.unlock(KEY);
	return { disk, store, stub, adapter, uninstall, created, revoked, ready };
}

function storedBytes(store: MemoryEntryStore): string {
	return [...store.entries.values()].map((e) => dec.decode(e.data)).join("|");
}

describe("StubAdapter (spike)", () => {
	it("keeps remote-only content only in the store, as ciphertext, and leaves empty stubs", async () => {
		const { disk, store, adapter } = setup();
		await adapter.write("R/note.md", "secret plan", { mtime: 2000 });
		expect(disk.text("R/note.md")).toBe("");
		expect(disk.files.get("R/note.md")!.mtime).toBe(2000);
		expect(storedBytes(store)).not.toContain("secret");
		expect(await adapter.read("R/note.md")).toBe("secret plan");
		expect(await adapter.stat("R/note.md")).toMatchObject({ size: 11, mtime: 2000 });
	});

	it("passes other paths through", async () => {
		const { disk, store, adapter } = setup();
		await adapter.write("plain.md", "hello");
		expect(disk.text("plain.md")).toBe("hello");
		expect(store.entries.size).toBe(0);
	});

	it("converts and restores files on disk", async () => {
		const { disk, store, stub, adapter } = setup();
		disk.put("R/a.md", "alpha", 1234);
		expect(await stub.convert("R/a.md")).toBe(true);
		expect(disk.text("R/a.md")).toBe("");
		expect(await stub.convert("R/a.md")).toBe(false);
		expect(await adapter.read("R/a.md")).toBe("alpha");
		expect(await stub.restore("R/a.md")).toBe(true);
		expect(disk.text("R/a.md")).toBe("alpha");
		expect(disk.files.get("R/a.md")!.mtime).toBe(1234);
		expect(store.entries.size).toBe(0);
	});

	it("appends and processes through the store", async () => {
		const { disk, adapter } = setup();
		await adapter.write("R/a.md", "one");
		await adapter.append("R/a.md", " two");
		expect(await adapter.process("R/a.md", (s) => s.toUpperCase())).toBe("ONE TWO");
		expect(await adapter.read("R/a.md")).toBe("ONE TWO");
		expect(disk.text("R/a.md")).toBe("");
	});

	it("fails reads and writes while locked, and serves them again after unlock", async () => {
		const { stub, adapter } = setup();
		await adapter.write("R/a.md", "x");
		stub.lock();
		await expect(adapter.read("R/a.md")).rejects.toBeInstanceOf(LockedError);
		await expect(adapter.write("R/a.md", "y")).rejects.toBeInstanceOf(LockedError);
		stub.unlock(KEY);
		expect(await adapter.read("R/a.md")).toBe("x");
	});

	it("can't open the store with another key", async () => {
		const { stub, adapter } = setup();
		await adapter.write("R/a.md", "x");
		stub.unlock(new Uint8Array(32).fill(8));
		await expect(adapter.read("R/a.md")).rejects.toThrow();
	});

	it("renames files and folders within, into and out of the folder", async () => {
		const { disk, store, adapter } = setup();
		await adapter.write("R/a.md", "a");
		await adapter.rename("R/a.md", "R/b.md");
		expect(await adapter.read("R/b.md")).toBe("a");
		expect(await store.get("R/a.md")).toBeUndefined();

		disk.folders.add("R/sub");
		await adapter.write("R/sub/c.md", "c");
		await adapter.rename("R/sub", "R/moved");
		expect(await adapter.read("R/moved/c.md")).toBe("c");
		expect(disk.text("R/moved/c.md")).toBe("");

		await adapter.rename("R/b.md", "out.md");
		expect(disk.text("out.md")).toBe("a");
		expect(await store.get("R/b.md")).toBeUndefined();

		disk.put("in.md", "inbound marker");
		await adapter.rename("in.md", "R/in.md");
		expect(disk.text("R/in.md")).toBe("");
		expect(await adapter.read("R/in.md")).toBe("inbound marker");
		expect(storedBytes(store)).not.toContain("inbound");
	});

	it("copies into the store and out of it", async () => {
		const { disk, adapter } = setup();
		await adapter.write("R/a.md", "a");
		await adapter.copy("R/a.md", "R/b.md");
		await adapter.copy("R/a.md", "c.md");
		expect(await adapter.read("R/b.md")).toBe("a");
		expect(disk.text("R/b.md")).toBe("");
		expect(disk.text("c.md")).toBe("a");
	});

	it("drops store entries on remove, rmdir and trash", async () => {
		const { store, adapter } = setup();
		await adapter.write("R/a.md", "a");
		await adapter.write("R/f/b.md", "b");
		await adapter.write("R/g/c.md", "c");
		await adapter.remove("R/a.md");
		await adapter.rmdir("R/f", true);
		await adapter.trashLocal("R/g");
		expect(store.entries.size).toBe(0);
	});

	it("serves resources as blob URLs once decrypted, and drops them on write and lock", async () => {
		const { stub, adapter, created, revoked, ready } = setup();
		await adapter.writeBinary("R/pic.png", new Uint8Array([1, 2, 3]).buffer);
		expect(adapter.getResourcePath("R/pic.png")).toBe("app://disk/R/pic.png");
		await new Promise((r) => setTimeout(r, 0));
		expect(ready).toEqual(["R/pic.png"]);
		expect(adapter.getResourcePath("R/pic.png")).toBe("blob:0");
		await adapter.writeBinary("R/pic.png", new Uint8Array([4]).buffer);
		expect(revoked).toEqual(["blob:0"]);
		expect(await stub.warm("R/pic.png")).toBe(true);
		stub.lock();
		expect(revoked).toEqual(["blob:0", "blob:1"]);
		expect(created).toHaveLength(2);
		expect(adapter.getResourcePath("plain.png")).toBe("app://disk/plain.png");
	});

	it("puts the original methods back on uninstall", async () => {
		const { disk, adapter, uninstall } = setup();
		uninstall();
		await adapter.write("R/a.md", "plain");
		expect(disk.text("R/a.md")).toBe("plain");
	});
});
