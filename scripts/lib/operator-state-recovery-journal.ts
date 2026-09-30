/**
 * Source-only POSIX journal for a future private operator host. Its owner-private
 * local directory is the trust boundary; this module grants no recovery authority.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { stableStringify } from "../../core/adapters/source/digest.ts";
import {
  parseOperatorRecoveryJournalIntent,
  parseOperatorRecoveryJournalStaged,
  validOperatorRecoveryIdentifier,
  type OperatorRecoveryJournal,
  type OperatorRecoveryJournalIntent,
  type OperatorRecoveryJournalStaged,
} from "../../deploy/platform/operator_state_recovery.ts";

const MAX_RECORD_BYTES = 64 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700n;
const PRIVATE_FILE_MODE = 0o600n;
const REFUSAL = "operator SOURCE recovery journal refused; reconcile private evidence";
type Slot = "intent" | "staged";
type RecordFor<S extends Slot> = S extends "intent" ? OperatorRecoveryJournalIntent : OperatorRecoveryJournalStaged;
type Stat = Awaited<ReturnType<Awaited<ReturnType<typeof open>>["stat"]>>;

/** A narrowly scoped failure seam for portable crash tests. Never use in an operator host. */
export type OperatorRecoveryJournalStep =
  | `${Slot}.before-file-sync` | `${Slot}.after-file-sync`
  | `${Slot}.before-link` | `${Slot}.after-link`
  | `${Slot}.before-unlink` | `${Slot}.after-unlink`
  | `${Slot}.before-dir-sync` | `${Slot}.after-dir-sync`
  | `${Slot}.before-readback`;

/**
 * The future private host must durably provision the root and any newly
 * created ancestor directory entries before the first intent, including
 * syncing their required parent directories and qualifying the actual local
 * filesystem/device. This adapter neither creates the root nor syncs its
 * parent chain; syncing the pinned root FD covers only entries inside it.
 * Portable fault tests do not establish power-loss survival of the root name.
 * On restart the host must compare a durable private root anchor/inventory;
 * opening this factory cannot distinguish an expected empty root from a new
 * empty root. A missing or replaced root must stop recovery, never mint a new
 * retry identity. Unsupported/unqualified file or directory fsync forbids use.
 */
export interface OpenOperatorStateRecoveryJournalOptions {
  readonly directory: string;
  readonly sourceCheckouts: readonly string[];
  readonly testOnlyFault?: (step: OperatorRecoveryJournalStep) => void | Promise<void>;
}

export interface OpenOperatorStateRecoveryJournal extends OperatorRecoveryJournal {
  close(): Promise<void>;
}

function refuse(): never { throw new Error(REFUSAL); }
function sameIdentity(left: Stat, right: Stat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function validDirectory(info: Stat, uid: bigint): boolean {
  return info.isDirectory() && !info.isSymbolicLink() && info.uid === uid &&
    (info.mode & 0o777n) === PRIVATE_DIRECTORY_MODE;
}
function validFile(info: Stat, uid: bigint): boolean {
  return info.isFile() && !info.isSymbolicLink() && info.uid === uid &&
    (info.mode & 0o777n) === PRIVATE_FILE_MODE && info.nlink >= 1n && info.nlink <= 2n &&
    info.size > 0n && info.size <= BigInt(MAX_RECORD_BYTES);
}
function contained(root: string, target: string): boolean {
  const part = relative(root, target);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}
async function statOrMissing(path: string): Promise<Stat | undefined> {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function assertDirectoryLocation(directory: string, sourceCheckouts: readonly string[]): Promise<void> {
  if (!isAbsolute(directory) || sourceCheckouts.length === 0 ||
    sourceCheckouts.some((root) => !isAbsolute(root))) refuse();
  const absolute = resolve(directory);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current, { bigint: true });
    if (!info.isDirectory() || info.isSymbolicLink() || basename(current) === ".git" ||
      await statOrMissing(join(current, ".git"))) refuse();
  }
  const physical = await realpath(absolute);
  for (const root of sourceCheckouts) {
    const physicalRoot = await realpath(resolve(root));
    if (contained(physicalRoot, physical)) refuse();
  }
}

function keyFor(failedApplyRunId: string): string {
  if (!validOperatorRecoveryIdentifier(failedApplyRunId)) refuse();
  return createHash("sha256").update("takosumi.operator-source-recovery-journal-key@v1\0")
    .update(failedApplyRunId, "utf8").digest("hex");
}
function slotName(key: string, slot: Slot): string { return `journal-v1-${key}.${slot}.json`; }
function temporaryPrefix(key: string, slot: Slot): string { return `.${slotName(key, slot)}.`; }
function parseRecord<S extends Slot>(slot: S, value: unknown): RecordFor<S> {
  return (slot === "intent" ? parseOperatorRecoveryJournalIntent(value) :
    parseOperatorRecoveryJournalStaged(value)) as RecordFor<S>;
}
function recordId(slot: Slot, value: OperatorRecoveryJournalIntent | OperatorRecoveryJournalStaged): string {
  return slot === "intent" ? (value as OperatorRecoveryJournalIntent).failedApplyRunId :
    (value as OperatorRecoveryJournalStaged).intent.failedApplyRunId;
}

export async function openOperatorStateRecoveryJournal(
  options: OpenOperatorStateRecoveryJournalOptions,
): Promise<OpenOperatorStateRecoveryJournal> {
  try {
    const requestedDirectory = options.directory;
    const sourceCheckouts = Object.freeze([...options.sourceCheckouts]);
    const testOnlyFault = options.testOnlyFault;
    const directory = resolve(requestedDirectory);
    await assertDirectoryLocation(requestedDirectory, sourceCheckouts);
    const owner = process.getuid?.();
    if (owner === undefined) refuse();
    const uid = BigInt(owner);
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const pinned = await directoryHandle.stat({ bigint: true });
      const pathInfo = await lstat(directory, { bigint: true });
      if (!validDirectory(pinned, uid) || !validDirectory(pathInfo, uid) || !sameIdentity(pinned, pathInfo)) refuse();
      let closed = false;
      async function guard(): Promise<void> {
        if (closed) refuse();
        await assertDirectoryLocation(directory, sourceCheckouts);
        const [handleInfo, current] = await Promise.all([
          directoryHandle.stat({ bigint: true }), lstat(directory, { bigint: true }),
        ]);
        if (!validDirectory(handleInfo, uid) || !validDirectory(current, uid) ||
          !sameIdentity(pinned, handleInfo) || !sameIdentity(pinned, current)) refuse();
      }
      async function step(value: OperatorRecoveryJournalStep): Promise<void> {
        await testOnlyFault?.(value);
        await guard();
      }
      async function syncDirectory(slot: Slot): Promise<void> {
        await step(`${slot}.before-dir-sync`);
        await directoryHandle.sync();
        await step(`${slot}.after-dir-sync`);
      }
      async function temporaryNames(key: string, slot: Slot): Promise<string[]> {
        await guard();
        const prefix = temporaryPrefix(key, slot);
        const names = (await readdir(directory)).filter((name) => name.startsWith(prefix));
        if (names.length > 64 || names.some((name) =>
          !/^\.[a-z0-9.-]+\.[0-9a-f]{48}\.tmp$/u.test(name))) refuse();
        await guard();
        return names;
      }
      async function checkedFile(path: string, expected?: Stat): Promise<{ info: Stat; bytes: Buffer }> {
        await guard();
        const before = await lstat(path, { bigint: true });
        if (!validFile(before, uid) || (expected && !sameIdentity(expected, before))) refuse();
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat({ bigint: true });
          if (!validFile(opened, uid) || !sameIdentity(before, opened)) refuse();
          const bytes = Buffer.allocUnsafe(MAX_RECORD_BYTES + 1);
          let length = 0;
          while (length < bytes.length) {
            const result = await handle.read(bytes, length, bytes.length - length, length);
            if (result.bytesRead === 0) break;
            length += result.bytesRead;
          }
          if (length > MAX_RECORD_BYTES || length !== Number(opened.size)) refuse();
          const [afterFd, afterPath] = await Promise.all([
            handle.stat({ bigint: true }), lstat(path, { bigint: true }),
          ]);
          if (!validFile(afterFd, uid) || !validFile(afterPath, uid) ||
            !sameIdentity(opened, afterFd) || !sameIdentity(opened, afterPath) ||
            afterFd.size !== opened.size || afterPath.size !== opened.size ||
            afterFd.nlink !== opened.nlink || afterPath.nlink !== opened.nlink ||
            afterFd.mtimeNs !== opened.mtimeNs || afterPath.mtimeNs !== opened.mtimeNs ||
            afterFd.ctimeNs !== opened.ctimeNs || afterPath.ctimeNs !== opened.ctimeNs) refuse();
          await guard();
          return { info: opened, bytes: bytes.subarray(0, length) };
        } finally { await handle.close(); }
      }
      async function decode<S extends Slot>(slot: S, bytes: Buffer, id: string): Promise<RecordFor<S>> {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        const value = parseRecord(slot, JSON.parse(text));
        if (text !== `${stableStringify(value)}\n` || recordId(slot, value) !== id) refuse();
        return value;
      }
      async function readSlot<S extends Slot>(slot: S, id: string): Promise<RecordFor<S> | undefined> {
        const key = keyFor(id);
        const final = join(directory, slotName(key, slot));
        await guard();
        const observed = await statOrMissing(final);
        if (!observed) {
          if (slot === "intent" && (await temporaryNames(key, slot)).length > 0) refuse();
          await guard();
          return undefined;
        }
        const checked = await checkedFile(final, observed);
        const value = await decode(slot, checked.bytes, id);
        if (checked.info.nlink === 2n) {
          const names = await temporaryNames(key, slot);
          if (names.length !== 1) refuse();
          const temporary = join(directory, names[0]!);
          const temp = await checkedFile(temporary, checked.info);
          if (!sameIdentity(checked.info, temp.info) ||
            !temp.bytes.equals(checked.bytes)) refuse();
          // A linked final may have lost its publish acknowledgement. Persist
          // the directory entry before dropping the only matching temp link.
          await syncDirectory(slot);
          await step(`${slot}.before-unlink`);
          await unlink(temporary);
          await step(`${slot}.after-unlink`);
          await syncDirectory(slot);
          const after = await checkedFile(final, checked.info);
          if (after.info.nlink !== 1n || !after.bytes.equals(checked.bytes)) refuse();
        }
        if (slot === "intent" && (await temporaryNames(key, slot)).length > 0) refuse();
        // A lost unlink acknowledgement can leave the cleanup unsynced.
        // Sync a single-link final before treating it as fully reconciled.
        await syncDirectory(slot);
        await guard();
        return value;
      }
      async function stagedFinalExists(id: string): Promise<boolean> {
        await guard();
        const path = join(directory, slotName(keyFor(id), "staged"));
        const found = await statOrMissing(path);
        await guard();
        return found !== undefined;
      }
      async function publish<S extends Slot>(slot: S, value: RecordFor<S>): Promise<RecordFor<S>> {
        const id = recordId(slot, value);
        const key = keyFor(id);
        const final = join(directory, slotName(key, slot));
        const existing = await readSlot(slot, id);
        if (existing) {
          if (stableStringify(existing) !== stableStringify(value)) refuse();
          return existing;
        }
        const encoded = Buffer.from(`${stableStringify(value)}\n`, "utf8");
        if (encoded.length === 0 || encoded.length > MAX_RECORD_BYTES) refuse();
        const temp = join(directory, `${temporaryPrefix(key, slot)}${randomBytes(24).toString("hex")}.tmp`);
        await guard();
        const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        let tempIdentity: Stat;
        try {
          tempIdentity = await handle.stat({ bigint: true });
          if (!tempIdentity.isFile() || tempIdentity.uid !== uid ||
            (tempIdentity.mode & 0o777n) !== PRIVATE_FILE_MODE ||
            tempIdentity.nlink !== 1n || tempIdentity.size !== 0n) refuse();
          let offset = 0;
          while (offset < encoded.length) {
            const result = await handle.write(encoded, offset, encoded.length - offset, offset);
            if (result.bytesWritten <= 0) refuse();
            offset += result.bytesWritten;
          }
          await step(`${slot}.before-file-sync`);
          await handle.sync();
          await step(`${slot}.after-file-sync`);
        } finally { await handle.close(); }
        await guard();
        const written = await checkedFile(temp, tempIdentity);
        if (!written.bytes.equals(encoded) || written.info.nlink !== 1n) refuse();
        await step(`${slot}.before-link`);
        try { await link(temp, final); }
        catch (error) {
          if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
          const own = await checkedFile(temp, tempIdentity);
          if (own.info.nlink !== 1n || !own.bytes.equals(encoded)) refuse();
          await step(`${slot}.before-unlink`);
          await unlink(temp);
          await step(`${slot}.after-unlink`);
          await syncDirectory(slot);
          const winner = await readSlot(slot, id);
          if (!winner || stableStringify(winner) !== stableStringify(value)) refuse();
          return winner;
        }
        await step(`${slot}.after-link`);
        await syncDirectory(slot);
        await step(`${slot}.before-unlink`);
        const linked = await checkedFile(temp, tempIdentity);
        if (linked.info.nlink !== 2n || !linked.bytes.equals(encoded)) refuse();
        await unlink(temp);
        await step(`${slot}.after-unlink`);
        await syncDirectory(slot);
        await step(`${slot}.before-readback`);
        const committed = await readSlot(slot, id);
        if (!committed || stableStringify(committed) !== stableStringify(value)) refuse();
        return committed;
      }
      const api: OpenOperatorStateRecoveryJournal = {
        async read(id) {
          try {
            await guard();
            const intent = await readSlot("intent", id);
            if (!intent) {
              if (await stagedFinalExists(id)) refuse();
              return undefined;
            }
            const staged = await readSlot("staged", id);
            if (staged && stableStringify(staged.intent) !== stableStringify(intent)) refuse();
            await guard();
            return Object.freeze({ intent, ...(staged ? { staged } : {}) });
          } catch { return refuse(); }
        },
        async putIntentIfAbsent(input) {
          try {
            const value = parseOperatorRecoveryJournalIntent(input);
            // A pre-existing staged final without its durable intent is an
            // orphan, not evidence from which a new intent may be minted.
            const existingIntent = await readSlot("intent", value.failedApplyRunId);
            if (await stagedFinalExists(value.failedApplyRunId)) {
              if (!existingIntent) refuse();
              const existingStaged = await readSlot("staged", value.failedApplyRunId);
              if (!existingStaged || stableStringify(existingStaged.intent) !== stableStringify(existingIntent)) refuse();
            }
            return await publish("intent", value);
          } catch { return refuse(); }
        },
        async putStagedIfAbsent(input) {
          try {
            const value = parseOperatorRecoveryJournalStaged(input);
            const intent = await readSlot("intent", value.intent.failedApplyRunId);
            if (!intent || stableStringify(intent) !== stableStringify(value.intent)) refuse();
            return await publish("staged", value);
          } catch { return refuse(); }
        },
        async close() {
          if (closed) return;
          closed = true;
          try { await directoryHandle.close(); }
          catch { return refuse(); }
        },
      };
      return api;
    } catch (error) {
      await directoryHandle.close().catch(() => undefined);
      throw error;
    }
  } catch { return refuse(); }
}
