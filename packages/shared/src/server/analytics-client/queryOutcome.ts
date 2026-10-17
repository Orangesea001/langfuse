/**
 * Query outcome tracking — now a no-op stub.
 * Preserved for compatibility with callers.
 */
import { recordIncrement } from "../instrumentation";

/** No-op: query outcome tracking not applicable to MySQL */
export const recordQueryOutcome = (_opts: {
  outcome: string;
  surface?: string;
  route?: string;
}) => {
  // MySQL does not need query outcome tracking
};
