import * as opentelemetry from "@opentelemetry/api";
import type { IncomingHttpHeaders } from "http";
import { env } from "../env";
import {
  ANALYTICS_QUERY_TAG_BAGGAGE_KEYS,
  type AnalyticsQuerySurface,
} from "./analytics-client/queryTags";
import { extractPublicApiCallerAttribution } from "./ingestion/ingestionAttribution";
import { redactLangfuseSecretKeys } from "./auth/apiKeys";

export type LangfuseContextProps = {
  headers?: IncomingHttpHeaders;
  userId?: string;
  projectId?: string;
  apiKeyId?: string;
  analytics?: {
    surface: AnalyticsQuerySurface;
    route?: string;
  };
};

/**
 * Returns a new context containing baggage entries composed from
 * the supplied props (headers, userId, projectId). Existing baggage
 * entries are preserved.
 */
export const contextWithLangfuseProps = (
  props: LangfuseContextProps,
): opentelemetry.Context => {
  const ctx = opentelemetry.context.active();
  let baggage =
    opentelemetry.propagation.getBaggage(ctx) ??
    opentelemetry.propagation.createBaggage();

  if (props.analytics?.surface === "publicapi") {
    [
      ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.sdkName,
      ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.sdkVersion,
      ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.userAgent,
    ].forEach((key) => {
      baggage = baggage.removeEntry(key);
    });
  }

  if (props.headers) {
    (env.LANGFUSE_LOG_PROPAGATED_HEADERS as string[]).forEach((name) => {
      const value = props.headers![name];
      if (!value) return;
      const strValue = redactLangfuseSecretKeys(
        Array.isArray(value) ? JSON.stringify(value) : value,
      );
      baggage = baggage.setEntry(`langfuse.header.${name}`, {
        value: strValue,
      });
    });

    // get x-langfuse-xxx headers and add them to the span
    Object.keys(props.headers).forEach((name) => {
      if (
        name.toLowerCase().startsWith("x-langfuse") ||
        name.toLowerCase().startsWith("x_langfuse")
      ) {
        const value = props.headers![name];
        if (!value) return;
        const strValue = redactLangfuseSecretKeys(
          Array.isArray(value) ? JSON.stringify(value) : value,
        );
        baggage = baggage.setEntry(`langfuse.header.${name}`, {
          value: strValue,
        });
      }
    });

    if (props.analytics?.surface === "publicapi") {
      const callerAttribution = extractPublicApiCallerAttribution(
        props.headers,
      );
      if (callerAttribution.sdkName) {
        baggage = baggage.setEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.sdkName, {
          value: callerAttribution.sdkName,
        });
      }
      if (callerAttribution.sdkVersion) {
        baggage = baggage.setEntry(
          ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.sdkVersion,
          { value: callerAttribution.sdkVersion },
        );
      }
      if (callerAttribution.userAgent) {
        baggage = baggage.setEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.userAgent, {
          value: callerAttribution.userAgent,
        });
      }
    }
  }
  if (props.userId) {
    baggage = baggage.setEntry("langfuse.user.id", { value: props.userId });
  }
  if (props.projectId) {
    baggage = baggage.setEntry("langfuse.project.id", {
      value: props.projectId,
    });
  }
  if (props.apiKeyId) {
    baggage = baggage.setEntry("langfuse.api_key.id", {
      value: props.apiKeyId,
    });
  }
  if (props.analytics) {
    baggage = baggage.setEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.surface, {
      value: props.analytics.surface,
    });
    if (props.analytics.route?.trim()) {
      baggage = baggage.setEntry(ANALYTICS_QUERY_TAG_BAGGAGE_KEYS.route, {
        value: props.analytics.route,
      });
    }
  }

  return opentelemetry.propagation.setBaggage(ctx, baggage);
};
