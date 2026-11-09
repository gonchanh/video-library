// Generated from baml_src/main.baml; regenerate with `baml generate` after schema edits.
// These pure BAML functions decode JSON locally; they do not invoke a model.
import {
  parseApprovalPlan_sync,
  parseJellyfinMetadata_sync,
  type ApprovalPlan,
  type JellyfinMetadata,
} from "../baml_sdk/index.js";

export type { ApprovalPlan, JellyfinMetadata };

export function parseApprovalPlan(raw: string): ApprovalPlan {
  return parseApprovalPlan_sync(raw);
}

export function parseJellyfinMetadata(raw: string): JellyfinMetadata {
  return parseJellyfinMetadata_sync(raw);
}
