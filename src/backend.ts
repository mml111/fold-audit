import type { Message } from "./engine.ts";
import type { FoldRecord } from "./spec.ts";

export interface Coverage {
  total: number;
  verbatim: number;
  folded: number;
  lost: number;
  doubleCounted: number;
}

export interface Backend {
  name: string;
  /** One agent step. The backend must call rec.record() with the exact prompt
   * it sends to the model, tagged with which model it is talking to. */
  turn(content: string): Promise<string>;
  coverage(): Coverage;
  /** Evidence for every fold: what it covered, what it cost, and how the removed
   * content stays reachable. This is what makes the report auditable rather than
   * a bundle of aggregate claims. */
  foldLedger(): FoldRecord[];
  /** The exact prompts this backend sent, with the prefix-cache accounting the
   *  recorder derived from them. Without this, "the cache was reused" is an
   *  unfalsifiable claim. */
  promptRecords(): { kind: string; tokens: number; cached: number; rePrefill: number }[];
  recall(query: string): string[];
  prompt(): Message[];
  folds(): number;
  reflections(): number;
  tokensSaved(): number;
  settled(): Promise<void>;
}
