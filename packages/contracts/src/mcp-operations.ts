import { z } from "zod";

/** Registration group an MCP operation belongs to. */
export const mcpOperationTypeSchema = z.enum(["tool", "resource", "prompt"]);
export type McpOperationType = z.infer<typeof mcpOperationTypeSchema>;

const operationName = z.string().min(1).max(200);
const operationTitle = z.string().min(1).max(200);
const operationDescription = z.string().min(1).max(1000);

/**
 * Safe, user-facing descriptor for one registered MCP operation.
 *
 * Strict discriminated union on `type`: tools carry no `title` key (they have
 * none today), while resources and prompts must carry a `title`. Unknown keys
 * are rejected so no SDK schema, annotation, argument or handler detail can
 * leak through this contract.
 */
export const mcpOperationDescriptorSchema = z.discriminatedUnion("type", [
  z.object({
    name: operationName,
    type: z.literal("tool"),
    description: operationDescription
  }).strict(),
  z.object({
    name: operationName,
    type: z.literal("resource"),
    title: operationTitle,
    description: operationDescription
  }).strict(),
  z.object({
    name: operationName,
    type: z.literal("prompt"),
    title: operationTitle,
    description: operationDescription
  }).strict()
]);
export type McpOperationDescriptor = z.infer<typeof mcpOperationDescriptorSchema>;

/** Bounded read-only response envelope for the operation catalogue. */
export const mcpOperationListSchema = z.object({
  operations: z.array(mcpOperationDescriptorSchema).max(100)
}).strict();
export type McpOperationList = z.infer<typeof mcpOperationListSchema>;
