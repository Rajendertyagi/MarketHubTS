/**
 * G0-A — typed, validated IPC contract for the catalog-refresh child process.
 *
 * This module is internal to `apps/api`. It deliberately carries only small
 * primitive/string messages: no credentials, no parsed rows, no large object
 * graphs and no live objects (AbortSignal/Response) can cross the channel.
 * Every inbound message is `safeParse`d by the receiver; unknown or malformed
 * messages are protocol errors, never silently trusted.
 *
 * The message set follows docs/G0_CHILD_PROCESS_ARCHITECTURE_PLAN.md §5.2.
 * G0-A implements only the `refresh`/`ping`/`shutdown` → `ready`/`pong`/`exit`
 * handshake; the remaining messages are declared here so later packages can
 * extend behaviour without a second contract.
 */
import { z } from "zod";
import { providerIdSchema } from "@markethub/contracts";

/** Hard bound on any single IPC message (bytes, JSON encoded). */
export const MAX_IPC_MESSAGE_BYTES = 4096;

const runId = z.string().min(1).max(128);
const dbPath = z.string().min(1).max(1024);
const boundedText = z.string().max(300);

/* -------------------------------------------------------------------------- */
/* Parent -> child                                                            */
/* -------------------------------------------------------------------------- */

export const refreshMessageSchema = z.object({
  type: z.literal("refresh"),
  runId,
  provider: providerIdSchema,
  dbPath,
  nowIso: z.string().min(1).max(64),
  intentKey: z.string().max(256),
  generation: z.number().int().nonnegative()
});

export const cancelMessageSchema = z.object({
  type: z.literal("cancel"),
  runId,
  reason: boundedText
});

export const pingMessageSchema = z.object({
  type: z.literal("ping"),
  runId
});

export const shutdownMessageSchema = z.object({
  type: z.literal("shutdown"),
  runId
});

export const txnGrantedMessageSchema = z.object({
  type: z.literal("txn-granted"),
  runId,
  generation: z.number().int().nonnegative()
});

export const txnRefusedMessageSchema = z.object({
  type: z.literal("txn-refused"),
  runId,
  reason: boundedText
});

export const parentMessageSchema = z.discriminatedUnion("type", [
  refreshMessageSchema,
  cancelMessageSchema,
  pingMessageSchema,
  shutdownMessageSchema,
  txnGrantedMessageSchema,
  txnRefusedMessageSchema
]);

export type ParentMessage = z.infer<typeof parentMessageSchema>;
export type RefreshMessage = z.infer<typeof refreshMessageSchema>;

/* -------------------------------------------------------------------------- */
/* Child -> parent                                                            */
/* -------------------------------------------------------------------------- */

export const readyMessageSchema = z.object({
  type: z.literal("ready"),
  runId,
  pid: z.number().int().positive(),
  /** Resolved absolute path reported by the child's own DatabaseHandle. */
  dbPath,
  /** `PRAGMA journal_mode` read from the child's own connection. */
  journalMode: z.string().min(1).max(32),
  /** `SELECT sqlite_version()` from the child's own connection. */
  sqliteVersion: z.string().min(1).max(32)
});

export const pongMessageSchema = z.object({
  type: z.literal("pong"),
  runId
});

export const progressMessageSchema = z.object({
  type: z.literal("progress"),
  runId,
  phase: z.enum(["INIT", "DOWNLOAD", "PARSE", "VALIDATE", "AWAIT_TXN_GRANT", "TXN", "SETTLED"]),
  detail: boundedText.optional()
});

export const txnStartingMessageSchema = z.object({
  type: z.literal("txn-starting"),
  runId
});

export const txnSettledMessageSchema = z.object({
  type: z.literal("txn-settled"),
  runId,
  outcome: z.enum(["COMMITTED", "ROLLED_BACK", "FAILED", "FENCED"]),
  /** G0-D: generation the child validated in-transaction (observability). */
  generation: z.number().int().nonnegative().optional()
});

export const resultMessageSchema = z.object({
  type: z.literal("result"),
  runId,
  status: z.string().min(1).max(64),
  counts: z.record(z.string(), z.number()),
  sourceVersion: z.string().max(64).optional(),
  conflicts: z.array(boundedText).max(64).optional(),
  error: boundedText.optional(),
  /** G0-D: generation that produced this result (FENCED diagnostics). */
  generation: z.number().int().nonnegative().optional()
});

export const cancelledMessageSchema = z.object({
  type: z.literal("cancelled"),
  runId,
  reason: boundedText
});

export const errorMessageSchema = z.object({
  type: z.literal("error"),
  runId,
  code: z.string().min(1).max(64),
  message: boundedText
});

export const childMessageSchema = z.discriminatedUnion("type", [
  readyMessageSchema,
  pongMessageSchema,
  progressMessageSchema,
  txnStartingMessageSchema,
  txnSettledMessageSchema,
  resultMessageSchema,
  cancelledMessageSchema,
  errorMessageSchema
]);

export type ChildMessage = z.infer<typeof childMessageSchema>;
export type ReadyMessage = z.infer<typeof readyMessageSchema>;

/* -------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* -------------------------------------------------------------------------- */

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

/** JSON byte length of a message; Infinity for anything non-serialisable. */
export function ipcMessageByteLength(message: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(message)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function isIpcMessageWithinLimit(message: unknown): boolean {
  return ipcMessageByteLength(message) <= MAX_IPC_MESSAGE_BYTES;
}

export function parseParentMessage(raw: unknown): ParseResult<ParentMessage> {
  const parsed = parentMessageSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, error: `invalid parent message: ${parsed.error.message}` };
}

export function parseChildMessage(raw: unknown): ParseResult<ChildMessage> {
  const parsed = childMessageSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, message: parsed.data }
    : { ok: false, error: `invalid child message: ${parsed.error.message}` };
}
