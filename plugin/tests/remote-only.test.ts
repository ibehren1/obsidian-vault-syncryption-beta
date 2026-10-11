import { describe, expect, it } from "vitest";

import { complianceReport, duration, type ComplianceFacts } from "../src/remote/compliance";
import { RemoteStatFs } from "../src/remote/stat-fs";
import { MemoryEntryStore, StubAdapter } from "../src/remote/stub-adapter";
import { MemoryFs } from "../src/sync/fs";
import { isLocked } from "../src/api/http";
import { noBackend, uniqueName } from "./harness";
import { device, pairedDevice } from "./sync-fixture";

const NOW = 1_790_000_000_000;

function facts(over: Partial<ComplianceFacts> = {}): ComplianceFacts {
	return {
		keyringRemoteOnly: true,
		flag: { vaultId: "v1" },
		installed: true,
		locked: false,
		lease: { at: NOW - 3_600_000, graceSeconds: 86_400 },
		now: NOW,
		remoteFiles: 3,
		plaintext: [],
		storeEntries: 3,
		orphans: 0,
		missing: 0,
		fileRecovery: false,
		plainHashes: 0,
		...over,
	};
}

describe("compliance report", () => {
	it("passes a remote-only device that follows every rule", () => {
		const report = complianceReport(facts());
		expect(report).toMatchObject({ remoteOnly: true, source: "keyring", compliant: true });
		expect(report.checks.find((c) => c.name === "Lease")?.detail).toBe("Valid for 23 h.");
	});

	it("fails on plaintext on disk, File Recovery, plaintext hashes and an expired lease", () => {
		const paths = ["a.md", "b.md", "c.md", "d.md", "e.md", "f.md", "g.md"];
		const report = complianceReport(
			facts({ plaintext: paths, fileRecovery: true, plainHashes: 2, lease: { at: NOW - 90_000_000, graceSeconds: 86_400 } }),
		);
		expect(report.compliant).toBe(false);
		const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
		expect(failed).toEqual(["No plaintext on disk", "File Recovery core plugin", "Content hashes sealed", "Lease"]);
		expect(report.checks[2]!.detail).toBe("Not empty on disk: a.md, b.md, c.md, d.md, e.md and 2 more.");
	});

	it("counts a locked device's lease as kept", () => {
		const report = complianceReport(facts({ locked: true, lease: null, keyringRemoteOnly: null, plainHashes: null }));
		expect(report).toMatchObject({ source: "this device", compliant: true });
		expect(report.checks.map((c) => c.name)).not.toContain("Content hashes sealed");
	});

	it("reports a full device, and one still holding stubs", () => {
		expect(complianceReport(facts({ keyringRemoteOnly: false, flag: null }))).toMatchObject({ remoteOnly: false, compliant: true });
		expect(complianceReport(facts({ keyringRemoteOnly: false })).compliant).toBe(false);
	});

	it("formats durations", () => {
		expect(duration(90_000)).toBe("2 min");
		expect(duration(5_400_000)).toBe("1 h 30 min");
		expect(duration(-5)).toBe("0 min");
	});
});

describe("RemoteStatFs", () => {
	it("reports the stored size and times of remote-only files", async () => {
		const store = new MemoryEntryStore();
		await store.put("R/a.md", { nonce: new Uint8Array(24), data: new Uint8Array(1), size: 42, mtime: 7, ctime: 3 });
		const stub = new StubAdapter({ isRemote: (p) => p.startsWith("R/"), store });
		await stub.load();
		const inner = new MemoryFs();
		inner.set("R/a.md", "");
		inner.set("b.md", "plain");
		const fs = new RemoteStatFs(inner, () => stub);
		const listed = new Map((await fs.list()).map((f) => [f.path, f]));
		expect(listed.get("R/a.md")).toMatchObject({ size: 42, mtime: 7, ctime: 3 });
		expect(listed.get("b.md")).toMatchObject({ size: 5 });
		expect(await fs.stat("R/a.md")).toMatchObject({ size: 42 });
		expect(await new RemoteStatFs(inner, () => null).stat("R/a.md")).toMatchObject({ size: 0 });
	});
});

describe.skipIf(noBackend)("remote-only approval", () => {
	it("puts the policy in the keyring and the server refuses management", async () => {
		const username = uniqueName("remote");
		const vaultName = uniqueName("Vault ");
		const a = await device(username, vaultName, "Laptop");
		const b = await pairedDevice(a, username, vaultName, "Phone", undefined, { remoteOnly: true });
		expect(b.session.remoteOnly).toBe(true);
		expect(a.session.remoteOnly).toBe(false);
		expect(a.session.keyring.devices.map((d) => d.policy)).toEqual([undefined, "remote-only"]);
		await b.session.api.login();
		expect(b.session.api.lastLogin).toMatchObject({ remoteOnly: true });
		expect(b.session.api.lastLogin!.graceSeconds).toBeGreaterThan(0);

		// It syncs, but can't approve keys.
		a.fs.set("note.md", "hello\n");
		await a.engine.sync();
		await b.engine.sync();
		expect(b.fs.text("note.md")).toBe("hello\n");
		await expect(b.session.api.approveDevice(b.session.vault.id, a.session.deviceId)).rejects.toMatchObject({
			status: 403,
			code: "remote_only",
		});
	});
});

describe.skipIf(noBackend)("changing another device", () => {
	it("makes a device remote-only and back, and locks and unlocks it", async () => {
		const username = uniqueName("policy");
		const vaultName = uniqueName("Vault ");
		const a = await device(username, vaultName, "Laptop");
		const b = await pairedDevice(a, username, vaultName, "Phone");
		expect(b.session.remoteOnly).toBe(false);

		await a.session.setPolicy(b.session.deviceId, true);
		await b.session.refreshKeyring();
		expect(b.session.remoteOnly).toBe(true);
		await b.session.api.login();
		expect(b.session.api.lastLogin).toMatchObject({ remoteOnly: true });

		await a.session.setLocked(b.session.deviceId, true);
		const devices = await a.session.devices();
		expect(devices.find((d) => d.id === b.session.deviceId)).toMatchObject({ locked: true });
		const err = await b.session.api.login().catch((e: unknown) => e);
		expect(isLocked(err)).toBe(true);
		await a.session.setLocked(b.session.deviceId, false);
		await b.session.api.login();

		await a.session.setPolicy(b.session.deviceId, false);
		await b.session.refreshKeyring();
		expect(b.session.remoteOnly).toBe(false);
		await expect(a.session.setPolicy(a.session.deviceId, true)).rejects.toThrow();
	});
});
