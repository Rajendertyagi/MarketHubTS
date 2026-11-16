import { and, eq } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CredentialStore, CredentialStoreStatus, ProviderId } from "@markethub/contracts";
import { providerCredentials } from "./schema";
import type { DatabaseHandle } from "./index";

const FORMAT_VERSION = 1;
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_FILENAME = "markethub.key";

type Bytes = Uint8Array<ArrayBuffer>;

function utf8(value: string): Bytes {
  return new TextEncoder().encode(value) as Bytes;
}

function toBase64(bytes: Bytes): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Bytes {
  const binary = atob(value);
  const out = new Uint8Array(new ArrayBuffer(binary.length)) as Bytes;
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function aadFor(provider: ProviderId, name: string): Bytes {
  return utf8(`markethub:credential:v${FORMAT_VERSION}|${provider}|${name}`);
}

function randomBytes(length: number): Bytes {
  const out = new Uint8Array(new ArrayBuffer(length)) as Bytes;
  globalThis.crypto.getRandomValues(out);
  return out;
}

function validKey(bytes: Bytes): boolean {
  return bytes.length === KEY_BYTES && bytes.some((b) => b !== 0);
}

/** Resolve the key file beside the configured database, never from process.cwd(). */
export function resolveCredentialKeyPath(dbPath: string): string {
  return join(dirname(dbPath), KEY_FILENAME);
}

export class SqliteCredentialStore implements CredentialStore {
  private readonly keyPath: string;
  private key: Bytes | null = null;
  private statusValue: CredentialStoreStatus;

  constructor(private readonly handle: DatabaseHandle) {
    this.keyPath = resolveCredentialKeyPath(handle.path);
    this.statusValue = this.initialize();
  }

  private initialize(): CredentialStoreStatus {
    const rows = this.handle.db.select().from(providerCredentials).all();
    const hasRecords = rows.length > 0;

    if (existsSync(this.keyPath)) {
      let bytes: Bytes;
      try {
        bytes = new Uint8Array(new ArrayBuffer(readFileSync(this.keyPath).byteLength)) as Bytes;
        bytes.set(readFileSync(this.keyPath));
      } catch {
        return { state: "UNAVAILABLE", reason: "Credential key file could not be read", keyPath: this.keyPath };
      }
      if (!validKey(bytes)) {
        return { state: "UNAVAILABLE", reason: "Credential key file is corrupt (expected 32 random bytes)", keyPath: this.keyPath };
      }
      this.key = bytes;
      return { state: "AVAILABLE", keyPath: this.keyPath };
    }

    if (hasRecords) {
      // Never generate a replacement key when encrypted records already exist.
      return {
        state: "UNAVAILABLE",
        reason: "Encrypted credentials exist but the key file is missing. Credentials are unavailable; use the explicit reset/re-authentication path.",
        keyPath: this.keyPath
      };
    }

    // Genuinely new store: create the key atomically without overwriting an existing file.
    try {
      mkdirSync(dirname(this.keyPath), { recursive: true });
      const key = randomBytes(KEY_BYTES);
      writeFileSync(this.keyPath, key, { flag: "wx", mode: 0o600 });
      this.key = key;
      return { state: "AVAILABLE", keyPath: this.keyPath };
    } catch (error) {
      // Another process may have created it between the existsSync check and write.
      if (existsSync(this.keyPath)) {
        try {
          const raw = readFileSync(this.keyPath);
          const bytes = new Uint8Array(new ArrayBuffer(raw.byteLength)) as Bytes;
          bytes.set(raw);
          if (validKey(bytes)) {
            this.key = bytes;
            return { state: "AVAILABLE", keyPath: this.keyPath };
          }
        } catch {}
      }
      return {
        state: "UNAVAILABLE",
        reason: `Credential key file could not be created: ${error instanceof Error ? error.message : String(error)}`,
        keyPath: this.keyPath
      };
    }
  }

  status(): CredentialStoreStatus {
    return { ...this.statusValue };
  }

  private requireKey(): Bytes {
    if (!this.key) {
      throw new Error(`Credential store unavailable: ${this.statusValue.reason ?? "no key"}`);
    }
    return this.key;
  }

  private async importKey(key: Bytes): Promise<CryptoKey> {
    return globalThis.crypto.subtle.importKey("raw", key, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }

  async get(provider: ProviderId, name: string): Promise<string | null> {
    const key = this.requireKey();
    const row = this.handle.db
      .select()
      .from(providerCredentials)
      .where(and(eq(providerCredentials.provider, provider), eq(providerCredentials.name, name)))
      .get();
    if (!row) return null;
    if (row.formatVersion !== FORMAT_VERSION) {
      throw new Error("Unsupported encrypted credential format version");
    }
    const nonce = fromBase64(row.nonce);
    const tag = fromBase64(row.tag);
    const ciphertext = fromBase64(row.ciphertext);
    if (nonce.length !== NONCE_BYTES || tag.length !== TAG_BYTES || ciphertext.length === 0) {
      throw new Error("Invalid encrypted credential record");
    }
    const combined = new Uint8Array(new ArrayBuffer(ciphertext.length + tag.length)) as Bytes;
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);
    try {
      const cryptoKey = await this.importKey(key);
      const plain = await globalThis.crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aadFor(provider, name), tagLength: TAG_BYTES * 8 },
        cryptoKey,
        combined
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new Error("Encrypted credential could not be authenticated (wrong key, tampered record, or identity mismatch)");
    }
  }

  async set(provider: ProviderId, name: string, value: string): Promise<void> {
    if (!value || value.trim().length === 0) {
      throw new Error("Refusing to store an empty credential; existing value is preserved");
    }
    const key = this.requireKey();
    const nonce = randomBytes(NONCE_BYTES);
    const cryptoKey = await this.importKey(key);
    const encrypted = await globalThis.crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aadFor(provider, name), tagLength: TAG_BYTES * 8 },
      cryptoKey,
      utf8(value)
    );
    const encryptedBytes = new Uint8Array(encrypted);
    const ciphertext = encryptedBytes.slice(0, encryptedBytes.length - TAG_BYTES);
    const tag = encryptedBytes.slice(encryptedBytes.length - TAG_BYTES);
    const now = new Date().toISOString();
    // Single atomic upsert: a failed write cannot leave a half-updated credential.
    this.handle.db
      .insert(providerCredentials)
      .values({
        provider,
        name,
        formatVersion: FORMAT_VERSION,
        nonce: toBase64(nonce),
        ciphertext: toBase64(ciphertext),
        tag: toBase64(tag),
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: [providerCredentials.provider, providerCredentials.name],
        set: {
          formatVersion: FORMAT_VERSION,
          nonce: toBase64(nonce),
          ciphertext: toBase64(ciphertext),
          tag: toBase64(tag),
          updatedAt: now
        }
      })
      .run();
  }

  async delete(provider: ProviderId, name: string): Promise<void> {
    this.handle.db
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.provider, provider), eq(providerCredentials.name, name)))
      .run();
  }

  async reset(): Promise<void> {
    // Explicit destructive reset: discard unrecoverable credential rows and create a new key.
    this.handle.db.delete(providerCredentials).run();
    try {
      if (existsSync(this.keyPath)) unlinkSync(this.keyPath);
    } catch {}
    const key = randomBytes(KEY_BYTES);
    writeFileSync(this.keyPath, key, { flag: "wx", mode: 0o600 });
    this.key = key;
    this.statusValue = { state: "AVAILABLE", keyPath: this.keyPath };
  }
}
